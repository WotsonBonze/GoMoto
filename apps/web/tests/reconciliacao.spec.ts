/**
 * Reconciliação do razão — P-7.
 *
 * Os outros specs provam que CADA fluxo lança certo. Este pergunta a coisa
 * inversa, que nenhum deles alcança: existe algum documento no banco que não
 * virou lançamento? É a pergunta que decide se dá para confiar no relatório
 * sem conferir a operação por fora.
 *
 * Duas garantias, diferentes em natureza:
 *
 * 1. **Toda transação fecha em zero.** Isto o banco já impõe por
 *    `trg_entries_balanced`, então o teste é de regressão da guarda — se uma
 *    migration futura desabilitar o trigger (coisa que migration pode fazer, e
 *    a de backfill de origem fez com outro), a varredura acusa o resíduo.
 *
 * 2. **Todo documento tem lançamento.** Esta NÃO tem trigger. É a brecha real,
 *    e é a que já apareceu quatro vezes neste redesenho: conceder crédito não
 *    lançava, custo de manutenção era descartado, valor da obrigação do veículo
 *    era descartado, e `issue_due_charges` — o passo interno da emissão — cria
 *    a cobrança sem lançar. Documento sem lançamento some do DRE e de
 *    `contas_a_receber`, mas continua aparecendo na tela de cobranças: o
 *    relatório passa a mentir sem nada acusar.
 *
 * Roda com service_role e varre o banco INTEIRO, não só o que o teste criou.
 * Se algum outro spec deixar documento órfão, este acusa.
 */

import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getSupabase, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { createCharge } from '../src/lib/financial/charges'
import { createPayable } from '../src/lib/financial/payables'

const admin = () => getSupabaseAdmin()

let vehicleId = ''
let customerId = ''

/**
 * Semeia um documento de cada tipo pelo caminho de produção.
 *
 * Sem isto o spec passaria vazio num banco recém-resetado — e "passou porque
 * não havia nada" é o modo de falha mais perigoso de um teste de varredura. As
 * asserções de vacuidade cobrem o resto: se o setup quebrar, elas acusam.
 */
async function semear() {
  const tenantId = await getTestTenantId()

  await createCharge(admin(), tenantId, {
    customerId,
    dueDate: new Date().toISOString().slice(0, 10),
    sourceModule: 'manual',
    sourceId: crypto.randomUUID(),
    items: [{
      description: `${TEST_TAG} Reconciliação`,
      credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: 500, amount: 500,
    }],
  })

  await createPayable(admin(), tenantId, {
    description: `${TEST_TAG} Reconciliação — despesa`,
    expenseAccountCode: 'despesa_operacional',
    competenceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    amount: 200,
    responsibility: 'company',
    vehicleId,
    sourceModule: 'manual',
    sourceId: crypto.randomUUID(),
  })

  // Crédito com o lançamento que a concessão passou a fazer. Semeado à mão
  // porque `createCustomerCredit` é Server Action e precisa de `cookies()`;
  // que o PRODUTO lança é o que `credito-e-encargo.spec.ts` prova.
  const { data: credito } = await admin().from('customer_credits').insert({
    tenant_id: tenantId, customer_id: customerId, amount: 80,
    origin: 'manual_adjustment', reason: `${TEST_TAG} Reconciliação`,
  }).select('id').single()

  await admin().rpc('post_financial_transaction', {
    p_tenant_id: tenantId,
    p_transaction: {
      event_type: 'credit_granted',
      description: `${TEST_TAG} Reconciliação — crédito`,
      source_module: 'customer_credit',
      source_id: (credito as { id: string }).id,
    },
    p_entries: [
      { account_code: 'despesa_operacional',   direction: 'debit',  amount: 80, customer_id: customerId },
      { account_code: 'creditos_de_clientes',  direction: 'credit', amount: 80, customer_id: customerId },
    ],
  })
}

