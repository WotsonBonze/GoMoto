import { test, expect } from '@playwright/test'
import {
  TEST_TAG, getSupabaseAdmin, getTestTenantId, waitForPageLoad,
  createTestVehicle, createTestContract, deleteTestCustomer,
} from './helpers'
import { createCharge, cancelCharge, writeOffCharge } from '../src/lib/financial/charges'
import { calculateAmountDue, toPolicyRow, type LateChargePolicy } from '@gomoto/core'

/**
 * Política de encargo por atraso — a tela que faltava e o que ela não pode quebrar.
 *
 * Até aqui multa e juros só mudavam por SQL: não havia UMA escrita em
 * `late_charge_policies` fora de migration. O que existia em Configurações era
 * `saveFinancialSettings`, gravando JSON numa chave que ninguém lia.
 *
 * O teste que importa não é "salvou": é que salvar NÃO mexe no que já foi
 * cobrado. Cobrança guarda `late_charge_policy_id` e a conta do devido sai
 * dele — se a nova versão vazasse para trás, todo cliente com dívida antiga
 * passaria a dever outro valor no dia em que a empresa reajustasse a política.
 */

const admin = () => getSupabaseAdmin()

/** Longe o bastante para não capturar cobranças que outros testes emitem hoje. */
function daquiA(dias: number): string {
  const d = new Date(Date.now() + dias * 864e5)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function hoje(): string {
  return daquiA(0)
}

/** Deslocamento único por execução: duas rodadas não disputam a mesma data. */
const OFFSET = 90 + Math.floor(Math.random() * 900)

let tenantId: string
let customerId: string
let rentalId: string
let vehicleId: string
const criadas: string[] = []

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const v = await createTestVehicle()
  vehicleId = v.id
  const contrato = await createTestContract(vehicleId)
  customerId = contrato.customerId
  rentalId = contrato.contractId
})

test.afterAll(async () => {
  // As versões criadas aqui precisam sumir: `fn_create_charge` escolhe a
  // política por `effective_from <= due_date`, então uma versão esquecida
  // mudaria o valor esperado por outras suítes.
  // Uma por vez: `charges.late_charge_policy_id` é FK RESTRICT, e um único
  // `delete ... in (...)` perdia TODAS as linhas quando uma delas estava presa.
  // Presa fica a que cobranças de outros testes adotaram — política é do
  // tenant, então criar uma versão aqui muda o que a empresa inteira passa a
  // usar. Some no `pnpm db:reset`; as de data futura saem sempre.
  const presas: string[] = []
  for (const id of criadas) {
    const { error } = await admin().from('late_charge_policies').delete().eq('id', id)
    if (error) presas.push(id)
  }
  if (presas.length > 0) {
    console.warn(`[politica-encargo] ${presas.length} política(s) seguem presas a cobranças`)
  }
  await admin().from('rentals').delete().eq('id', rentalId)
  await deleteTestCustomer(customerId).catch(() => {})
  await admin().from('vehicles').delete().eq('id', vehicleId)
})

async function criarVersao(over: Partial<{
  fee_value: number; monthly_interest_percent: number
  grace_period_days: number; min_amount: number; effective_from: string
}> = {}) {
  const row = toPolicyRow({
    fee_type: 'percentage',
    fee_value: 5,
    monthly_interest_percent: 3,
    grace_period_days: 0,
    min_amount: 0,
    effective_from: daquiA(OFFSET + 5),
    ...over,
  })

  const { data, error } = await admin().rpc('fn_create_late_charge_policy', {
    p_tenant_id:           tenantId,
    p_fee_type:            row.fee_type,
    p_fee_value:           row.fee_value,
    p_daily_interest_rate: row.daily_interest_rate,
    p_grace_period_days:   row.grace_period_days,
    p_min_amount:          row.min_amount,
    p_effective_from:      row.effective_from,
  })

  if (!error && data) criadas.push(data as string)
  return { id: data as string | null, error }
}

