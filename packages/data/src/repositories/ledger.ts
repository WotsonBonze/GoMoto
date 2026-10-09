/**
 * Leituras do domínio financeiro (Spec 0014).
 *
 * Tudo aqui consulta VIEW, nunca tabela: saldo, atraso e inadimplência são
 * derivados (Princípios 2 e 4). Nenhuma função deste arquivo replica cálculo
 * financeiro — a aritmética vive em @gomoto/core.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACCOUNTS, type ScheduleLineChargeRow, type TerminationChargeInfo } from '@gomoto/core'

// ============================================================
// Tipos das views
// ============================================================

export type ChargeBalanceRow = {
  charge_id: string
  tenant_id: string
  customer_id: string
  rental_id: string | null
  charge_number: number
  status: 'open' | 'paid' | 'cancelled' | 'written_off'
  issue_date: string
  due_date: string
  currency: string
  total_amount: number
  paid_amount: number
  open_amount: number
  is_overdue: boolean
  days_overdue: number
  /** Quanto do total já virou item de encargo. Encargo realizado é parcela do
   *  encargo corrente, não base para um novo (ADR 0028). */
  late_charge_amount: number
  /** Política congelada na emissão. Sem ela a tela não tem como saber qual
   *  regra esta cobrança carrega, e acaba aplicando a vigente hoje a todas. */
  late_charge_policy_id: string | null
  /** Origem da cobrança (`rental`, `down_payment`, `expense`, `early_termination_fine`…). */
  source_module: string
}

export type ChargeItemRow = {
  id: string
  charge_id: string
  description: string
  credit_account_code: string
  quantity: number
  unit_amount: number
  amount: number
  source_module: string
  source_id: string | null
  vehicle_id: string | null
}

export type CustomerDelinquencyRow = {
  tenant_id: string
  customer_id: string
  overdue_count: number
  max_days_overdue: number
  overdue_amount: number
  oldest_due_date: string
}

export type VehiclePositionRow = {
  tenant_id: string
  vehicle_id: string
  operating_revenue: number | null
  gross_costs: number | null
  reimbursed: number | null
  net_result: number | null
  maintenance_cost: number | null
  documentation_cost: number | null
  insurance_cost: number | null
  fines_cost: number | null
  acquisition_cost: number | null
  accumulated_depreciation: number | null
}

export type IncomeStatementRow = {
  tenant_id: string
  branch_id: string | null
  period: string
  report_line_code: string
  in_tax_base: boolean
  amount: number
}

export type RentalResultRow = {
  tenant_id: string
  rental_id: string
  revenue: number | null
  costs: number | null
  reimbursed: number | null
  net_result: number | null
}

export type ScheduleRow = {
  id: string
  rental_id: string
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
  status: 'scheduled' | 'issued' | 'cancelled' | 'superseded'
  charge_id: string | null
}

// ============================================================
// Cobranças
// ============================================================

/** Cobranças em aberto de um cliente, da mais antiga para a mais nova. */
export async function listOpenCharges(
  client: SupabaseClient,
  customerId: string,
): Promise<ChargeBalanceRow[]> {
  const { data, error } = await client
    .from('charge_balances')
    .select('*')
    .eq('customer_id', customerId)
    .eq('status', 'open')
    .gt('open_amount', 0)
    .order('due_date', { ascending: true })

  if (error) throw error
  return (data ?? []) as ChargeBalanceRow[]
}