test.beforeAll(async () => {
  const v = await createTestVehicle()
  vehicleId = v.id
  const c = await createTestCustomer()
  customerId = c.id
  await semear()
})

test.afterAll(async () => {
  // Cobrança emitida e lançamento não são apagáveis por construção; o que dá
  // para limpar, limpa-se, e o resto sai no próximo `db:reset`.
  if (customerId) await deleteTestCustomer(customerId).catch(() => {})
  if (vehicleId) await deleteTestVehicle(vehicleId).catch(() => {})
})


/**
 * Lê uma tabela inteira, em páginas.
 *
 * PostgREST devolve no máximo **1000 linhas** por requisição, sem erro e sem
 * aviso — a resposta simplesmente vem cortada. Esta spec varre o banco todo, e
 * ler só as primeiras 1000 `financial_entries` fazia as cobranças mais recentes
 * parecerem SEM lançamento: 25 falsos positivos com 1106 linhas na tabela.
 *
 * Um teste de integridade que mente por truncamento é pior que não existir —
 * acusa defeito onde não há e treina quem lê a ignorá-lo.
 */
async function lerTudo<T>(
  tabela: string,
  colunas: string,
  refinar?: (q: ReturnType<ReturnType<typeof getSupabaseAdmin>['from']>) => unknown,
): Promise<T[]> {
  const PAGINA = 1000
  const out: T[] = []

  for (let offset = 0; ; offset += PAGINA) {
    let q = admin().from(tabela).select(colunas)
    if (refinar) q = refinar(q) as typeof q
    const { data, error } = await q.range(offset, offset + PAGINA - 1)

    if (error) throw new Error(`falha ao ler ${tabela}: ${error.message}`)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PAGINA) break
  }

  return out
}

