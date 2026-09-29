import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { formatCurrency } from '@/lib/utils'
import {
  calculateVehiclePayback,
  deductPassThrough,
  summarizeExpenseResponsibility,
  summarizeVehicleIncome,
  summarizeVehicleReceivables,
  type ChargeItemKind,
  type IncomeCharge,
  type PayableShare,
  type ReceivableCharge,
  type ScheduledLine,
} from '@gomoto/core'
import { VehicleFinancialActions } from './_components/VehicleFinancialActions'
import { SegmentedBar, Stat } from './_components/FinancialBlocks'
import {
  VehicleCostBreakdownChart,
  VehicleIncomeBreakdownChart,
  VehicleMonthlyChart,
  VehiclePaybackChart,
  type CostCategory,
  type MonthlyPoint,
} from './_components/VehicleFinancialCharts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: string | null | undefined) {
  if (!d) return '—'
  const date = d.includes('T') ? new Date(d) : new Date(d + 'T12:00:00')
  return date.toLocaleDateString('pt-BR')
}

const MONTH_LABEL = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' })
const PCT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

function monthLabelOf(key: string) {
  const [year, month] = key.split('-').map(Number)
  return MONTH_LABEL.format(new Date(year, month - 1, 1))
}

function fmtPct(n: number) {
  return `${PCT.format(n)}%`
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function VehicleROIPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const [vehicleResult, expensesResult, rentalsResult, positionResult, companyPaidResult] = await Promise.all([
    supabase
      .from('vehicles')
      .select('id, license_plate, make, model, year_manufacture, color, acquisition_amount, sale_value, sold_at, created_at')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single(),
    // Despesas do veículo: alimentam o rateio empresa × cliente, o total
    // investido e a composição por categoria — a tela não lista lançamento a
    // lançamento. Categoria vem de `financial_accounts.name`, não de
    // `source_module` ('expense' cobre documentação, seguro e despesa avulsa,
    // não só manutenção). Abertas entram junto com as pagas — a empresa já se
    // comprometeu com o gasto; cancelada não é custo de ninguém.
    supabase
      .from('payables')
      .select('id, amount, status, competence_date, source_module, source_id, expense_account_code, financial_accounts(name)')
      .eq('vehicle_id', id)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled'),
    // Locações do veículo: ocupação, histórico e a ponte até as cobranças
    // (`charges` não tem vehicle_id).
    supabase
      .from('rentals')
      .select('id, start_date, end_date, status, cycle_amount, customers(name)')
      .eq('vehicle_id', id)
      .eq('tenant_id', tenantId)
      .order('start_date', { ascending: false }),
    // Quanto foi repassado ao cliente neste veículo (contas de repasse do razão):
    // multa cobrada dele, rateio de manutenção, custo que ele bancou. É daí que
    // sai "quem arca" — `payables.customer_amount` não serve, porque a multa do
    // cliente é lançada como despesa 100% da empresa e a responsabilidade dele
    // só existe na cobrança de repasse.
    supabase
      .from('vehicle_financial_position')
      .select('reimbursed')
      .eq('vehicle_id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    // Contas a pagar em que a EMPRESA deve ao fornecedor: o razão lança a dívida
    // (`contas_a_pagar`, crédito) só nesse caso. Quando o cliente levou o veículo
    // à oficina e pagou, a conta nasce já paga e essa perna não existe — nenhum
    // dinheiro da empresa saiu, então não entra no investido.
    supabase
      .from('financial_entries')
      .select('payable_id')
      .eq('vehicle_id', id)
      .eq('tenant_id', tenantId)
      .eq('account_code', 'contas_a_pagar')
      .eq('direction', 'credit')
      .not('payable_id', 'is', null),
  ])

  if (vehicleResult.error || !vehicleResult.data) notFound()

  const vehicle = vehicleResult.data

  type ExpenseRow = {
    id: string; amount: number; status: 'open' | 'paid' | 'cancelled'
    competence_date: string; source_module: string; source_id: string | null
    expense_account_code: string; financial_accounts: { name: string } | null
  }
  const expenses = (expensesResult.data ?? []) as unknown as ExpenseRow[]

  const customerBears = Number((positionResult.data as { reimbursed: number } | null)?.reimbursed ?? 0)
  const companyPaidIds = new Set(
    ((companyPaidResult.data ?? []) as unknown as { payable_id: string }[]).map((e) => e.payable_id),
  )

  type RentalRow = {
    id: string; start_date: string | null; end_date: string | null; status: string
    cycle_amount: number | null; customers: { name: string } | null
  }
  const rentals = (rentalsResult.data ?? []) as unknown as RentalRow[]

  // ── Recebíveis e pagamentos ───────────────────────────────────────────────
  // Segunda etapa: depende dos ids das locações. Cronograma só das locações
  // ativas — linha `scheduled` de locação encerrada é plano que não vira cobrança.
  const rentalIds = rentals.map((r) => r.id)
  const activeRentalIds = rentals.filter((r) => r.status === 'active').map((r) => r.id)
  const hasActiveRental = activeRentalIds.length > 0
  const activeRental = rentals.find((r) => r.status === 'active')

  const [chargesResult, scheduleResult, allocationsResult, chargeItemsResult] = await Promise.all([
    rentalIds.length
      ? supabase
          .from('charge_balances')
          .select('charge_id, status, due_date, total_amount, paid_amount, open_amount, is_overdue, days_overdue')
          .eq('tenant_id', tenantId)
          .in('rental_id', rentalIds)
      : Promise.resolve({ data: [] }),
    hasActiveRental
      ? supabase
          .from('rental_billing_schedules')
          .select('due_date, amount')
          .eq('tenant_id', tenantId)
          .eq('status', 'scheduled')
          .in('rental_id', activeRentalIds)
      : Promise.resolve({ data: [] }),
    // Dinheiro que entrou, com a data: alocação de pagamento não estornado a
    // cobrança não cancelada das locações deste veículo. Alocação (e não o valor
    // do pagamento) porque um pagamento pode quitar cobranças de outros veículos.
    rentalIds.length
      ? supabase
          .from('payment_allocations')
          .select('amount, charge_id, payments!inner(paid_at, reversed_at, method), charges!inner(rental_id, status)')
          .eq('tenant_id', tenantId)
          .in('charges.rental_id', rentalIds)
          .neq('charges.status', 'cancelled')
          .is('payments.reversed_at', null)
      : Promise.resolve({ data: [] }),
    // Composição das cobranças: cada item traz a natureza da conta (receita,
    // repasse ou passivo — caução) e, se for repasse, a despesa de origem.
    rentalIds.length
      ? supabase
          .from('charges')
          .select('id, status, charge_items(amount, credit_account_code, source_module, source_id, financial_accounts(kind, name))')
          .eq('tenant_id', tenantId)
          .in('rental_id', rentalIds)
      : Promise.resolve({ data: [] }),
  ])

  type ChargeItemRow = {
    amount: number; credit_account_code: string; source_module: string; source_id: string | null
    financial_accounts: { kind: string; name: string } | null
  }
  const chargeRows = ((chargeItemsResult.data ?? []) as unknown as {
    id: string; status: 'open' | 'paid' | 'cancelled' | 'written_off'; charge_items: ChargeItemRow[]
  }[])

  // Conta de receita ou repasse → conta pela moto. Só passivo (caução) →
  // cobrança inteira fora de tudo (ADR 0024: origem única por cobrança).
  const ACCOUNT_KIND_TO_ITEM_KIND: Record<string, ChargeItemKind> = {
    revenue: 'revenue',
    reimbursement: 'reimbursement',
  }
  const nonRevenueChargeIds = new Set(
    chargeRows
      .filter((c) => !c.charge_items.some((i) => i.financial_accounts?.kind === 'revenue' || i.financial_accounts?.kind === 'reimbursement'))
      .map((c) => c.id),
  )

  // numeric chega do PostgREST como número, mas Number() protege contra string.
  const chargeBalanceRows = (chargesResult.data ?? []) as unknown as (ReceivableCharge & { charge_id: string })[]
  const receivableCharges: ReceivableCharge[] = chargeBalanceRows
    .filter((c) => !nonRevenueChargeIds.has(c.charge_id))
    .map((c) => ({
      ...c,
      total_amount: Number(c.total_amount),
      paid_amount: Number(c.paid_amount),
      open_amount: Number(c.open_amount),
      days_overdue: Number(c.days_overdue),
    }))
  const scheduledLines: ScheduledLine[] = ((scheduleResult.data ?? []) as unknown as ScheduledLine[]).map((l) => ({
    due_date: l.due_date,
    amount: Number(l.amount),
  }))
  const receivables = summarizeVehicleReceivables(receivableCharges, scheduledLines)

  // Separa o que é da moto (receita) do que é repasse ao cliente e do que não é
  // nem um nem outro (caução — passivo, nunca aparece aqui). Multa do cliente
  // entra e sai do caixa da empresa, mas não é retorno nem investimento do
  // veículo: contá-la subia "investido" e "recuperado" juntos e inflava o
  // percentual de payback sem a moto ter rendido nada.
  const incomeCharges: IncomeCharge[] = chargeRows.map((c) => ({
    id: c.id,
    status: c.status,
    items: c.charge_items.map((i) => ({
      amount: Number(i.amount),
      kind: ACCOUNT_KIND_TO_ITEM_KIND[i.financial_accounts?.kind ?? ''] ?? 'other',
      account_label: i.financial_accounts?.name ?? i.credit_account_code,
      source_key: i.source_id ? `${i.source_module}:${i.source_id}` : null,
    })),
  }))
  const income = summarizeVehicleIncome(
    incomeCharges,
    ((allocationsResult.data ?? []) as unknown as { amount: number; charge_id: string; payments: { paid_at: string; method: string } }[])
      .map((a) => ({
        charge_id: a.charge_id,
        date: a.payments.paid_at,
        amount: Number(a.amount),
        // Crédito do cliente consumido não é dinheiro novo — já virou "despesas
        // que ficam com a empresa" mais baixa no momento em que o crédito foi
        // concedido. Contar de novo aqui duplicava o mesmo valor.
        is_cash: a.payments.method !== 'credit',
      })),
  )

  const expenseResponsibility = summarizeExpenseResponsibility(
    expenses.map<PayableShare>((e) => ({ status: e.status, amount: Number(e.amount) })),
    customerBears,
  )

  // Repasse total, para exibição: `income.passthrough_billed` só enxerga
  // repasse via COBRANÇA (`charge_items`). Repasse via CRÉDITO ao cliente
  // (`reimbursement: 'credit'`) nunca vira cobrança — some do
  // `charge_items`, mas o razão já sabe dele (é o mesmo `customerBears` que
  // alimenta "Despesas → Cliente"). Sem isto, "Repasses ao cliente" mostrava
  // menos do que o card ao lado, com o mesmo dinheiro contado duas formas.
  const passthroughTotal = Math.max(customerBears, income.passthrough_billed)
  const passthroughPending = round2(Math.max(0, passthroughTotal - income.passthrough_received))

  // ── Retorno do investimento ───────────────────────────────────────────────
  // `vehicles.created_at` é quando o veículo entrou NO SISTEMA, não quando
  // começou a operar — locação pode ter `start_date` bem anterior (cadastro
  // tardio de frota já em operação). O início real é o mais cedo entre os dois.
  const earliestRentalStart = rentals.reduce<string | null>((min, r) => {
    if (!r.start_date) return min
    return !min || r.start_date < min ? r.start_date : min
  }, null)
  const createdOn = vehicle.created_at.slice(0, 10)
  const startDate = earliestRentalStart && earliestRentalStart < createdOn ? earliestRentalStart : createdOn

  const acquisitionCost = Number(vehicle.acquisition_amount ?? 0)
  const saleProceeds = Number(vehicle.sale_value ?? 0)
  const alreadySold = vehicle.sale_value != null

  const payback = calculateVehiclePayback({
    acquisition_amount: acquisitionCost,
    sale_amount: saleProceeds,
    sold_on: vehicle.sold_at ? vehicle.sold_at.slice(0, 10) : null,
    start_date: startDate,
    today: new Date().toISOString().slice(0, 10),
    // Recebimentos da moto: só receita (aluguel, encargo), sem repasse nem caução.
    receipts: income.own_receipts,
    // Despesa que fica com a empresa: só o que ela desembolsa (o cliente que
    // pagou direto à oficina fica de fora) menos o que foi repassado em cobrança.
    expenses: deductPassThrough(
      expenses
        .filter((e) => companyPaidIds.has(e.id))
        .map((e) => ({
          date: e.competence_date,
          amount: Number(e.amount),
          source_key: `${e.source_module}:${e.source_id ?? e.id}`,
        })),
      income.billed_by_source,
    ),
  })
  // Despesa que fica com a empresa, all-time — mesma base do "Investido".
  const companyExpenses = round2(payback.invested_total - acquisitionCost)
  // Recebido da moto, all-time — mesma base do "Recuperado", sem a venda.
  const ownReceivedTotal = round2(income.own_receipts.reduce((sum, r) => sum + r.amount, 0))
  // Lucro operacional: independe da aquisição ter sido paga ou não — uma moto
  // pode dar lucro todo mês mesmo antes do payback do investimento (são
  // perguntas diferentes: resultado do período × retorno de capital).
  const lucro = round2(ownReceivedTotal - companyExpenses)

  const monthly: MonthlyPoint[] = payback.points.map((p) => ({
    monthKey: p.month,
    label: monthLabelOf(p.month),
    received: p.received,
    expenses: p.expenses,
    investment: p.invested,
    recovered: p.recovered,
  }))
  const hasMovement = monthly.some((m) => m.received > 0 || m.expenses > 0)
  const paidBack = acquisitionCost > 0 && payback.remaining === 0 && payback.reached_month !== null

  // Composição das despesas: custo BRUTO por categoria (empresa + cliente).
  const costByCategory = new Map<string, CostCategory>()
  for (const e of expenses) {
    const prev = costByCategory.get(e.expense_account_code)
    costByCategory.set(e.expense_account_code, {
      code: e.expense_account_code,
      label: e.financial_accounts?.name ?? e.expense_account_code,
      amount: (prev?.amount ?? 0) + Number(e.amount ?? 0),
    })
  }
  const costBreakdown = [...costByCategory.values()]
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  // Composição das entradas: recebido da moto + repasse já devolvido, por categoria.
  const incomeBreakdown: CostCategory[] = [...income.received_by_source.entries()]
    .map(([label, amount]) => ({ code: label, label, amount }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)

  // ── Ocupação ──────────────────────────────────────────────────────────────
  const today = new Date()
  const acquiredAt = new Date(`${startDate}T12:00:00`)
  const horizonEnd = alreadySold && vehicle.sold_at ? new Date(`${vehicle.sold_at}T12:00:00`) : today
  const totalDaysOwned = daysBetween(acquiredAt, horizonEnd) || 1
  const rentedDays = rentals.reduce((sum, r) => {
    if (!r.start_date) return sum
    const start = new Date(`${r.start_date}T12:00:00`)
    const rawEnd = r.end_date ? new Date(`${r.end_date}T12:00:00`) : horizonEnd
    const end = rawEnd > horizonEnd ? horizonEnd : rawEnd
    return sum + daysBetween(start, end)
  }, 0)
  const utilizationPct = Math.min(100, Math.round((rentedDays / totalDaysOwned) * 100))

  const showReceivables = rentals.length > 0

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-divider bg-bg px-6">
        <Link href="/financeiro" className="whitespace-nowrap text-[13px] text-fg-mute transition-colors hover:text-fg">
          ← Financeiro
        </Link>
        <span className="text-border">/</span>
        <span className="text-fg-mute text-[13px]">ROI</span>
        <span className="text-border">/</span>
        <span className="flex-1 truncate font-mono text-[13px] font-semibold text-primary">{vehicle.license_plate}</span>
        <Link
          href={`/veiculos/${id}`}
          className="inline-flex h-9 items-center rounded-full border border-border px-3 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
        >
          Ver veículo →
        </Link>
      </div>

      <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">

        {/* ── Cabeçalho do relatório: dados do veículo ──────────────────────── */}
        <header>
          <p className="text-[12px] font-medium uppercase tracking-wide text-fg-mute">Relatório financeiro do veículo</p>
          <h1 className="mt-1 flex flex-wrap items-baseline gap-x-3 text-2xl font-bold tracking-tight text-fg">
            <span className="font-mono text-primary">{vehicle.license_plate}</span>
            <span>{vehicle.make} {vehicle.model}</span>
          </h1>
          <dl className="mt-3 flex flex-wrap gap-2 text-[12px]">
            {([
              ['Ano', vehicle.year_manufacture],
              ['Cor', vehicle.color],
              ['Cadastrado em', fmt(vehicle.created_at)],
              [
                'Situação',
                alreadySold
                  ? `Vendido por ${formatCurrency(saleProceeds)} em ${fmt(vehicle.sold_at)}`
                  : activeRental
                    ? `Em locação${activeRental.customers?.name ? ` · ${activeRental.customers.name}` : ''}`
                    : 'Sem locação ativa',
              ],
            ] as [string, string | number | null | undefined][])
              .filter(([, value]) => value != null && value !== '')
              .map(([label, value]) => (
                <div key={label} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface px-3">
                  <dt className="text-fg-mute">{label}</dt>
                  <dd className="font-medium text-fg">{value}</dd>
                </div>
              ))}
          </dl>
        </header>

        {/* ── Resumo financeiro ────────────────────────────────────────────── */}
        {/* Sempre visível, independe de aquisição cadastrada ou de payback:
            lucro operacional é uma pergunta diferente de retorno de capital. */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <Stat label="Recebido" value={formatCurrency(ownReceivedTotal)} tone="success" muted={ownReceivedTotal === 0}>
              <p>Da locação, sem repasses de multa ou manutenção</p>
            </Stat>
            <Stat label="Despesas da empresa" value={formatCurrency(companyExpenses)} tone="warning" muted={companyExpenses === 0}>
              <p>Pagas e em aberto que ficam com a empresa</p>
            </Stat>
            <Stat label="Lucro" value={formatCurrency(lucro)} tone={lucro >= 0 ? 'success' : 'danger'}>
              <p>Recebido − despesas da empresa</p>
            </Stat>
          </div>
        </section>

        {/* ── Entrada × Saída por mês ───────────────────────────────────────── */}
        {hasMovement && <VehicleMonthlyChart monthly={monthly} />}

        {/* ── Composição das entradas e das despesas ────────────────────────── */}
        {(incomeBreakdown.length > 0 || costBreakdown.length > 0) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <VehicleIncomeBreakdownChart incomeBreakdown={incomeBreakdown} />
            <VehicleCostBreakdownChart costBreakdown={costBreakdown} />
          </div>
        )}

        {/* ── Recebimentos × Despesas ──────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {showReceivables && (
            <section className="flex flex-col rounded-2xl border border-border bg-surface p-5 lg:col-span-3">
              <div className="mb-4">
                <h2 className="text-[15px] font-bold text-fg">Recebimentos das locações</h2>
                <p className="text-[12px] text-fg-mute">
                  {receivables.expected_total > 0
                    ? `${formatCurrency(receivables.expected_total)} previstos no contrato`
                    : 'Nenhuma cobrança emitida ainda'}
                </p>
              </div>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                <Stat
                  label="Recebido"
                  value={formatCurrency(receivables.received)}
                  tone="success"
                  muted={receivables.received === 0}
                >
                  <p>
                    {receivables.received_pct != null
                      ? `${fmtPct(receivables.received_pct)} do previsto`
                      : 'Nada recebido ainda'}
                  </p>
                  {income.passthrough_received > 0 && (
                    <p>Inclui {formatCurrency(income.passthrough_received)} de multas e custos repassados</p>
                  )}
                </Stat>

                <Stat
                  label="Em atraso"
                  value={formatCurrency(receivables.overdue.amount)}
                  tone="danger"
                  muted={receivables.overdue.count === 0}
                >
                  {receivables.overdue.count > 0 ? (
                    <>
                      <p>
                        {plural(receivables.overdue.count, 'cobrança vencida', 'cobranças vencidas')} · a mais
                        antiga há {plural(receivables.overdue.oldest_days, 'dia', 'dias')}
                      </p>
                      <p>Saldo sem multa e juros</p>
                    </>
                  ) : (
                    <p>Nenhuma cobrança vencida</p>
                  )}
                </Stat>

                <Stat
                  label="A receber"
                  value={formatCurrency(receivables.future_total)}
                  tone="info"
                  muted={receivables.future_total === 0}
                >
                  <p>
                    {formatCurrency(receivables.upcoming.amount)} a vencer
                    {receivables.upcoming.count > 0 && receivables.upcoming.next_due_date
                      ? ` · próxima em ${fmt(receivables.upcoming.next_due_date)}`
                      : ''}
                  </p>
                  <p>
                    {hasActiveRental
                      ? `${formatCurrency(receivables.to_issue.amount)} a emitir · ${plural(receivables.to_issue.count, 'parcela', 'parcelas')}`
                      : 'Sem locação ativa, nada a emitir'}
                  </p>
                </Stat>
              </div>

              <div className="mt-auto pt-5">
                <SegmentedBar
                  summary={`Recebido ${formatCurrency(receivables.received)}, em atraso ${formatCurrency(receivables.overdue.amount)}, a vencer ${formatCurrency(receivables.upcoming.amount)}, a emitir ${formatCurrency(receivables.to_issue.amount)}`}
                  segments={[
                    { value: receivables.received, className: 'bg-success', label: 'Recebido' },
                    { value: receivables.overdue.amount, className: 'bg-danger', label: 'Em atraso' },
                    { value: receivables.upcoming.amount, className: 'bg-info', label: 'A vencer' },
                    { value: receivables.to_issue.amount, className: 'bg-info opacity-40', label: 'A emitir' },
                  ]}
                />
              </div>
            </section>
          )}

          <section className={`rounded-2xl border border-border bg-surface p-5 ${showReceivables ? 'lg:col-span-2' : 'lg:col-span-5'}`}>
            <div className="mb-4">
              <h2 className="text-[15px] font-bold text-fg">Despesas</h2>
              <p className="text-[12px] text-fg-mute">
                {expenseResponsibility.count > 0
                  ? `${formatCurrency(expenseResponsibility.total)} em ${plural(expenseResponsibility.count, 'lançamento', 'lançamentos')}`
                  : 'Nenhuma despesa lançada'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <Stat
                label="Empresa"
                value={formatCurrency(expenseResponsibility.company)}
                tone="warning"
                muted={expenseResponsibility.company === 0}
              >
                <p>
                  {expenseResponsibility.customer_pct != null
                    ? `${fmtPct(100 - expenseResponsibility.customer_pct)} do total · custo que fica com a empresa`
                    : 'Custo que fica com a empresa'}
                </p>
              </Stat>
              <Stat
                label="Cliente"
                value={formatCurrency(expenseResponsibility.customer)}
                tone="info"
                muted={expenseResponsibility.customer === 0}
              >
                <p>
                  {expenseResponsibility.customer_pct != null
                    ? `${fmtPct(expenseResponsibility.customer_pct)} do total · repassado em cobrança`
                    : 'Repassado em cobrança'}
                </p>
              </Stat>
            </div>

            <div className="mt-5">
              <SegmentedBar
                summary={`Empresa ${formatCurrency(expenseResponsibility.company)}, cliente ${formatCurrency(expenseResponsibility.customer)}`}
                segments={[
                  { value: expenseResponsibility.company, className: 'bg-warning', label: 'Empresa' },
                  { value: expenseResponsibility.customer, className: 'bg-info', label: 'Cliente' },
                ]}
              />
            </div>

            {passthroughTotal > 0 && (
              <div className="mt-4 border-t border-divider pt-3">
                <p className="text-[12px] font-medium text-fg-mute">Repasses ao cliente</p>
                <p className="mt-1 text-[13px] text-fg-soft">
                  <span className="font-semibold text-fg">{formatCurrency(passthroughTotal)}</span> adiantados (cobrança ou crédito) ·{' '}
                  <span className="font-semibold text-success">{formatCurrency(income.passthrough_received)}</span> já devolvidos ·{' '}
                  <span className={`font-semibold ${passthroughPending > 0 ? 'text-danger' : 'text-fg-mute'}`}>
                    {formatCurrency(passthroughPending)}
                  </span>{' '}
                  a devolver
                </p>
                <p className="mt-0.5 text-[12px] text-fg-mute">
                  É adiantamento, não desempenho da moto: fica fora do retorno do investimento.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* ── Retorno do investimento ──────────────────────────────────────── */}
        {acquisitionCost > 0 ? (
          <section className="rounded-2xl border border-border bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-bold text-fg">Retorno do investimento</h2>
                <p className="text-[12px] text-fg-mute">
                  Quanto do valor de aquisição já voltou em dinheiro, sem contar multas e custos repassados ao cliente
                </p>
              </div>
              {paidBack ? (
                <span className="rounded-full bg-success-bg px-3 py-1 text-[12px] font-semibold text-success">
                  Já se pagou · payback em {monthLabelOf(payback.reached_month!)}
                </span>
              ) : (
                <span className="rounded-full bg-pending-bg px-3 py-1 text-[12px] font-semibold text-pending">
                  Faltam {formatCurrency(payback.remaining)} para se pagar
                </span>
              )}
            </div>

            <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-3xl font-bold tracking-tight text-fg">
                {fmtPct(payback.progress_pct ?? 0)}
                <span className="ml-2 text-[13px] font-normal text-fg-mute">recuperado</span>
              </p>
              <p className="text-[13px] text-fg-mute">
                {formatCurrency(payback.recovered_total)} de {formatCurrency(payback.invested_total)}
              </p>
            </div>
            <div
              className="mt-2 h-3 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(payback.progress_pct ?? 0)}
              aria-label="Investimento recuperado"
            >
              <div
                className={`h-full rounded-full ${paidBack ? 'bg-success' : 'bg-primary'}`}
                style={{ width: `${payback.progress_pct ?? 0}%` }}
              />
            </div>

            <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Stat label="Investido" value={formatCurrency(payback.invested_total)} tone="neutral">
                <p>
                  {formatCurrency(acquisitionCost)} aquisição + {formatCurrency(companyExpenses)} despesas que ficam com a empresa
                </p>
              </Stat>
              {paidBack ? (
                <Stat label="Retorno acima do investimento" value={formatCurrency(payback.profit)} tone="success" muted={payback.profit === 0}>
                  <p>{payback.roi_pct != null ? `ROI de ${payback.roi_pct >= 0 ? '+' : ''}${fmtPct(payback.roi_pct)} sobre a aquisição` : ''}</p>
                </Stat>
              ) : (
                <Stat label="Falta para o payback" value={formatCurrency(payback.remaining)} tone="warning">
                  <p>
                    {payback.reached_month
                      ? `O payback foi atingido em ${monthLabelOf(payback.reached_month)}, mas novas despesas reabriram o saldo`
                      : 'Payback ainda não atingido'}
                  </p>
                </Stat>
              )}
            </div>

            {alreadySold && (
              <p className="mt-3 text-[12px] text-fg-mute">
                A venda de {formatCurrency(saleProceeds)} já está somada ao recuperado.
              </p>
            )}

            {hasMovement && monthly.length > 1 && (
              <div className="mt-5 border-t border-divider pt-4">
                <VehiclePaybackChart monthly={monthly} />
              </div>
            )}
          </section>
        ) : (
          <section className="rounded-2xl border border-dashed border-border bg-surface p-5">
            <h2 className="text-[15px] font-bold text-fg">Retorno do investimento</h2>
            <p className="mt-1 text-[13px] text-fg-mute">
              Cadastre o valor de aquisição para acompanhar quanto do investimento já voltou e quando a moto se paga.
            </p>
            <a
              href="#acoes"
              className="mt-3 inline-flex h-9 items-center rounded-full bg-primary px-4 text-[13px] font-semibold text-bg transition-colors hover:bg-primary-hover"
            >
              Cadastrar valor de aquisição
            </a>
          </section>
        )}

        {/* ── Ocupação ──────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">
            Ocupação
            <span className="ml-2 text-[12px] font-normal text-fg-mute">
              {utilizationPct}% do tempo locado ({rentedDays} de {totalDaysOwned} dias)
            </span>
          </h2>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${utilizationPct}%` }} />
          </div>
          {rentals.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Cliente</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Início</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Fim</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Status</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Ciclo</th>
                  </tr>
                </thead>
                <tbody>
                  {rentals.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 max-w-[200px] truncate px-4 text-fg-soft">{r.customers?.name ?? '—'}</td>
                      <td className="h-9 px-4 text-fg-mute">{fmt(r.start_date)}</td>
                      <td className="h-9 px-4 text-fg-mute">{r.end_date ? fmt(r.end_date) : 'em andamento'}</td>
                      <td className="h-9 px-4 text-fg-mute">{r.status === 'active' ? 'Ativa' : 'Encerrada'}</td>
                      <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(r.cycle_amount ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[13px] text-fg-mute">Nenhuma locação registrada para este veículo.</p>
          )}
        </section>

        {/* ── Ações financeiras ─────────────────────────────────────────── */}
        <section id="acoes">
          <h2 className="mb-3 text-[14px] font-bold text-primary">Ações</h2>
          <VehicleFinancialActions
            vehicleId={id}
            hasAcquisitionValue={acquisitionCost > 0}
            alreadySold={alreadySold}
          />
        </section>

      </div>
    </div>
  )
}