export async function getChargeBalance(
  client: SupabaseClient,
  chargeId: string,
): Promise<ChargeBalanceRow | null> {
  const { data, error } = await client
    .from('charge_balances')
    .select('*')
    .eq('charge_id', chargeId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as ChargeBalanceRow | null
}

export async function listChargeItems(
  client: SupabaseClient,
  chargeId: string,
): Promise<ChargeItemRow[]> {
  const { data, error } = await client
    .from('charge_items')
    .select('*')
    .eq('charge_id', chargeId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as ChargeItemRow[]
}

/**
 * Contas a receber: emitido e não pago.
 *
 * NÃO inclui o cronograma futuro — isso é carteira contratada, outra métrica
 * (F-10). No modelo antigo, um rent-to-own de 2 anos entrava inteiro aqui no
 * dia da assinatura.
 */
export async function listReceivables(
  client: SupabaseClient,
): Promise<ChargeBalanceRow[]> {
  const { data, error } = await client
    .from('charge_balances')
    .select('*')
    .eq('status', 'open')
    .gt('open_amount', 0)
    .order('due_date', { ascending: true })

  if (error) throw error
  return (data ?? []) as ChargeBalanceRow[]
}

export type ChargeListRow = ChargeBalanceRow & {
  customer_name: string
  customer_phone: string | null
  vehicle_plate: string | null
  primary_description: string
  /** Cobrança de caução — passivo, não receita. Ver `is_deposit` no map abaixo. */
  is_deposit: boolean
}

/**
 * Listagem para o cockpit: saldo da view enriquecido com cliente, veículo e
 * descrição do item principal.
 *
 * Duas consultas em vez de join na view: `charge_balances` já agrega por
 * cobrança, e juntar `charge_items` ali dentro reintroduziria o fan-out que o
 * redesenho eliminou (F-01).
 */
/**
 * Busca em lotes por uma lista de ids, checando o erro de cada lote.
 *
 * PostgREST recebe `in.(...)` na QUERY STRING, e o Kong recusa URI acima de
 * ~8 KB com **414**. Um UUID ocupa ~37 bytes codificado: passando de ~200 ids
 * a requisição estoura. Como o resultado era lido com `?? []`, o 414 virava
 * lista vazia em silêncio — na tela de cobranças, TODA linha perdia descrição,
 * nome do cliente e placa, exibindo só o rótulo genérico "Cobrança".
 *
 * Não é hipótese de escala distante: aconteceu com 258 cobranças.
 */
export async function fetchByIdsInChunks<T>(
  ids: string[],
  column: string,
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const CHUNK = 100
  const out: T[] = []

  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await run(ids.slice(i, i + CHUNK))
    // Erro engolido aqui degrada a tela inteira sem sinal nenhum.
    if (error) throw new Error(`Falha ao buscar por ${column}: ${error.message}`)
    out.push(...(data ?? []))
  }

  return out
}

export async function listChargesForCockpit(
  client: SupabaseClient,
): Promise<ChargeListRow[]> {
  const { data: balances, error } = await client
    .from('charge_balances')
    .select('*')
    .order('due_date', { ascending: true })

  if (error) throw error
  const rows = (balances ?? []) as ChargeBalanceRow[]
  if (rows.length === 0) return []

  const chargeIds = rows.map((r) => r.charge_id)
  const customerIds = [...new Set(rows.map((r) => r.customer_id))]
  const rentalIds = [...new Set(rows.map((r) => r.rental_id).filter(Boolean))] as string[]

  type ItemRow = {
    charge_id: string; description: string; amount: number
    credit_account_code: string; source_module: string
  }
  type CustomerRow = { id: string; name: string; phone: string | null }

  const [items, customers, rentals] = await Promise.all([
    fetchByIdsInChunks<ItemRow>(chargeIds, 'charge_id', (chunk) =>
      client.from('charge_items')
        .select('charge_id, description, amount, credit_account_code, source_module')
        .in('charge_id', chunk)),
    fetchByIdsInChunks<CustomerRow>(customerIds, 'customer_id', (chunk) =>
      client.from('customers').select('id, name, phone').in('id', chunk)),
    fetchByIdsInChunks<unknown>(rentalIds, 'rental_id', (chunk) =>
      client.from('rentals').select('id, vehicles(license_plate)').in('id', chunk)),
  ])

  const itemsByCharge = new Map<string, ItemRow[]>()
  for (const i of items) {
    const list = itemsByCharge.get(i.charge_id) ?? []
    list.push(i)
    itemsByCharge.set(i.charge_id, list)
  }

  const customerById = new Map(customers.map((c) => [c.id, c]))

  // `rentals.vehicle_id → vehicles.id` é muitos-para-um, então o PostgREST
  // devolve objeto; a inferência do supabase-js supõe array. Tratamos as duas
  // formas para não depender dessa suposição.
  type RentalVehicle = { id: string; vehicles: { license_plate: string } | { license_plate: string }[] | null }

  const plateByRental = new Map(
    (rentals as RentalVehicle[]).map((r) => {
      const v = Array.isArray(r.vehicles) ? r.vehicles[0] : r.vehicles
      return [r.id, v?.license_plate ?? null] as const
    }),
  )

  return rows.map((r) => {
    const items = itemsByCharge.get(r.charge_id) ?? []
    // Uma cobrança cobra uma coisa só (ADR 0024): a descrição é a do item, sem
    // eleição por maior valor. O que pode haver a mais são ACESSÓRIOS da mesma
    // dívida — encargo por atraso e desconto —, que a trigger
    // `fn_assert_charge_item_origin` já trata como a mesma categoria (nunca é
    // "outra coisa sendo cobrada"). Filtrar por `source_module` em vez de
    // prefixo de texto na descrição: um desconto cuja descrição comece
    // diferente de "Encargo" passava no filtro antigo e, sem `ORDER BY`,
    // podia virar a "descrição" exibida da cobrança.
    const principal = items.find((i) => i.source_module !== 'late_charge' && i.source_module !== 'discount')
      ?? items[0]
    const customer = customerById.get(r.customer_id)

    return {
      ...r,
      customer_name: customer?.name ?? '—',
      customer_phone: customer?.phone ?? null,
      vehicle_plate: r.rental_id ? plateByRental.get(r.rental_id) ?? null : null,
      primary_description: principal?.description ?? 'Cobrança',
      // Caução é dinheiro de terceiro: entra no caixa e um dia sai. Some com
      // aluguel num total de "recebido", a tela mostra um mês bom que na
      // verdade foi só depósito. A regra de origem única (ADR 0024) garante que
      // a cobrança é inteira de caução ou nada dela é.
      is_deposit: items.length > 0
        && items.every((i) => i.credit_account_code === ACCOUNTS.DEPOSITS_PAYABLE),
    }
  })
}

/** Cobranças em aberto e vencidas — base do aging. */
export async function listOverdueCharges(
  client: SupabaseClient,
): Promise<ChargeBalanceRow[]> {
  const { data, error } = await client
    .from('charge_balances')
    .select('*')
    .eq('is_overdue', true)
    .order('days_overdue', { ascending: false })

  if (error) throw error
  return (data ?? []) as ChargeBalanceRow[]
}

// ============================================================
// Inadimplência
// ============================================================

/** Ausência de linha significa cliente em dia — não é erro. */
export async function getCustomerDelinquency(
  client: SupabaseClient,
  customerId: string,
): Promise<CustomerDelinquencyRow | null> {
  const { data, error } = await client
    .from('customer_delinquency')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as CustomerDelinquencyRow | null
}

export async function listDelinquentCustomers(
  client: SupabaseClient,
): Promise<CustomerDelinquencyRow[]> {
  const { data, error } = await client
    .from('customer_delinquency')
    .select('*')
    .order('max_days_overdue', { ascending: false })

  if (error) throw error
  return (data ?? []) as CustomerDelinquencyRow[]
}

// ============================================================
// Saldos
// ============================================================

export async function getDepositBalance(
  client: SupabaseClient,
  rentalId: string,
): Promise<number> {
  const { data, error } = await client
    .from('deposit_balances')
    .select('balance')
    .eq('rental_id', rentalId)
    .maybeSingle()

  if (error) throw error
  return (data as { balance: number } | null)?.balance ?? 0
}

export async function getCustomerCreditBalance(
  client: SupabaseClient,
  customerId: string,
): Promise<number> {
  const { data, error } = await client
    .from('customer_credit_balances')
    .select('balance')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error) throw error
  return (data as { balance: number } | null)?.balance ?? 0
}