test.describe('Reconciliação do razão', () => {
  test('toda transação do banco fecha em zero', async () => {
    const data = await lerTudo<{ transaction_id: string; amount_signed: number }>(
      'financial_entries', 'transaction_id, amount_signed')

    const porTransacao = new Map<string, number>()
    for (const e of data) {
      porTransacao.set(e.transaction_id, (porTransacao.get(e.transaction_id) ?? 0) + Number(e.amount_signed))
    }

    expect(porTransacao.size, 'razão vazio — o teste não provaria nada').toBeGreaterThan(0)

    const desbalanceadas = [...porTransacao.entries()].filter(([, soma]) => Math.abs(soma) > 0.005)
    expect(
      desbalanceadas.map(([id, soma]) => `${id} soma ${soma.toFixed(2)}`),
      'transação com soma diferente de zero — a contrapartida se perdeu',
    ).toEqual([])

    // Perna solitária: soma zero por acaso não basta, uma transação precisa de
    // pelo menos duas pernas. É a segunda guarda de `trg_entries_balanced`.
    const contagem = new Map<string, number>()
    for (const e of (data ?? []) as { transaction_id: string }[]) {
      contagem.set(e.transaction_id, (contagem.get(e.transaction_id) ?? 0) + 1)
    }
    const solitarias = [...contagem.entries()].filter(([, n]) => n < 2).map(([id]) => id)
    expect(solitarias, 'transação com uma perna só').toEqual([])
  })

  test('nenhuma cobrança emitida ficou sem lançamento', async () => {
    const { data: charges } = await admin()
      .from('charges')
      .select('id, charge_number, source_module, status')
      .neq('status', 'cancelled')

    const lista = (charges ?? []) as { id: string; charge_number: number; source_module: string }[]
    expect(lista.length, 'sem cobrança no banco — o teste não provaria nada').toBeGreaterThan(0)

    const entries = await lerTudo<{ charge_id: string }>(
      'financial_entries', 'charge_id', (q) => q.not('charge_id', 'is', null))

    const comLancamento = new Set(entries.map((e) => e.charge_id))

    const orfas = lista
      .filter((c) => !comLancamento.has(c.id))
      .map((c) => `#${c.charge_number} (${c.source_module})`)

    expect(
      orfas,
      'cobrança emitida sem lançamento: some do DRE e de contas a receber, mas continua na tela',
    ).toEqual([])
  })

  test('nenhuma conta a pagar em aberto ficou sem lançamento', async () => {
    const { data: payables } = await admin()
      .from('payables')
      .select('id, description, source_module')
      .neq('status', 'cancelled')

    const lista = (payables ?? []) as { id: string; description: string; source_module: string }[]
    expect(lista.length, 'sem conta a pagar no banco — o teste não provaria nada').toBeGreaterThan(0)

    // O vínculo é `financial_entries.payable_id`, não o `source_id` da
    // transação: a origem da transação é o FATO (a manutenção, a multa), e o
    // payable é o documento que aquele fato gerou.
    const entries = await lerTudo<{ payable_id: string }>(
      'financial_entries', 'payable_id', (q) => q.not('payable_id', 'is', null))

    const comLancamento = new Set(entries.map((e) => e.payable_id))

    const orfas = lista
      .filter((p) => !comLancamento.has(p.id))
      .map((p) => `${p.source_module}: ${p.description}`)

    expect(orfas, 'conta a pagar sem lançamento: a despesa não chega ao DRE').toEqual([])
  })

  test('nenhum crédito de cliente ficou sem lançamento', async () => {
    // Conceder crédito sem lançar foi bug real: o saldo em
    // `customer_credit_balances` agrega o razão, então o crédito nascia
    // inutilizável — visível na tela do cliente e impossível de aplicar.
    const { data: creditos } = await admin()
      .from('customer_credits')
      .select('id, amount, origin, payment_id')

    const todos = (creditos ?? []) as {
      id: string; amount: number; origin: string; payment_id: string | null
    }[]
    expect(todos.length, 'sem crédito no banco — o teste não provaria nada').toBeGreaterThan(0)

    // Crédito por cobrança CANCELADA (ADR 0033, Questão 1) é lançado com
    // `source_module = 'payment'`, porque o fato que o originou é o
    // RECEBIMENTO e não uma concessão de crédito. Ele tem lançamento — só não
    // sob a chave que esta varredura procura, e o elo com o pagamento é o que
    // prova isso.
    //
    // A exceção está repetida aqui e na view `financial_reconciliation`. É
    // duplicação consciente: a view é o que produção lê, e este spec vale
    // justamente por ser uma SEGUNDA implementação da pergunta. Se as duas
    // divergirem, o teste acusa.
    const lista = todos.filter((c) => c.payment_id === null)

    const { data: tx } = await admin()
      .from('financial_transactions')
      .select('source_id')
      .eq('source_module', 'customer_credit')

    const comLancamento = new Set(((tx ?? []) as { source_id: string }[]).map((t) => t.source_id))

    const orfaos = lista
      .filter((c) => !comLancamento.has(c.id))
      .map((c) => `${c.origin} R$ ${c.amount}`)

    expect(orfaos, 'crédito concedido sem lançamento: nasce sem saldo utilizável').toEqual([])
  })

  test('a emissão que não lança no razão não é alcançável pelo cliente', async () => {
    // `issue_due_charges` cria o documento SEM lançar; quem lança é
    // `fn_issue_charges_for_tenant`, que a envolve. Enquanto a de dentro esteve
    // liberada para `authenticated`, qualquer sessão podia emitir cobrança que
    // nunca chegaria ao DRE.
    const cliente = await getSupabase()
    const tenantId = await getTestTenantId()

    for (const rpc of ['issue_due_charges', 'fn_issue_charges_for_tenant']) {
      const { error } = await cliente.rpc(rpc, { p_tenant_id: tenantId, p_lead_days: 0 })
      expect(error, `${rpc} continua chamável por usuário autenticado`).not.toBeNull()
      expect(
        `${error?.message} ${error?.code}`,
        `${rpc} falhou por outro motivo que não permissão`,
      ).toMatch(/permission denied|not find the function|PGRST202|42501/i)
    }
  })
})
