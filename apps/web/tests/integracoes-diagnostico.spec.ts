/**
 * Diagnóstico das integrações — ADR 0034, Fase 3.
 *
 * A tela existe porque, até ela, "o pagamento não apareceu, e agora?" não tinha
 * resposta dentro do produto: o rastro estava no inbox `gateway_events` e só era
 * alcançável por quem tivesse acesso ao banco.
 *
 * O que este spec protege não é o layout — é a CLASSIFICAÇÃO. A view
 * `gateway_event_audit` decide, em SQL, se um evento está confirmado, falhou,
 * está pendente ou foi aceito sem conferir; a tela só pinta. Errar essa
 * classificação é pior que não ter tela: um evento que falhou aparecendo como
 * "confirmado" convence o operador de que está tudo bem.
 *
 * Em especial: **"aceito sem conferir" não pode ser exibido como confirmado.**
 * É dinheiro que entrou sem reconsulta ao provedor (ADR 0033) e precisa de olho
 * humano.
 */

import { test, expect, type Page } from '@playwright/test'
import { TEST_TAG, getSupabaseAdmin, getTestTenantId } from './helpers'

const admin = () => getSupabaseAdmin()

const sufixo = Date.now().toString().slice(-9)
const evtId = (n: string) => `e2e-adr34-${sufixo}-${n}`

let tenantId = ''
const eventos: string[] = []

test.beforeAll(async () => {
  tenantId = await getTestTenantId()

  // Só eventos, sem dinheiro: a classificação de `failed`/`pending` não depende
  // de pagamento nenhum, e montar cobrança + intent + confirmação aqui faria o
  // spec testar a confirmação, que já tem `gateway-confirmacao.spec.ts`.
  // As TRÊS linhas declaram as MESMAS chaves de propósito. Num insert em lote o
  // PostgREST normaliza as colunas pela união das chaves e manda NULL onde a
  // linha não tem — o DEFAULT da coluna não entra. Sem isto,
  // `accepted_without_verification` (NOT NULL DEFAULT false) estoura nas duas
  // primeiras.
  const linhas = [
    {
      tenant_id: tenantId, provider: 'infinitepay', provider_event_id: evtId('falhou'),
      event_type: `payment.failed ${TEST_TAG}`, payload: {}, signature_valid: false,
      processed_at: null, accepted_without_verification: false,
      processing_error: 'Error: pagamento aprovado sem tentativa correspondente',
      attempts: 1, outcome: null,
    },
    {
      tenant_id: tenantId, provider: 'mercadopago', provider_event_id: evtId('pendente'),
      event_type: `payment.pending ${TEST_TAG}`, payload: {}, signature_valid: true,
      processed_at: null, accepted_without_verification: false,
      processing_error: null, attempts: 0, outcome: null,
    },
    {
      tenant_id: tenantId, provider: 'cora', provider_event_id: evtId('semverificar'),
      event_type: `invoice.PAID ${TEST_TAG}`, payload: {}, signature_valid: false,
      processed_at: new Date().toISOString(), accepted_without_verification: true,
      processing_error: null, attempts: 0, outcome: null,
    },
    {
      // O provedor respondeu que NÃO foi pago — Pix expirado. É a maioria dos
      // eventos numa operação real, e antes de gravar o desfecho eles viravam
      // ruído permanente na tela.
      tenant_id: tenantId, provider: 'infinitepay', provider_event_id: evtId('naopago'),
      event_type: `payment.expired ${TEST_TAG}`, payload: {}, signature_valid: false,
      processed_at: new Date().toISOString(), accepted_without_verification: false,
      processing_error: null, attempts: 0, outcome: 'ignored',
    },
  ]

  const { data, error } = await admin().from('gateway_events').insert(linhas).select('id')
  if (error) throw new Error(`setup falhou: ${error.message}`)
  eventos.push(...(data as { id: string }[]).map((r) => r.id))
})

test.afterAll(async () => {
  if (eventos.length > 0) {
    await admin().from('gateway_events').delete().in('id', eventos)
  }
})

async function abrir(page: Page) {
  await page.goto('/configuracoes/integracoes')
  await expect(page.getByRole('heading', { name: 'Diagnóstico das integrações' })).toBeVisible()
}

