/**
 * Privilégio — ADR 0034.
 *
 * A suíte `tenant-isolation-financeiro.spec.ts` pergunta se o tenant 1 alcança
 * o tenant 2. Este spec pergunta outra coisa, que nenhum teste perguntava: **o
 * que dá para fazer SEM ser ninguém, e o que um membro qualquer consegue fazer
 * além do seu papel?**
 *
 * Começou no dinheiro e cresceu: a mesma varredura achou escalação para
 * administrador da plataforma. Os dois vivem aqui porque a causa é comum —
 * permissão concedida por omissão, e guarda que não guarda.
 *
 * A pergunta não era acadêmica. Antes desta ADR, com a chave anônima — a que
 * viaja no bundle do navegador de toda página publicada — e mais nada:
 *
 *     POST /rest/v1/rpc/post_financial_transaction
 *     { "p_tenant_id": "<qualquer empresa>", ... }
 *     → HTTP 200, lançamento de R$ 999.999,00 no razão daquela empresa
 *
 * A causa era um `ALTER DEFAULT PRIVILEGES ... GRANT ALL ... TO anon` de
 * 2026-06-27: toda função criada depois nascia concedida a `anon`. As demais
 * funções de dinheiro escaparam porque conferem o tenant por dentro e o
 * conjunto de tenants do `anon` é vazio; `post_financial_transaction` recebia
 * `p_tenant_id` como parâmetro e não perguntava nada a ninguém.
 *
 * Estes testes são o alarme para a reincidência. Nenhum portão anterior via
 * isso: typecheck, unit e E2E de tela passavam com o buraco aberto — é a mesma
 * lição de que os portões não enxergam o banco.
 */

import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { getSupabase, getSupabaseAdmin, getTestTenantId } from './helpers'

const admin = () => getSupabaseAdmin()

/** Cliente sem login: exatamente o que qualquer visitante consegue montar. */
function anonimo() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY não definidos')
  return createClient(url, key, { auth: { persistSession: false } })
}

/** Perna dupla e balanceada: sem isto o `trg_entries_balanced` recusaria por outro motivo. */
const PERNAS_BALANCEADAS = [
  { account_code: 'caixa_e_bancos', direction: 'debit', amount: 999999 },
  { account_code: 'contas_a_receber', direction: 'credit', amount: 999999 },
]

test.describe('Razão fora do alcance de quem não está logado (ADR 0034)', () => {
  test('anon não lança no razão — o exploit que existiu', async () => {
    const tenantId = await getTestTenantId()

    const { data, error } = await anonimo().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'payment_received',
        description: 'REGRESSÃO ADR 0034',
        source_module: 'regressao_adr34',
      },
      p_entries: PERNAS_BALANCEADAS,
    })

    expect(data ?? null, 'anon criou uma transação no razão').toBeNull()
    expect(error, 'anon deveria ser recusado ao lançar no razão').not.toBeNull()
    expect(error!.code, `recusa por privilégio esperada, veio: ${error!.message}`).toBe('42501')

    // A asserção que mais importa: nada persistiu. Um erro devolvido depois de
    // a escrita acontecer não valeria nada.
    const { count } = await admin()
      .from('financial_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('source_module', 'regressao_adr34')

    expect(count ?? 0, 'o lançamento forjado por anon persistiu').toBe(0)
  })

  test('anon não lê credencial de gateway', async () => {
    const { data, error } = await anonimo().rpc('fn_provider_credentials', {
      p_account_id: '00000000-0000-0000-0000-000000000001',
    })

    expect(data ?? null).toBeNull()
    expect(error, 'anon deveria ser recusado ao ler credencial').not.toBeNull()
    expect(error!.code).toBe('42501')
  })
})