// ============================================================
// Posição do veículo e resultado da locação
// ============================================================

export async function getVehiclePosition(
  client: SupabaseClient,
  vehicleId: string,
): Promise<VehiclePositionRow | null> {
  const { data, error } = await client
    .from('vehicle_financial_position')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as VehiclePositionRow | null
}

export async function listVehiclePositions(
  client: SupabaseClient,
): Promise<VehiclePositionRow[]> {
  const { data, error } = await client.from('vehicle_financial_position').select('*')
  if (error) throw error
  return (data ?? []) as VehiclePositionRow[]
}

export async function getRentalResult(
  client: SupabaseClient,
  rentalId: string,
): Promise<RentalResultRow | null> {
  const { data, error } = await client
    .from('rental_financial_result')
    .select('*')
    .eq('rental_id', rentalId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as RentalResultRow | null
}

// ============================================================
// DRE
// ============================================================

/**
 * Linhas do demonstrativo no período, já resolvidas pela política do tenant
 * vigente na data de cada fato (ADR 0024, Princípio 6).
 */
export async function listIncomeStatement(
  client: SupabaseClient,
  fromPeriod: string,
  toPeriod: string,
): Promise<IncomeStatementRow[]> {
  const { data, error } = await client
    .from('income_statement')
    .select('*')
    .gte('period', fromPeriod)
    .lte('period', toPeriod)
    .order('period', { ascending: true })

  if (error) throw error
  return (data ?? []) as IncomeStatementRow[]
}

// ============================================================
// Cronograma
// ============================================================

export async function listRentalSchedule(
  client: SupabaseClient,
  rentalId: string,
): Promise<ScheduleRow[]> {
  const { data, error } = await client
    .from('rental_billing_schedules')
    .select('*')
    .eq('rental_id', rentalId)
    // Cronológica: depois de um ajuste de período (ADR 0035) a numeração das
    // linhas novas continua de onde parou, então ela deixa de ser ordem de
    // tempo.
    .order('period_start', { ascending: true })
    .order('sequence_number', { ascending: true })

  if (error) throw error
  return (data ?? []) as ScheduleRow[]
}

/**
 * Cobranças de ciclo emitidas de uma locação, com o saldo (`charge_balances`)
 * de cada uma — inclusive `is_overdue`, que só a view sabe calcular
 * (`fn_business_today`, não o relógio do browser).
 *
 * Mesmo vínculo que `loadPeriodAdjustmentContext` usa (apps/web): a origem da
 * cobrança de ciclo é a LINHA do cronograma, não a locação —
 * `charges.source_module='rental'` + `charges.source_id = <id da linha>`
 * (migration `charge_single_origin`; `rental_billing_schedules.charge_id` foi
 * derrubada na mesma migration).
 *
 * Usado junto com `useRentalSchedule` (que já traz TODAS as linhas, qualquer
 * status) pela tela de Encerramento — `planRetroactiveTermination`
 * (@gomoto/core) decide o que fazer com cada uma, não este repositório.
 */
export async function listRentalIssuedChargeInfo(
  client: SupabaseClient,
  rentalId: string,
): Promise<TerminationChargeInfo[]> {
  const [
    { data: chargeRows, error: chargeError },
    { data: balanceRows, error: balanceError },
  ] = await Promise.all([
    client
      .from('charges')
      .select('id, source_id, charge_number, due_date, status')
      .eq('rental_id', rentalId)
      .eq('source_module', 'rental'),
    client
      .from('charge_balances')
      .select('charge_id, total_amount, paid_amount, is_overdue')
      .eq('rental_id', rentalId),
  ])

  if (chargeError) throw chargeError
  if (balanceError) throw balanceError

  const balanceById = new Map(
    ((balanceRows ?? []) as Array<{ charge_id: string; total_amount: number; paid_amount: number; is_overdue: boolean }>)
      .map((b) => [b.charge_id, b]),
  )

  return (
    (chargeRows ?? []) as Array<{
      id: string
      source_id: string | null
      charge_number: number
      due_date: string
      status: ScheduleLineChargeRow['status']
    }>
  )
    .filter((c) => c.source_id !== null)
    .map((c) => {
      const balance = balanceById.get(c.id)
      return {
        schedule_line_id: c.source_id!,
        charge_id:        c.id,
        charge_number:    Number(c.charge_number),
        due_date:         c.due_date,
        total_amount:     Number(balance?.total_amount ?? 0),
        paid_amount:      Number(balance?.paid_amount ?? 0),
        status:           c.status,
        is_overdue:       Boolean(balance?.is_overdue ?? false),
      }
    })
}

// ============================================================
// Política
// ============================================================

export type LateChargePolicyRow = {
  id: string
  version: number
  effective_from: string
  fee_type: 'fixed' | 'percentage'
  fee_value: number
  daily_interest_rate: number
  grace_period_days: number
  min_amount: number
}

/**
 * NÃO existe "a política vigente" para uma cobrança já emitida.
 *
 * Havia aqui `getActiveLateChargePolicy(client, hoje)`, e os quatro hooks que
 * mostram encargo a chamavam: aplicavam a política de HOJE a todas as linhas,
 * enquanto cada cobrança carrega a sua em `late_charge_policy_id`. Com uma
 * versão só na base ninguém notava; a segunda fez a mesma cobrança valer R$ 35
 * de multa fixa na lista e 2% na tela de detalhe.
 *
 * Quem precisa da política de uma cobrança usa `listLateChargePolicies` e
 * indexa por id. Quem EMITE não resolve no TypeScript: `fn_create_charge` e
 * `issue_due_charges` chamam `fn_late_charge_policy_at` na data de emissão.
 */

/**
 * Todas as versões da política, da mais nova para a mais antiga.
 *
 * Mesma ordenação que `resolveLateChargePolicy` usa na emissão
 * (`effective_from DESC, version DESC`): a tela precisa concordar com quem
 * decide o que é cobrado, senão exibe "em vigor" uma regra que não está.
 */
export async function listLateChargePolicies(
  client: SupabaseClient,
): Promise<LateChargePolicyRow[]> {
  const { data, error } = await client
    .from('late_charge_policies')
    .select('id, version, effective_from, fee_type, fee_value, daily_interest_rate, grace_period_days, min_amount')
    .order('effective_from', { ascending: false })
    .order('version', { ascending: false })

  if (error) throw error
  return (data ?? []) as LateChargePolicyRow[]
}

export type DelinquencyPolicyRow = {
  id: string
  version: number
  effective_from: string
  late_days: number
  delinquent_count: number
  delinquent_days: number
  blocked_count: number
  blocked_days: number
  auto_block: boolean
}

export async function getActiveDelinquencyPolicy(
  client: SupabaseClient,
  onDate: string,
): Promise<DelinquencyPolicyRow | null> {
  const { data, error } = await client
    .from('delinquency_policies')
    .select('*')
    .lte('effective_from', onDate)
    .order('effective_from', { ascending: false })
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as DelinquencyPolicyRow | null
}

// ============================================================
// Contas a pagar
// ============================================================

export type PayableRow = {
  id: string
  tenant_id: string
  description: string
  expense_account_code: string
  competence_date: string
  due_date: string
  amount: number
  status: 'open' | 'paid' | 'cancelled'
  paid_at: string | null
  responsibility: 'company' | 'customer' | 'shared'
  customer_id: string | null
  customer_amount: number
  reimbursement: 'none' | 'charge' | 'credit'
  vehicle_id: string | null
  rental_id: string | null
  vendor_name: string | null
  source_module: string
  /**
   * Registro de origem: a manutenção, a multa, a obrigação do veículo.
   * A consulta é `select('*')` e sempre trouxe o campo — só o tipo o omitia, e
   * por isso a tela de manutenção não conseguia ligar a conta a pagar de volta
   * ao serviço para mostrar o custo.
   */
  source_id: string | null
  attachment_url: string | null
  created_at: string
}

export async function listPayables(client: SupabaseClient): Promise<PayableRow[]> {
  const { data, error } = await client
    .from('payables')
    .select('*')
    .order('competence_date', { ascending: false })

  if (error) throw error
  return (data ?? []) as PayableRow[]
}

// ============================================================
// Gateway de pagamento
// ============================================================

export type ProviderAccountRow = {
  id: string
  provider: string
  external_account_id: string
  account_label: string | null
  is_default: boolean
  active: boolean
}

/**
 * Contas de gateway do tenant (ADR 0030).
 *
 * Inclui as INATIVAS: a tela precisa mostrar "Mercado Pago — desconectado" com
 * botão de reconectar, e não fingir que a integração nunca existiu. Quem filtra
 * por `is_default AND active` é quem vai cobrar, não quem vai desenhar.
 *
 * `secret_id` fica fora do select e fora do GRANT: a credencial mora no Vault e
 * só sai por `fn_provider_credentials`, server-side. `account_label` entrou —
 * era gravado pelo callback e ninguém podia ler, então a tela exibia o
 * identificador interno da conta no lugar do rótulo.
 */
export async function listProviderAccounts(
  client: SupabaseClient,
): Promise<ProviderAccountRow[]> {
  const { data, error } = await client
    .from('payment_provider_accounts')
    .select('id, provider, external_account_id, account_label, is_default, active')
    .order('is_default', { ascending: false })
    .order('provider', { ascending: true })

  if (error) throw error
  return (data ?? []) as ProviderAccountRow[]
}

/**
 * Status de uma tentativa de pagamento.
 *
 * Sinal mais barato e mais direto de "o cliente pagou": é esta linha que
 * `fn_confirm_gateway_payment` marca como `paid`, na mesma transação que grava
 * o recebimento e lança no razão. Uma leitura de linha única por chave, contra
 * recarregar a cobrança inteira (saldo + itens + política) a cada 5 segundos.
 */
export async function getPaymentIntentStatus(
  client: SupabaseClient,
  intentId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('payment_intents')
    .select('status')
    .eq('id', intentId)
    .maybeSingle()

  if (error) throw error
  return (data as { status: string } | null)?.status ?? null
}

/**
 * Cobranças em aberto de uma LOCAÇÃO.
 *
 * Distinta de `listOpenCharges`, que é por cliente: a apuração de encerramento
 * precisa do que pertence àquela locação, sem depender de o componente ter o
 * `customer_id` em mãos.
 */
export async function listOpenChargesByRental(
  client: SupabaseClient,
  rentalId: string,
): Promise<ChargeBalanceRow[]> {
  const { data, error } = await client
    .from('charge_balances')
    .select('*')
    .eq('rental_id', rentalId)
    .eq('status', 'open')
    .gt('open_amount', 0)
    .order('due_date', { ascending: true })

  if (error) throw error
  return (data ?? []) as ChargeBalanceRow[]
}