test.describe('Política de encargo — versionamento', () => {
  test('nova versão não muda o que já foi cobrado', async () => {
    // Uma cobrança vencida há 30 dias, emitida com a política de hoje.
    const { chargeId } = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate: daquiA(-30),
      sourceModule: 'manual',
      sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Congelamento ${Date.now().toString(36)}`,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 1000, amount: 1000,
      }],
    })

    const politicaDe = async (id: string) => {
      const { data: c } = await admin()
        .from('charges').select('late_charge_policy_id').eq('id', id).single()
      const pid = (c as { late_charge_policy_id: string }).late_charge_policy_id
      const { data: p } = await admin()
        .from('late_charge_policies')
        .select('fee_type, fee_value, daily_interest_rate, grace_period_days, min_amount')
        .eq('id', pid).single()
      return { pid, policy: p as LateChargePolicy }
    }

    const saldo = async () => {
      const { data } = await admin()
        .from('charge_balances')
        .select('open_amount, paid_amount, late_charge_amount, due_date, status')
        .eq('charge_id', chargeId).single()
      return data as {
        open_amount: number; paid_amount: number; late_charge_amount: number
        due_date: string; status: string
      }
    }

    const antes = await politicaDe(chargeId)
    const devidoAntes = calculateAmountDue(await saldo(), antes.policy).amount_due

    // Reajuste agressivo: 5% de multa e 3% ao mês, contra os 2% e ~1% vigentes.
    const { error } = await criarVersao()
    expect(error, 'a nova versão precisa entrar').toBeNull()

    const depois = await politicaDe(chargeId)
    expect(depois.pid, 'a cobrança não pode trocar de política').toBe(antes.pid)
    expect(depois.policy).toEqual(antes.policy)

    const devidoDepois = calculateAmountDue(await saldo(), depois.policy).amount_due
    expect(devidoDepois, 'o valor devido não pode mudar por reajuste de política')
      .toBeCloseTo(devidoAntes, 2)
  })

  test('a versão nasce com o número seguinte, sem furo nem repetição', async () => {
    const antes = await admin()
      .from('late_charge_policies').select('version')
      .eq('tenant_id', tenantId).order('version', { ascending: false }).limit(1).single()
    const ultimo = (antes.data as { version: number }).version

    const { id } = await criarVersao({ effective_from: daquiA(OFFSET + 1) })
    const { data } = await admin()
      .from('late_charge_policies').select('version').eq('id', id!).single()

    expect((data as { version: number }).version).toBe(ultimo + 1)
  })

  test('duas gravações simultâneas não colidem na numeração', async () => {
    // `MAX(version) + 1` lido no app daria o mesmo número às duas: uma entra e
    // a outra estoura no UNIQUE. A função trava o tenant justamente por isso.
    const [a, b] = await Promise.all([
      criarVersao({ effective_from: daquiA(OFFSET + 2) }),
      criarVersao({ effective_from: daquiA(OFFSET + 3) }),
    ])

    expect(a.error, 'a primeira não pode falhar').toBeNull()
    expect(b.error, 'a segunda também não — a trava serializa, não recusa').toBeNull()

    const { data } = await admin()
      .from('late_charge_policies').select('version').in('id', [a.id!, b.id!])
    const versoes = (data as { version: number }[]).map((v) => v.version)
    expect(new Set(versoes).size, 'versões precisam ser distintas').toBe(2)
  })

  test('vigência no passado é recusada', async () => {
    // Retroagir mudaria a política das cobranças emitidas entre aquela data e
    // hoje — o retroativo que a versão existe para impedir.
    const { error } = await criarVersao({ effective_from: daquiA(-1) })
    expect(error?.message ?? '').toContain('EFFECTIVE_FROM_IN_PAST')
  })

  test('a fração chega ao banco como fração, não como o número digitado', async () => {
    // 5% grava 0.05. O CHECK `late_charge_percentage_is_fraction` recusa 5, e
    // era exatamente essa a convenção da `LateChargeConfig` removida.
    const { id } = await criarVersao({ effective_from: daquiA(OFFSET + 4), fee_value: 5 })
    const { data } = await admin()
      .from('late_charge_policies').select('fee_value, daily_interest_rate').eq('id', id!).single()

    const p = data as { fee_value: number; daily_interest_rate: number }
    expect(Number(p.fee_value)).toBeCloseTo(0.05, 4)
    expect(Number(p.daily_interest_rate)).toBeCloseTo(0.001, 6) // 3% ao mês ÷ 30
  })
})

test.describe('Política de encargo — a tela', () => {
  test('mostra a política em vigor e salva uma versão nova', async ({ page }) => {
    await page.goto('/configuracoes/encargos')
    await waitForPageLoad(page)

    const secao = page.locator('section').filter({ hasText: 'Encargo por atraso' })
    await expect(secao, 'a seção precisa existir — antes só dava pra mudar por SQL')
      .toBeVisible({ timeout: 10_000 })

    await expect(secao.getByText(/Em vigor · versão \d+/)).toBeVisible()

    // A taxa diária derivada fica à vista: o operador digita ao mês porque é
    // assim que o contrato fala, e o banco guarda ao dia.
    await expect(secao.getByText(/Equivale a [\d,.]+% ao dia/)).toBeVisible()

    const carencia = secao.getByLabel('Carência (dias)')
    await carencia.fill('7')
    await secao.getByLabel('Em vigor a partir de').fill(daquiA(OFFSET))
    await secao.getByRole('button', { name: /salvar nova versão/i }).click()

    await expect(secao.getByText(/Nova versão salva/i)).toBeVisible({ timeout: 15_000 })

    const { data } = await admin()
      .from('late_charge_policies')
      .select('id, grace_period_days, effective_from')
      .eq('tenant_id', tenantId)
      .eq('effective_from', daquiA(OFFSET))
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nova = data as { id: string; grace_period_days: number } | null
    if (nova) criadas.push(nova.id)   // antes de asserir: falha aqui não pode deixar resíduo
    expect(nova, 'a tela precisa ter gravado a versão').not.toBeNull()
    expect(nova!.grace_period_days).toBe(7)
  })

  test('a tela recusa vigência anterior a hoje', async ({ page }) => {
    await page.goto('/configuracoes/encargos')
    await waitForPageLoad(page)

    const secao = page.locator('section').filter({ hasText: 'Encargo por atraso' })
    const campo = secao.getByLabel('Em vigor a partir de')

    // O input tem `min` = hoje; o teclado ainda deixa digitar antes disso, e é
    // por isso que o banco também recusa. A tela precisa dizer o motivo.
    await expect(campo).toHaveAttribute('min', hoje())

    await campo.fill(daquiA(-10))
    await secao.getByRole('button', { name: /salvar nova versão/i }).click()
    await expect(secao.getByText(/não pode começar antes de hoje/i)).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('Política de encargo — as três telas concordam', () => {
  /**
   * O bug que originou este bloco: a lista do cockpit resolvia "a política
   * vigente HOJE" e aplicava a MESMA a todas as linhas, enquanto a tela de
   * detalhe lia `late_charge_policy_id` de cada cobrança. Com uma versão só na
   * base as duas concordavam por acidente. Bastou existir a segunda para a
   * mesma cobrança valer R$ 35 de multa fixa na lista e 2% no detalhe.
   */
  test('lista, detalhe e modal mostram o mesmo encargo com duas políticas na base', async ({ page }) => {
    const marca = `${TEST_TAG} Divergencia ${Date.now().toString(36)}`

    // Cobrança emitida sob a política ATUAL, vencida há 20 dias.
    // `issueDate` no passado de propósito: a política sai da data de EMISSÃO,
    // então esta cobrança precisa nascer sob a regra antiga para que a nova,
    // criada logo abaixo, tenha de que não vazar.
    const { chargeId } = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate:   daquiA(-20),
      issueDate: daquiA(-25),
      sourceModule: 'manual',
      sourceId: crypto.randomUUID(),
      items: [{
        description: marca,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 1000, amount: 1000,
      }],
    })

    // Segunda versão vigente HOJE, com regra bem diferente: multa FIXA de
    // R$ 35 contra os 2% da anterior. É a que a lista usaria indevidamente.
    const nova = toPolicyRow({
      fee_type: 'fixed', fee_value: 35, monthly_interest_percent: 6,
      grace_period_days: 0, min_amount: 0, effective_from: hoje(),
    })
    const { data: novaId, error } = await admin().rpc('fn_create_late_charge_policy', {
      p_tenant_id: tenantId,
      p_fee_type: nova.fee_type, p_fee_value: nova.fee_value,
      p_daily_interest_rate: nova.daily_interest_rate,
      p_grace_period_days: nova.grace_period_days,
      p_min_amount: nova.min_amount, p_effective_from: nova.effective_from,
    })
    expect(error?.message ?? null, 'nova versão precisa entrar').toBeNull()
    criadas.push(novaId as string)

    /** Primeiro "R$ x,yz" do trecho. */
    const valorDe = (texto: string) => {
      const m = texto.match(/R\$\s*([\d.]+),(\d{2})/)
      if (!m) throw new Error(`sem valor em: ${texto}`)
      return parseFloat(`${m[1]!.replace(/\./g, '')}.${m[2]}`)
    }

    // ── 1. Lista ────────────────────────────────────────────────────────────
    await page.goto('/cobrancas')
    await waitForPageLoad(page)
    await page.getByPlaceholder(/cliente, placa ou número/i).fill(marca)

    const linha = page.locator('tr', { hasText: marca }).first()
    await expect(linha).toBeVisible({ timeout: 10_000 })
        // A célula "Devido" (7ª coluna), não a linha inteira: ali dentro vêm dois
    // valores — o devido e o badge "+R$ x" do encargo — e a linha ainda traz
    // Total e Pago antes deles.
    const naLista = valorDe(await linha.locator('td').nth(6).innerText())

    // ── 2. Modal da lista ───────────────────────────────────────────────────
    await linha.getByTitle(/registrar pagamento/i).click()
    const modalLista = page.locator('div.fixed.inset-0').first()
    await expect(modalLista).toBeVisible()
    const noModalLista = parseFloat(await modalLista.locator('input[type="number"]').inputValue())
    await page.keyboard.press('Escape')

    // ── 3. Tela de detalhe ──────────────────────────────────────────────────
    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)
    const totalComEncargos = page.locator('tr').filter({ hasText: 'Total com encargos' })
    await expect(totalComEncargos).toBeVisible({ timeout: 10_000 })
    const noDetalhe = valorDe(await totalComEncargos.innerText())

    // ── 4. Modal do detalhe ─────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Registrar pagamento' }).click()
    const modalDetalhe = page.locator('div.fixed.inset-0').first()
    await expect(modalDetalhe).toBeVisible()
    const noModalDetalhe = parseFloat(await modalDetalhe.locator('input[type="number"]').inputValue())

    // As quatro leituras precisam bater. A cobrança foi emitida sob a política
    // ANTIGA (2% sobre 1.000 = R$ 20 de multa); a nova, fixa em R$ 35, não pode
    // vazar para ela.
    expect(noModalLista, 'lista e seu modal').toBeCloseTo(naLista, 2)
    expect(noDetalhe, 'detalhe e lista').toBeCloseTo(naLista, 2)
    expect(noModalDetalhe, 'modal do detalhe e detalhe').toBeCloseTo(noDetalhe, 2)

    // E o valor tem que ser o da política antiga, não o da nova.
    expect(naLista, 'a multa é 2% de 1.000, não os R$ 35 da política nova')
      .toBeGreaterThan(1020)
    expect(naLista).toBeLessThan(1030)
  })
})

test.describe('Dias de atraso — o hoje do operador', () => {
  /**
   * O banco roda em UTC. Das 21h à meia-noite, `CURRENT_DATE` já é o dia
   * seguinte enquanto a tela ainda mostra o dia corrente. A lista tirava os
   * dias da view (UTC) e o modal de recebimento calculava em hora local: a
   * mesma cobrança aparecia com "31d" ao lado do vencimento e "30 dias de
   * atraso" dentro do modal, cobrando juros de 30.
   */
  test('a data do negócio é a data local, não a do servidor', async () => {
    // `fn_business_today` passou a exigir o tenant: o dia do negócio é dele, não
    // um fuso cravado no banco (migration `fuso_horario_por_tenant`).
    const { data } = await admin().rpc('fn_business_today', { p_tenant_id: tenantId })
    expect(data, 'fn_business_today precisa concordar com o relógio do operador').toBe(hoje())
  })

  test('os dias de atraso da view batem com os do encargo', async () => {
    const { chargeId } = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate: daquiA(-10),
      sourceModule: 'manual',
      sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Dias ${Date.now().toString(36)}`,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 500, amount: 500,
      }],
    })

    const { data } = await admin()
      .from('charge_balances')
      .select('days_overdue, open_amount, paid_amount, late_charge_amount, due_date, status, late_charge_policy_id')
      .eq('charge_id', chargeId).single()

    const b = data as {
      days_overdue: number; open_amount: number; paid_amount: number
      late_charge_amount: number; due_date: string
      status: string; late_charge_policy_id: string
    }

    const { data: pol } = await admin()
      .from('late_charge_policies')
      .select('fee_type, fee_value, daily_interest_rate, grace_period_days, min_amount')
      .eq('id', b.late_charge_policy_id).single()

    // `calculateAmountDue` conta em hora LOCAL; a view contava em UTC.
    const { accrued } = calculateAmountDue(b, pol as LateChargePolicy)
    expect(b.days_overdue, 'view e encargo precisam contar os mesmos dias')
      .toBe(accrued.days_overdue)
    expect(b.days_overdue).toBe(10)
  })
})