test.describe('O que um membro logado NÃO escreve (ADR 0034)', () => {
  test('não insere lançamento direto no razão — a escrita passa pela RPC', async () => {
    const sb = await getSupabase()
    const tenantId = await getTestTenantId()

    // `post_financial_transaction` é SECURITY DEFINER desde sempre, então o
    // GRANT de INSERT nestas tabelas era desnecessário — e permitia forjar
    // lançamento escolhendo `created_by`, `event_type` e `source_module`.
    const { error } = await sb.from('financial_transactions').insert({
      tenant_id: tenantId,
      event_type: 'payment_received',
      occurred_at: new Date().toISOString(),
      description: 'REGRESSÃO ADR 0034 — insert direto',
      source_module: 'regressao_adr34_direto',
    })

    expect(error, 'INSERT direto no razão deveria ser recusado').not.toBeNull()
  })

  test('não escreve em payment_intents — some o elo entre dinheiro e tentativa', async () => {
    const sb = await getSupabase()
    const tenantId = await getTestTenantId()

    // DELETE é o que dói: `payments.payment_intent_id` é ON DELETE SET NULL,
    // então apagar a tentativa corta a ligação com o recebimento que ela
    // originou — o histórico que o ON DELETE RESTRICT existe para preservar.
    const { error: erroUpdate } = await sb
      .from('payment_intents')
      .update({ status: 'paid' })
      .eq('tenant_id', tenantId)

    expect(erroUpdate, 'UPDATE direto em payment_intents deveria ser recusado').not.toBeNull()

    const { error: erroDelete } = await sb
      .from('payment_intents')
      .delete()
      .eq('tenant_id', tenantId)

    expect(erroDelete, 'DELETE direto em payment_intents deveria ser recusado').not.toBeNull()
  })
})

test.describe('Estorno não se marca sem estorno no razão (ADR 0034)', () => {
  test('reversed_at direto é recusado; fn_reverse_payment continua funcionando', async () => {
    const tenantId = await getTestTenantId()

    const { data: customer } = await admin()
      .from('customers').select('id').eq('tenant_id', tenantId).limit(1).single()
    const customerId = (customer as { id: string }).id

    // Pagamento avulso, sem alocação: basta para exercer a trava do gatilho, e
    // não mexe em saldo de cobrança nenhuma.
    const { data: pagamento, error: erroPagamento } = await admin()
      .from('payments')
      .insert({
        tenant_id: tenantId, customer_id: customerId, amount: 1,
        method: 'pix', paid_at: new Date().toISOString(),
        notes: 'REGRESSÃO ADR 0034',
      })
      .select('id').single()

    expect(erroPagamento, erroPagamento?.message).toBeNull()
    const paymentId = (pagamento as { id: string }).id

    // Sem esta trava, isto reabria a cobrança em `charge_balances` (que filtra
    // por `reversed_at IS NULL`) enquanto o razão seguia mostrando o dinheiro
    // em caixa. Divergência permanente, sem estorno e sem rastro.
    const { error } = await admin()
      .from('payments')
      .update({ reversed_at: new Date().toISOString(), reversal_reason: 'burlando' })
      .eq('id', paymentId)

    expect(error, 'marcar reversed_at sem estorno no razão deveria ser recusado').not.toBeNull()

    const { data: intacto } = await admin()
      .from('payments').select('reversed_at').eq('id', paymentId).single()
    expect((intacto as { reversed_at: string | null }).reversed_at).toBeNull()

    await admin().from('payments').delete().eq('id', paymentId)
  })
})

