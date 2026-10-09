/**
 * `POST /api/charges/[id]/payment-intent` — o app do cliente pedindo um QR.
 *
 * A rota roda com `service_role`: a RLS não protege nada aqui, e a única coisa
 * entre um cliente e a cobrança de outro é uma comparação escrita à mão dentro
 * do handler. Ela nunca tinha sido exercitada.
 *
 * O teste é dividido em dois porque as duas metades têm naturezas diferentes:
 *
 * - **A rota** (autenticação e titularidade) só existe sobre HTTP: ela chama
 *   `cookies()` e não roda fora do escopo de requisição. Vai contra o dev
 *   server, com token de cliente de verdade.
 * - **`getOrCreateIntent`** é onde mora a decisão de dinheiro — quanto cobrar,
 *   reaproveitar ou não a tentativa pendente. Vai com um provedor FALSO, que é
 *   exatamente para isso que `PaymentProvider` é uma interface: dá para provar
 *   o valor sem falar com o Mercado Pago.
 */

import { test, expect, request as pwRequest } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { cpfShellEmail } from '@gomoto/core'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestContract,
  deleteTestCustomer, deleteTestAuthUser,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { getOrCreateIntent } from '../src/lib/payment/intents'
import type { PaymentProvider } from '../src/lib/payment/types'
import type { ProviderRegistry } from '../src/lib/payment/registry'

const admin = () => getSupabaseAdmin()
const RUN = Date.now().toString(36)
const SENHA = 'senha-de-teste-1234'

let tenantId = ''
let vehicleId = ''
let rentalId = ''

/** Cliente com acesso ao app: usuário auth + `customers.user_id` preenchido. */
type ClienteApp = { customerId: string; userId: string; token: string; cpf: string }

// CPF é único por tenant. Derivar do RUN colidia entre os dois describes; o
// contador com ruído é o mesmo esquema de `helpers.uniqueSuffix`.
let _cpfSeq = 0
function cpfUnico(): string {
  _cpfSeq += 1
  const ruido = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `9${Date.now().toString().slice(-7)}${ruido}`.slice(0, 11).padEnd(11, '0')
}

async function criarClienteComApp(): Promise<ClienteApp> {
  const cpf = cpfUnico()
  const email = cpfShellEmail(cpf)

  const { data: created, error: authErr } = await admin().auth.admin.createUser({
    email, password: SENHA, email_confirm: true,
  })
  if (authErr || !created.user) throw new Error(`auth: ${authErr?.message}`)

  const { data: customer, error } = await admin()
    .from('customers')
    .insert({
      tenant_id: tenantId, name: `${TEST_TAG} App ${cpf.slice(-4)}`,
      cpf, phone: '21988887777', state: 'RJ', active: true, in_queue: false,
      user_id: created.user.id,
    })
    .select('id')
    .single()
  if (error) throw new Error(`cliente: ${error.message}`)

  // Token real: é o que o app manda no Authorization.
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  const { data: session, error: signErr } = await anon.auth.signInWithPassword({ email, password: SENHA })
  if (signErr || !session.session) throw new Error(`login: ${signErr?.message}`)

  return {
    customerId: (customer as { id: string }).id,
    userId: created.user.id,
    token: session.session.access_token,
    cpf,
  }
}

async function cobrancaPara(customerId: string, valor: number) {
  const c = await createCharge(admin(), tenantId, {
    customerId,
    rentalId: null,
    dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    sourceModule: 'manual',
    items: [{
      description: `${TEST_TAG} Intent ${RUN}`,
      credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: valor, amount: valor,
    }],
  })
  return c.chargeId as string
}

/**
 * Provedor falso: registra o que foi pedido, sem sair da máquina.
 *
 * Entra por REGISTRY, não por parâmetro (ADR 0030): `getOrCreateIntent` resolve
 * o gateway pela conta que o tenant elegeu, então o falso tem que se passar
 * pelo slug daquela conta. É o que torna o teste uma prova de que a resolução
 * funciona, e não só do cálculo de valor.
 */