test.describe('Empresa sem política — encargo é zero, e a tela diz isso', () => {
  /**
   * Empresa nova nasce SEM política: `create_tenant_with_owner` não cria
   * nenhuma, e o back-fill da migration de políticas só alcançou os tenants que
   * existiam naquele momento. Este é o estado normal de quem acabou de se
   * cadastrar, e ele precisa significar exatamente uma coisa — não cobrar nada.
   *
   * `Empresa Teste 2` do seed está nesse estado e serve de cobaia.
   */
  const TENANT_SEM_POLITICA = '00000000-0000-0000-0000-000000000002'
  const lixo: { tabela: string; id: string }[] = []

  test.afterAll(async () => {
    for (const { tabela, id } of [...lixo].reverse()) {
      await admin().from(tabela).delete().eq('id', id)
    }
  })

  test('cobrança vencida há 60 dias não acumula multa nem juros', async () => {
    const sufixo = Date.now().toString(36)

    const semear = async (tabela: string, payload: Record<string, unknown>) => {
      const { data, error } = await admin().from(tabela).insert(payload).select('id').single()
      if (error) throw new Error(`${tabela}: ${error.message}`)
      const id = (data as { id: string }).id
      lixo.push({ tabela, id })
      return id
    }

    // A empresa não pode ter política — se um dia ganhar uma, este teste passa
    // a medir outra coisa e precisa saber disso.
    const { count } = await admin()
      .from('late_charge_policies')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', TENANT_SEM_POLITICA)
    expect(count, 'a cobaia precisa estar sem política').toBe(0)

    const clienteId = await semear('customers', {
      tenant_id: TENANT_SEM_POLITICA, name: `${TEST_TAG} SemPolitica ${sufixo}`, in_queue: false,
    })
    const veiculoId = await semear('vehicles', {
      tenant_id: TENANT_SEM_POLITICA,
      license_plate: `SP${sufixo.slice(-5).toUpperCase()}`,
      acquisition_type: 'used',
    })
    const locacaoId = await semear('rentals', {
      tenant_id: TENANT_SEM_POLITICA, customer_id: clienteId, vehicle_id: veiculoId,
    })

    const { chargeId } = await createCharge(admin(), TENANT_SEM_POLITICA, {
      customerId: clienteId, rentalId: locacaoId,
      dueDate: daquiA(-60),
      sourceModule: 'manual',
      sourceId: crypto.randomUUID(),
      items: [{
        description: `${TEST_TAG} Sem encargo ${sufixo}`,
        credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 1000, amount: 1000,
      }],
    })
    lixo.push({ tabela: 'charges', id: chargeId })

    const { data: c } = await admin()
      .from('charges').select('late_charge_policy_id').eq('id', chargeId).single()
    expect((c as { late_charge_policy_id: string | null }).late_charge_policy_id,
      'sem política do tenant, a cobrança não pode apontar para nenhuma').toBeNull()

    const { data: bal } = await admin()
      .from('charge_balances')
      .select('open_amount, paid_amount, late_charge_amount, due_date, status, days_overdue, late_charge_policy_id')
      .eq('charge_id', chargeId).single()

    const b = bal as {
      open_amount: number; paid_amount: number; late_charge_amount: number
      due_date: string; status: string
      days_overdue: number; late_charge_policy_id: string | null
    }

    // Vencida de verdade — o que segue não é "não venceu ainda".
    expect(b.days_overdue).toBeGreaterThan(55)

    const { accrued, amount_due } = calculateAmountDue(b, null)
    expect(accrued.total, 'sem política não há encargo a acumular').toBe(0)
    expect(amount_due, 'o cliente deve o valor original, e só').toBe(1000)
  })

  test('a tela avisa que nada está sendo cobrado, em vez de sugerir 2%', async ({ page }) => {
    // O formulário nascia com 2% e 1% ao mês preenchidos quando não havia
    // política — os valores de mercado. Quem abria a tela lia configuração
    // onde não havia nenhuma.
    await page.goto('/configuracoes/encargos')
    await waitForPageLoad(page)

    const secao = page.locator('section').filter({ hasText: 'Encargo por atraso' })
    await expect(secao).toBeVisible({ timeout: 10_000 })

    // A empresa de teste TEM política, então aqui o aviso não pode aparecer —
    // é o par de controle do caso acima.
    await expect(secao.getByText(/Nenhum encargo configurado/i)).toHaveCount(0)
    await expect(secao.getByText(/Em vigor · versão \d+/)).toBeVisible()
  })
})