test.describe('Guarda de papel que NULL não desliga (ADR 0034, Fase 2c)', () => {
  /**
   * As três funções de administração da plataforma guardavam com
   * `IF get_platform_role() <> 'owner' THEN RAISE`.
   *
   * `get_platform_role()` devolve NULL para quem não é admin — e
   * `NULL <> 'owner'` é NULL, não TRUE. `IF NULL THEN` não executa: a guarda
   * era pulada exatamente para quem ela existe para barrar.
   *
   * Reproduzido antes da correção: um `operator` comum de tenant promoveu uma
   * segunda conta sua a `platform_admin` OWNER — que enxerga todos os tenants.
   * O que segurou os outros dois caminhos foi acidente (a regra "precisa de ao
   * menos um owner" e o `actor_id NOT NULL` do log de auditoria).
   *
   * A correção é `IS DISTINCT FROM`, NULL-safe, que o resto do schema já usava.
   */
  test('usuário logado comum não administra a plataforma', async () => {
    const sb = await getSupabase()

    // O usuário de teste é membro de tenant e NÃO é admin de plataforma.
    const { data: papel } = await sb.rpc('get_platform_role')
    expect(papel ?? null, 'o usuário de teste virou admin de plataforma — refaça a fixture').toBeNull()

    const { data: alvo } = await admin()
      .from('platform_admins').select('user_id').limit(1).maybeSingle()

    const { error: erroAdd } = await sb.rpc('add_platform_admin_by_email', {
      p_email: 'ninguem-adr34@teste.com', p_role: 'owner',
    })
    expect(erroAdd, 'promover admin de plataforma deveria ser recusado').not.toBeNull()
    expect(erroAdd!.code, `esperado 42501, veio: ${erroAdd!.message}`).toBe('42501')

    if (alvo) {
      const alvoId = (alvo as { user_id: string }).user_id

      const { error: erroRemove } = await sb.rpc('remove_platform_admin', { p_user_id: alvoId })
      expect(erroRemove, 'remover admin de plataforma deveria ser recusado').not.toBeNull()
      expect(erroRemove!.code).toBe('42501')

      const { error: erroRole } = await sb.rpc('set_platform_admin_role', {
        p_user_id: alvoId, p_role: 'operator',
      })
      expect(erroRole, 'alterar papel de admin deveria ser recusado').not.toBeNull()
      expect(erroRole!.code).toBe('42501')
    }

    // E o admin legítimo continua lá: a guarda barra, não quebra.
    const { count } = await admin()
      .from('platform_admins').select('user_id', { count: 'exact', head: true })
    expect(count ?? 0, 'a correção não pode remover admins existentes').toBeGreaterThan(0)
  })

  test('anon não alcança rotina nenhuma do schema public', async () => {
    // A Fase 2b revogou o grant DIRETO de anon; faltava o segundo caminho, o
    // default do PostgreSQL (`CREATE FUNCTION` concede EXECUTE a PUBLIC, e anon
    // é membro de PUBLIC). Uma amostra de domínios diferentes basta como
    // sentinela — a migration confere o schema inteiro e falha sozinha.
    const sondas: [string, Record<string, unknown>][] = [
      // Os argumentos não importam: a recusa tem que vir do privilégio, antes
      // de a função olhar para qualquer um deles.
      ['add_to_queue', { p_tenant_id: await getTestTenantId(), p_customer_id: await getTestTenantId() }],
      ['add_platform_admin_by_email', { p_email: 'x@y.com', p_role: 'owner' }],
      ['fn_tenant_timezone', { p_tenant_id: await getTestTenantId() }],
      ['list_platform_admins', {}],
      ['get_user_tenants', {}],
    ]

    for (const [fn, args] of sondas) {
      const { error } = await anonimo().rpc(fn, args)
      expect(error, `anon executou ${fn}`).not.toBeNull()
      expect(error!.code, `${fn}: esperado 42501, veio ${error!.message}`).toBe('42501')
    }
  })
})

test.describe('Rota de drenagem (ADR 0034 Fase 4)', () => {
  /**
   * A drenagem roda sozinha a cada 15 minutos e reprocessa evento de gateway —
   * ou seja, mexe em dinheiro sem ninguém olhando. A porta é o `CRON_SECRET`,
   * o mesmo esquema da emissão de cobranças.
   *
   * Só a RECUSA é testada aqui. O caminho feliz chama a Edge Function
   * `gateway-replay`, que não roda durante a suíte; um teste dele viraria
   * intermitente. Ele foi verificado à mão, com as funções servidas localmente.
   */
  test('sem o segredo do cron, a drenagem não roda', async ({ request }) => {
    const semNada = await request.get('/api/cron/drain-gateway-events')
    expect(semNada.status(), 'drenagem aberta sem autenticação').not.toBe(200)

    const comSegredoErrado = await request.get('/api/cron/drain-gateway-events', {
      headers: { Authorization: 'Bearer segredo-errado' },
    })
    expect(comSegredoErrado.status(), 'drenagem aceitou segredo errado').not.toBe(200)
  })
})