function provedorFalso(id = 'mercadopago', methods: PaymentProvider['descriptor']['methods'] = ['pix']) {
  const chamadas: { amount: number; chargeId: string; method: string }[] = []
  const provider: PaymentProvider = {
    descriptor: {
      id, label: 'Provedor Falso', description: 'teste',
      connectionMode: 'oauth', methods, minAmount: 5, available: true,
    },
    async createIntent({ amount, chargeId, method }) {
      chamadas.push({ amount, chargeId, method })
      return {
        providerIntentId: `falso-${RUN}-${chamadas.length}-${Math.random().toString(36).slice(2)}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        payload: { qr_code: 'QRFALSO' },
      }
    },
  }
  const registry: ProviderRegistry = { [id]: provider }
  return { provider, registry, chamadas }
}

let contaProvedorId = ''

/**
 * Remove a conta do provedor e o que depende dela.
 *
 * `payment_intents.provider_account_id` é `ON DELETE RESTRICT`: apagar a conta
 * direto falha assim que um teste tiver gerado uma tentativa. Como o erro do
 * `afterAll` não era conferido, a falha passava despercebida e cada execução
 * deixava mais uma conta ATIVA no banco — resíduo que chegou a mudar o
 * resultado de um teste que perguntava "existe conta ativa?".
 */
async function removerContaProvedor(accountId: string) {
  if (!accountId) return
  await admin().from('payment_intents').delete().eq('provider_account_id', accountId)
  const { error } = await admin().from('payment_provider_accounts').delete().eq('id', accountId)
  if (error) console.warn(`[limpeza] conta ${accountId} sobreviveu: ${error.message}`)
}

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const v = await createTestVehicle()
  vehicleId = v.id
  const c = await createTestContract(vehicleId)
  rentalId = c.contractId
  await deleteTestCustomer(c.customerId).catch(() => {})
})

test.afterAll(async () => {
  await removerContaProvedor(contaProvedorId)
  await deleteTestVehicle(vehicleId)
  void rentalId
})

test.describe('Rota do QR — autenticação e titularidade', () => {
  let dono: ClienteApp
  let intruso: ClienteApp
  let chargeDoDono = ''

  test.beforeAll(async () => {
    dono = await criarClienteComApp()
    intruso = await criarClienteComApp()
    chargeDoDono = await cobrancaPara(dono.customerId, 300)
  })

  test.afterAll(async () => {
    await deleteTestCustomer(dono.customerId).catch(() => {})
    await deleteTestCustomer(intruso.customerId).catch(() => {})
    await deleteTestAuthUser(dono.userId)
    await deleteTestAuthUser(intruso.userId)
  })

  test('sem token não passa', async ({ request }) => {
    const res = await request.post(`/api/charges/${chargeDoDono}/payment-intent`, { data: {} })
    expect(res.status()).toBe(401)
  })

  test('token inválido não passa', async ({ request }) => {
    const res = await request.post(`/api/charges/${chargeDoDono}/payment-intent`, {
      headers: { Authorization: 'Bearer token.invalido.qualquer' },
      data: {},
    })
    expect(res.status()).toBe(401)
  })

  test('cliente NÃO gera QR para a cobrança de outro cliente', async ({ request }) => {
    // A rota roda com service_role: sem esta checagem, a RLS não impediria
    // nada. Um cliente autenticado montaria o QR da dívida do vizinho — e o
    // valor devido dele vaza junto.
    const res = await request.post(`/api/charges/${chargeDoDono}/payment-intent`, {
      headers: { Authorization: `Bearer ${intruso.token}` },
      data: {},
    })

    expect(res.status(), 'cliente alcançou a cobrança de outro').toBe(404)

    const { count } = await admin()
      .from('payment_intents').select('id', { count: 'exact', head: true })
      .eq('charge_id', chargeDoDono)
    expect(count, 'criou tentativa de pagamento para a cobrança alheia').toBe(0)
  })

  test('cobrança inexistente devolve 404, não erro interno', async ({ request }) => {
    const res = await request.post(
      '/api/charges/00000000-0000-4000-8000-000000000999/payment-intent',
      { headers: { Authorization: `Bearer ${dono.token}` }, data: {} },
    )
    expect(res.status()).toBe(404)
  })

  test('cliente de DUAS locadoras alcança a própria cobrança', async ({ request }) => {
    // Regressão de produção (2026-09-25): a rota buscava o cadastro com
    // `.maybeSingle()` por `user_id`. Com um cadastro por locadora (PRD 0001),
    // o PostgREST devolvia erro e o cliente ouvia "Cliente não encontrado".
    const { data: outra, error: tErr } = await admin()
      .from('tenants')
      .insert({ name: `${TEST_TAG} Outra ${RUN}`, slug: `e2e-outra-${RUN}` })
      .select('id')
      .single()
    if (tErr) throw new Error(`tenant: ${tErr.message}`)
    const outraId = (outra as { id: string }).id

    try {
      const { error: cErr } = await admin().from('customers').insert({
        tenant_id: outraId, name: `${TEST_TAG} App outra`, cpf: dono.cpf,
        phone: '21988887777', state: 'RJ', active: true, in_queue: false,
        user_id: dono.userId,
      })
      if (cErr) throw new Error(`cliente na outra locadora: ${cErr.message}`)

      const res = await request.post(`/api/charges/${chargeDoDono}/payment-intent`, {
        headers: { Authorization: `Bearer ${dono.token}` },
        data: {},
      })
      const body = await res.json()

      // Sem gateway configurado a rota ainda pode recusar (403 "Pagamento
      // online não configurado"); o que NÃO pode é negar que ele é cliente
      // nem que a cobrança é dele.
      expect(body.error?.message, 'dono com dois cadastros foi tratado como não-cliente')
        .not.toBe('Cliente não encontrado')
      expect(res.status(), 'dono com dois cadastros não alcançou a própria cobrança').not.toBe(404)
    } finally {
      await admin().from('customers').delete().eq('tenant_id', outraId)
      await admin().from('tenants').delete().eq('id', outraId)
    }
  })

  test('usuário autenticado que não é cliente é barrado', async ({ request }) => {
    // Operador do cockpit tem token válido e nenhum `customers.user_id`.
    const { data: session } = await createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ).auth.signInWithPassword({
      email: process.env.TEST_USER_EMAIL!,
      password: process.env.TEST_USER_PASSWORD!,
    })

    const res = await request.post(`/api/charges/${chargeDoDono}/payment-intent`, {
      headers: { Authorization: `Bearer ${session.session!.access_token}` },
      data: {},
    })
    expect(res.status()).toBe(403)
  })
})

test.describe('Valor do QR — getOrCreateIntent', () => {
  let cliente: ClienteApp

  test.beforeAll(async () => {
    cliente = await criarClienteComApp()

    const { data, error } = await admin()
      .from('payment_provider_accounts')
      .insert({
        tenant_id: tenantId, provider: 'mercadopago',
        external_account_id: `intent-${RUN}`, active: true, is_default: true,
      })
      .select('id')
      .single()
    if (error) throw new Error(`conta: ${error.message}`)
    contaProvedorId = (data as { id: string }).id

    // A credencial não mora na linha: `getOrCreateIntent` a busca por função.
    // Sem semear, ela devolve null e o fluxo para em "credenciais não
    // configuradas" — antes de exercitar qualquer decisão de valor.
    const { error: credErr } = await admin().rpc('fn_store_provider_credentials', {
      p_account_id:    contaProvedorId,
      p_access_token:  'APP_USR-token-de-teste',
      p_refresh_token: 'TG-refresh-de-teste',
    })
    if (credErr) throw new Error(`credencial: ${credErr.message}`)
  })

  test.afterAll(async () => {
    await deleteTestCustomer(cliente.customerId).catch(() => {})
    await deleteTestAuthUser(cliente.userId)
  })

  test('cobra o valor em aberto, não o valor de face', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 500)
    const { registry, chamadas } = provedorFalso()

    const r = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)

    expect(r.amount).toBe(500)
    expect(r.is_reused).toBe(false)
    expect(chamadas[0].amount, 'pediu ao provedor um valor diferente do devido').toBe(500)
  })

  test('sem método pedido, usa o meio do gateway ELEITO', async () => {
    // Os dois chamadores reais escreviam `'pix'` fixo, o que só funcionava
    // enquanto todo gateway gerava PIX. Um provedor de checkout hospedado
    // (`payment_link`) recusaria — e a locadora leria "não gera cobrança por
    // pix" depois de trocar de gateway, sem nunca ter pedido PIX.
    const chargeId = await cobrancaPara(cliente.customerId, 300)
    const { registry, chamadas } = provedorFalso('mercadopago', ['payment_link'])

    const r = await getOrCreateIntent(admin(), { tenantId, chargeId }, registry)

    expect(chamadas[0].method, 'pediu ao provedor um meio que ele não gera').toBe('payment_link')
    expect(r.method).toBe('payment_link')

    // E o que ficou gravado é o que a confirmação vai ler.
    const { data } = await admin()
      .from('payment_intents').select('method').eq('id', r.intent_id).single()
    expect((data as { method: string }).method).toBe('payment_link')
  })

  test('a segunda chamada REAPROVEITA a tentativa pendente', async () => {
    // Índice único parcial `idx_payment_intents_one_pending_per_charge`
    // impede dois QR ativos para a mesma dívida. Se o código não reaproveitar,
    // a segunda chamada explode — e o cliente vê erro ao reabrir a tela.
    const chargeId = await cobrancaPara(cliente.customerId, 250)
    const { registry, chamadas } = provedorFalso()

    const primeira = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)
    const segunda = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)

    expect(segunda.intent_id).toBe(primeira.intent_id)
    expect(segunda.is_reused).toBe(true)
    expect(chamadas, 'chamou o provedor de novo para a mesma dívida').toHaveLength(1)

    const { count } = await admin()
      .from('payment_intents').select('id', { count: 'exact', head: true })
      .eq('charge_id', chargeId)
    expect(count).toBe(1)
  })

  test('tentativa expirada é marcada e dá lugar a uma nova', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 180)
    const { registry } = provedorFalso()

    const primeira = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)

    // Vence o QR: é o que o tempo faria.
    await admin()
      .from('payment_intents')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', primeira.intent_id)

    const segunda = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)

    expect(segunda.intent_id).not.toBe(primeira.intent_id)
    expect(segunda.is_reused).toBe(false)

    // A antiga precisa sair de `pending`, senão o índice único recusaria a nova.
    const { data: antiga } = await admin()
      .from('payment_intents').select('status').eq('id', primeira.intent_id).single()
    expect((antiga as { status: string }).status).toBe('expired')
  })

  test('dois toques no botão do app não quebram e não geram dois QR', async () => {
    // O app pode disparar duas vezes: toque duplo, reconexão, retry do cliente
    // HTTP. As duas chamadas não encontram tentativa pendente, as duas criam no
    // provedor e a segunda inserção bate no índice único — que existe
    // exatamente para impedir dois QR ativos para a mesma dívida.
    const chargeId = await cobrancaPara(cliente.customerId, 340)
    const { registry } = provedorFalso()

    const resultados = await Promise.allSettled([
      getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry),
      getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry),
    ])

    const { count } = await admin()
      .from('payment_intents').select('id', { count: 'exact', head: true })
      .eq('charge_id', chargeId).eq('status', 'pending')
    expect(count, 'dois QR ativos para a mesma dívida').toBe(1)

    // O cliente não pode ver erro por ter tocado duas vezes: a chamada perdedora
    // deve receber o QR que a vencedora criou.
    const ok = resultados.filter((r) => r.status === 'fulfilled')
    expect(ok, 'uma das chamadas devolveu erro ao usuário').toHaveLength(2)

    const ids = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ intent_id: string }>).value.intent_id))
    expect(ids.size, 'as duas chamadas devolveram QR diferentes').toBe(1)
  })

  test('cobrança já quitada não gera QR', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 120)
    const { registry } = provedorFalso()

    // Quita por fora, como uma baixa manual faria.
    const { data: pay } = await admin()
      .from('payments')
      .insert({
        tenant_id: tenantId, customer_id: cliente.customerId, amount: 120,
        method: 'cash', paid_at: new Date().toISOString(),
      })
      .select('id').single()
    await admin().from('payment_allocations').insert({
      tenant_id: tenantId, payment_id: (pay as { id: string }).id,
      charge_id: chargeId, amount: 120,
    })

    await expect(getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry))
      .rejects.toThrow(/não está em aberto/i)
  })

  test('cobrança inexistente não vira QR silencioso', async () => {
    const { registry, chamadas } = provedorFalso()
    await expect(getOrCreateIntent(
      admin(), { tenantId, chargeId: '00000000-0000-4000-8000-000000000998', method: 'pix' }, registry,
    )).rejects.toThrow(/não encontrada/i)
    expect(chamadas, 'falou com o provedor sem cobrança').toHaveLength(0)
  })

  /**
   * O ponto da ADR 0030: quem cobra é a conta ELEITA pelo tenant, não um
   * provedor escolhido por `import`. Antes, `is_default` existia e não era lido
   * por ninguém — cadastrar um segundo gateway não mudava nada.
   */
  test('cobra pelo gateway que o tenant elegeu, não pelo primeiro que existir', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 410)

    // Segundo gateway do mesmo tenant, eleito no lugar do primeiro.
    const { data: outra, error } = await admin()
      .from('payment_provider_accounts')
      .insert({
        tenant_id: tenantId, provider: 'gateway_de_teste',
        external_account_id: `eleito-${RUN}`, active: true,
      })
      .select('id').single()
    if (error) throw new Error(`conta rival: ${error.message}`)
    const rivalId = (outra as { id: string }).id

    await admin().rpc('fn_store_provider_credentials', {
      p_account_id: rivalId, p_access_token: 'tok-rival', p_refresh_token: null,
    })
    const { error: eleErr } = await admin().rpc('fn_set_default_provider_account', { p_account_id: rivalId })
    if (eleErr) throw new Error(`eleição: ${eleErr.message}`)

    try {
      const mp = provedorFalso('mercadopago')
      const rival = provedorFalso('gateway_de_teste')
      const registry = { ...mp.registry, ...rival.registry }

      const r = await getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry)

      expect(r.provider, 'cobrou pelo gateway errado').toBe('gateway_de_teste')
      expect(rival.chamadas, 'o gateway eleito não foi chamado').toHaveLength(1)
      expect(mp.chamadas, 'chamou um gateway que o tenant não elegeu').toHaveLength(0)
    } finally {
      await admin().from('payment_intents').delete().eq('provider_account_id', rivalId)
      await admin().rpc('fn_disconnect_provider_account', { p_account_id: rivalId })
      await admin().from('payment_provider_accounts').delete().eq('id', rivalId)
      await admin().rpc('fn_set_default_provider_account', { p_account_id: contaProvedorId })
    }
  })

  /**
   * G-05: `method` era aceito pela rota, propagado por três camadas e
   * descartado pelo provedor — pedir `boleto` gerava um PIX em silêncio.
   */
  test('método que o gateway não gera é recusado, não vira PIX', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 77)
    const { registry, chamadas } = provedorFalso()

    await expect(getOrCreateIntent(admin(), { tenantId, chargeId, method: 'boleto' }, registry))
      .rejects.toThrow(/não gera cobrança por boleto/i)

    expect(chamadas, 'falou com o provedor com método não suportado').toHaveLength(0)

    const { count } = await admin()
      .from('payment_intents').select('id', { count: 'exact', head: true })
      .eq('charge_id', chargeId)
    expect(count, 'gerou tentativa para um método recusado').toBe(0)
  })

  /**
   * Piso do gateway. A Cora recusa abaixo de R$ 5,00 com um 400 genérico
   * (`services[0].amount must be greater than or equal to 500`) que virava
   * "Não foi possível gerar o Pix. Tente novamente." — conselho inútil, porque
   * o valor da cobrança não muda por tentar de novo. Aconteceu em PRODUÇÃO.
   */
  test('valor abaixo do mínimo do gateway falha dizendo o limite, sem chamar a API', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 3)
    const { registry, chamadas } = provedorFalso()

    await expect(getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry))
      .rejects.toThrow(/não gera cobrança abaixo de R\$\s?5,00/i)

    expect(chamadas, 'gastou uma chamada ao gateway para receber um 400 previsível').toHaveLength(0)

    const { count } = await admin()
      .from('payment_intents').select('id', { count: 'exact', head: true })
      .eq('charge_id', chargeId)
    expect(count, 'gravou tentativa para um valor que o gateway recusa').toBe(0)
  })

  /** Conta gravada com slug sem implementação tem que parar aqui, com nome. */
  test('gateway sem implementação falha explicitamente', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 55)
    const { registry } = provedorFalso('outro_provedor')

    await expect(getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry))
      .rejects.toThrow(/não tem implementação/i)
  })

  test('sem conta de provedor ativa a falha é explícita', async () => {
    const chargeId = await cobrancaPara(cliente.customerId, 90)
    const { registry } = provedorFalso()

    // Desativar só a conta deste teste não bastava: resíduo de execução
    // anterior deixava OUTRA conta ativa do mesmo tenant, `getOrCreateIntent`
    // a encontrava e o teste passava ou falhava conforme a sujeira do banco.
    // A condição que se quer é "nenhum gateway eleito", então é ela que se monta.
    //
    // Pelo caminho real (`fn_disconnect_provider_account`), não por UPDATE
    // solto: `active = false` com `is_default = true` viola o CHECK da ADR 0030,
    // e o UPDATE recusado sem ninguém conferir o erro deixava o teste verde
    // contra um banco que não estava no estado pedido.
    const { data: ativas } = await admin()
      .from('payment_provider_accounts')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('active', true)

    const ids = ((ativas ?? []) as { id: string }[]).map((a) => a.id)
    for (const id of ids) {
      const { error } = await admin().rpc('fn_disconnect_provider_account', { p_account_id: id })
      if (error) throw new Error(`desconectar ${id}: ${error.message}`)
    }

    try {
      await expect(getOrCreateIntent(admin(), { tenantId, chargeId, method: 'pix' }, registry))
        .rejects.toThrow(/nenhum gateway/i)
    } finally {
      await admin().from('payment_provider_accounts').update({ active: true }).in('id', ids)
      await admin().rpc('fn_set_default_provider_account', { p_account_id: contaProvedorId })
    }
  })
})

test.describe('O saldo que o app do cliente lê', () => {
  /**
   * A cobrança aparecia CHEIA no app depois de paga.
   *
   * `charge_balances` é `security_invoker` e deriva `paid_amount` somando
   * `payment_allocations`. Essa tabela tinha só a policy de tenant — nenhuma
   * `customer_read_own_*`, ao contrário de `charges`, `charge_items` e
   * `payments`. Para a sessão do cliente o LATERAL voltava vazio, `allocated`
   * era 0, e a view respondia `open_amount = total_amount`.
   *
   * O erro se multiplicava: `calculateAmountDue` recebia o principal errado e
   * calculava o encargo sobre ele. Ao vivo, R$ 102,69 com R$ 100,00 abatidos
   * viraram R$ 105,45 no app contra R$ 2,76 no cockpit.
   *
   * O teste lê pela sessão REAL do cliente — com o token, como o app faz. Ler
   * com service role passa mesmo com a policy faltando, que é exatamente por
   * que o defeito sobreviveu: a rota do QR usa service role e calculava certo,
   * enquanto a tela mostrava outro número.
   */
  test('o abatimento aparece no saldo, e só as alocações do próprio cliente', async () => {
    const cliente  = await criarClienteComApp()
    const vizinho  = await criarClienteComApp()

    const chargeId = await cobrancaPara(cliente.customerId, 300)

    // Crédito precisa existir antes de ser abatido — `fn_apply_customer_credit`
    // recusa acima do saldo. O erro da RPC é conferido: sem isso o teste falha
    // depois, na asserção, dizendo que o abatimento "sumiu" quando na verdade
    // nunca aconteceu.
    const { error: concessao } = await admin().rpc('post_financial_transaction', {
      p_tenant_id: tenantId,
      p_transaction: {
        event_type: 'credit_granted', description: `${TEST_TAG} Crédito`,
        source_module: 'maintenance', source_id: crypto.randomUUID(),
      },
      p_entries: [
        { account_code: 'despesa_manutencao',   direction: 'debit',  amount: 100, customer_id: cliente.customerId },
        { account_code: 'creditos_de_clientes', direction: 'credit', amount: 100, customer_id: cliente.customerId },
      ],
    })
    expect(concessao, 'setup: concessão de crédito falhou').toBeNull()

    const { error: abatimento } = await admin().rpc('fn_apply_customer_credit', {
      p_tenant_id: tenantId, p_customer_id: cliente.customerId,
      p_charge_id: chargeId, p_amount: 100, p_created_by: null,
    })
    expect(abatimento, 'setup: abatimento falhou').toBeNull()

    const comoOCliente = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${cliente.token}` } } },
    )

    const { data: saldo } = await comoOCliente
      .from('charge_balances')
      .select('total_amount, paid_amount, open_amount')
      .eq('charge_id', chargeId)
      .maybeSingle()

    const s = saldo as { total_amount: number; paid_amount: number; open_amount: number } | null
    expect(s, 'o cliente precisa enxergar a própria cobrança').not.toBeNull()
    expect(Number(s!.paid_amount), 'o abatimento sumiu para o cliente').toBe(100)
    expect(Number(s!.open_amount), 'a cobrança apareceu cheia depois de paga').toBe(200)

    // A leitura não pode ser a porta para as alocações alheias.
    const comoOVizinho = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${vizinho.token}` } } },
    )

    const { data: alheias } = await comoOVizinho
      .from('payment_allocations')
      .select('id')
      .eq('charge_id', chargeId)

    expect((alheias ?? []).length, 'o vizinho leu alocação de outro cliente').toBe(0)
  })
})