test.describe('Composição da cobrança', () => {
  /**
   * A tela de detalhe carregava `charge_items` e só os usava para escolher o
   * título. Quem abria uma cobrança via o total e nada do que o forma: nem o
   * principal, nem o encargo realizado, nem o quanto já foi abatido. Conta que
   * não se abre não se confere — só se acredita.
   */
  test('a tela abre o que forma o total e o que já foi abatido', async ({ page }) => {
    const marca = `${TEST_TAG} Composicao ${Date.now().toString(36)}`
    const { chargeId } = await createCharge(admin(), tenantId, {
      customerId, rentalId,
      dueDate: daquiA(-15),
      sourceModule: 'manual', sourceId: crypto.randomUUID(),
      items: [{
        description: marca, credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 400, amount: 400,
      }],
    })

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)

    const composicao = page.locator('section').filter({ hasText: 'Composição' })
    await expect(composicao).toBeVisible({ timeout: 10_000 })

    // O item que forma a cobrança, com origem legível — não o código cru.
    await expect(composicao.getByText(marca)).toBeVisible()
    await expect(composicao.getByText('R$ 400,00').first()).toBeVisible()
    await expect(composicao.getByText('Total emitido')).toBeVisible()
    await expect(composicao.getByText('A pagar')).toBeVisible()

    // Vencida: o encargo ainda é PROJEÇÃO e precisa aparecer como tal, senão o
    // total emitido não bate com o "a pagar" do topo e a conta parece errada.
    await expect(composicao.getByText(/Encargo previsto/)).toBeVisible()
    await expect(composicao.getByText(/ainda não lançado/)).toBeVisible()
  })
})