test.describe('Diagnóstico das integrações (ADR 0034)', () => {
  test('a classificação de cada evento chega à tela', async ({ page }) => {
    await abrir(page)

    // Asserção por LINHA, não por contagem de rótulos na página: a tabela mostra
    // o histórico do tenant, e contar daria falso positivo. O `TEST_TAG` viaja
    // no `event_type` justamente para isolar as linhas desta execução.
    const daExecucao = page.locator(`tr:has-text("${TEST_TAG}")`)
    await expect(daExecucao).toHaveCount(4)

    // Por EVENTO e não por provedor: dois eventos desta execução são da mesma
    // InfinitePay, e localizar pelo gateway casaria as duas linhas.
    const linha = (tipo: string) =>
      page.locator('tr', { hasText: tipo }).filter({ hasText: TEST_TAG })

    await expect(linha('payment.failed')).toContainText('Falhou')
    await expect(linha('payment.pending')).toContainText('Não processado')

    // O que mais importa: NÃO pode aparecer como confirmado. É dinheiro que
    // entrou sem reconsulta ao provedor, e pintá-lo de verde convenceria o
    // operador de que não há nada a conferir.
    await expect(linha('invoice.PAID')).toContainText('Aceito sem conferir')
    await expect(linha('invoice.PAID')).not.toContainText('Confirmado')

    // E nenhuma linha desta execução pode dizer "Sem efeito": esse rótulo é só
    // para evento de ciclo de vida, descartado antes de tocar o banco. Dizê-lo
    // sobre um evento que passou pelo caminho do dinheiro convence quem olha de
    // que não há nada ali — foi o que a auditoria do primeiro ciclo em produção
    // encontrou, sobre confirmações reais de R$ 1,00 e R$ 10,00.
    await expect(daExecucao.filter({ hasText: 'Sem efeito' })).toHaveCount(0)

    // O que o provedor recusou tem rótulo PRÓPRIO. Antes de gravar o desfecho
    // ele caía em "Processado, sem elo" — e como todo Pix que expira gera um
    // desses, a tela acumularia ruído permanente até ninguém mais lê-la.
    await expect(linha('payment.expired')).toContainText('Não pago')
    await expect(linha('payment.expired')).not.toContainText('sem elo')
  })

  test('o erro cru do provedor fica legível, não truncado numa célula', async ({ page }) => {
    await abrir(page)

    // Diagnóstico sem a mensagem do provedor é diagnóstico pela metade — foi
    // exatamente o que faltou quando o primeiro pagamento da InfinitePay sumiu.
    await expect(page.getByText('Erros registrados')).toBeVisible()
    await expect(
      page.getByText('pagamento aprovado sem tentativa correspondente', { exact: false }).first(),
    ).toBeVisible()
  })

  test('o reprocessar aparece só em quem está parado na fila', async ({ page }) => {
    await abrir(page)

    const linha = (provedor: string) =>
      page.locator('tr', { hasText: provedor }).filter({ hasText: TEST_TAG })

    // Falhou e não processado continuam na fila — o provedor não reenvia,
    // porque já recebeu 200. São os únicos que alguém precisa retomar.
    await expect(linha('InfinitePay').getByRole('button', { name: 'Reprocessar' })).toBeVisible()
    await expect(linha('Mercado Pago').getByRole('button', { name: 'Reprocessar' })).toBeVisible()

    // "Aceito sem conferir" JÁ virou dinheiro. Oferecer reprocessar ali
    // convidaria a mexer num recebimento concluído para resolver uma ressalva
    // que se resolve olhando o extrato, não reprocessando.
    await expect(linha('Cora').getByRole('button', { name: 'Reprocessar' })).toHaveCount(0)

    // NÃO coberto aqui: o clique. Ele chama a Edge Function `gateway-replay`,
    // que não roda durante a suíte — um teste do clique passaria a depender de
    // `supabase functions serve` estar de pé e viraria intermitente. O caminho
    // foi verificado à mão, com as funções servidas localmente e um mock da
    // API da Cora: evento parado → confirmado, R$ 250,00 no razão, cobrança
    // fechada.
  })

  test('o filtro isola o que precisa de atenção', async ({ page }) => {
    await abrir(page)

    await page.getByRole('button', { name: /Precisam de atenção/ }).click()

    // Os três semeados são de atenção, então continuam; o que some é o resto.
    // O "não pago" NÃO precisa de atenção: sai do filtro. Sobram os três que
    // pedem ação.
    await expect(page.locator(`tr:has-text("${TEST_TAG}")`)).toHaveCount(3)
    await expect(page.locator('tr', { hasText: 'Sem efeito' })).toHaveCount(0)
  })

  test('a reconciliação responde, e responde sobre o razão de verdade', async ({ page }) => {
    await abrir(page)

    await expect(page.getByRole('heading', { name: 'Reconciliação do razão' })).toBeVisible()

    // Sem afirmar "está tudo certo": o banco de teste acumula resíduo de outros
    // specs. O que se exige é que a seção RESPONDA — ou a mensagem de saudável,
    // ou a tabela de problemas. Uma seção muda seria a falha real.
    const saudavel = page.getByText('Nenhuma divergência', { exact: false })
    const comProblemas = page.getByRole('columnheader', { name: 'Problema' })

    await expect(saudavel.or(comProblemas).first()).toBeVisible()
  })

  // NÃO coberto aqui: que Operator/Viewer sejam barrados. A página usa
  // `requireTenantOwnerOrAdmin` e redireciona, igual a `configuracoes/usuarios`
  // — mas provar isso exige uma sessão de outro papel, que este spec não monta.
  // Fica com o teste de privilégio por papel, na Fase 5 da ADR 0034.
})