test.describe('Motivo do cancelamento e da baixa', () => {
  /**
   * Cancelar e dar baixa EXIGEM justificativa, e `cancelCharge`/`writeOffCharge`
   * gravam em `charges.cancellation_reason`. Nenhuma tela lia a coluna: o
   * operador escrevia para o nada, e depois não havia como saber por que
   * aquela cobrança tinha sido encerrada.
   */
  async function cobrancaSimples(marca: string) {
    const { chargeId } = await createCharge(admin(), tenantId, {
      customerId, rentalId, dueDate: hoje(),
      sourceModule: 'manual', sourceId: crypto.randomUUID(),
      items: [{
        description: marca, credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 250, amount: 250,
      }],
    })
    return chargeId
  }

  test('cobrança cancelada mostra o motivo digitado', async ({ page }) => {
    const run = Date.now().toString(36)
    const chargeId = await cobrancaSimples(`${TEST_TAG} Cancelada ${run}`)
    const motivo = `Cobrança em duplicidade ${run}`

    // Pelo caminho real: é `cancelCharge` que a Server Action chama.
    await cancelCharge(admin(), tenantId, chargeId, motivo)

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)

    await expect(
      page.getByText('Motivo do cancelamento'),
      'o rótulo precisa existir para a cobrança cancelada',
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(motivo)).toBeVisible()
  })

  test('baixa por inadimplência mostra o motivo, com o rótulo certo', async ({ page }) => {
    const run = Date.now().toString(36)
    const chargeId = await cobrancaSimples(`${TEST_TAG} Baixada ${run}`)
    const motivo = `Cliente inadimplente há 90 dias ${run}`

    await writeOffCharge(admin(), tenantId, chargeId, motivo)

    await page.goto(`/cobrancas/${chargeId}`)
    await waitForPageLoad(page)

    // Baixa não é cancelamento: o rótulo acompanha o desfecho.
    await expect(page.getByText('Motivo da baixa')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Motivo do cancelamento')).toHaveCount(0)
    await expect(page.getByText(motivo)).toBeVisible()
  })
})
