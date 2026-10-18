import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { formatCurrency } from '@/lib/utils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: string | null | undefined) {
  if (!d) return '—'
  const date = d.includes('T') ? new Date(d) : new Date(d + 'T12:00:00')
  return date.toLocaleDateString('pt-BR')
}

/** Linha de `charge_balances` — saldo derivado, não colunas do documento. */
type BillingRow = {
  charge_id: string
  status: 'open' | 'paid' | 'cancelled' | 'written_off'
  total_amount: number
  paid_amount: number
  open_amount: number
  is_overdue: boolean
  days_overdue: number
  due_date: string
  customer_id: string
  rental_id: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  cycle:       'Ciclo',
  fine:        'Multa',
  maintenance: 'Manutenção',
  expense:     'Despesa',
  manual:      'Manual',
  deposit:     'Caução',
}

/** `charge_status` (ADR 0024) + `overdue`, que é derivado, não armazenado. */
const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  open:        { bg: 'bg-info-bg',    text: 'text-info',    label: 'Em aberto' },
  overdue:     { bg: 'bg-danger-bg',  text: 'text-danger',  label: 'Vencida' },
  paid:        { bg: 'bg-success-bg', text: 'text-success', label: 'Paga' },
  cancelled:   { bg: 'bg-surface-2',  text: 'text-fg-mute', label: 'Cancelada' },
  written_off: { bg: 'bg-warning-bg', text: 'text-warning', label: 'Baixada' },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function FinancialDashboardPage() {
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const now   = new Date()
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const nextMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const monthEnd   = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`

  const [
    // A ordem aqui precisa espelhar a do array abaixo — os agregados entram
    // ANTES da última execução do faturamento.
    monthBillingsResult, overdueBillingsResult, vehiclesResult,
    delinquentResult, summaryResult, monthSummaryResult, lastRunResult,
  ] = await Promise.all([
    // Cobranças do mês corrente — caução fica de fora: é garantia/depósito,
    // não receita operacional, e já tem exibição própria em /locacoes/[id].
    // Spec 0014: total, pago e em aberto vêm de `charge_balances`, derivados.
    // A exclusão de caução deixa de ser filtro de query — a caução credita
    // conta de PASSIVO e nunca entra em receita por construção (F-09).
    supabase
      .from('charge_balances')
      .select('charge_id, status, total_amount, paid_amount, open_amount, is_overdue, days_overdue, due_date, customer_id, rental_id')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .gte('due_date', monthStart)
      .lt('due_date', monthEnd)
      .order('due_date', { ascending: true }),
    // Cobranças vencidas (qualquer mês) — mesma exclusão de caução
    // Atraso é DERIVADO: `is_overdue` já compara due_date com hoje. Antes o
    // filtro era status='pending' + due_date, porque nada gravava 'overdue'.
    supabase
      .from('charge_balances')
      .select('charge_id, status, total_amount, paid_amount, open_amount, is_overdue, days_overdue, due_date, customer_id, rental_id')
      .eq('tenant_id', tenantId)
      .eq('is_overdue', true)
      .order('days_overdue', { ascending: false })
      .limit(50),
    // Veículos com aquisição cadastrada (para ROI). Ordenado por placa, não por
    // cadastro: `created_at DESC` escondia exatamente os veículos mais antigos
    // — os que têm mais história de ROI para mostrar — assim que a frota
    // passasse de 10 veículos com aquisição registrada.
    supabase
      .from('vehicles')
      .select('id, license_plate, make, model, acquisition_amount, sale_value, sold_at')
      .eq('tenant_id', tenantId)
      .not('acquisition_amount', 'is', null)
      .order('license_plate', { ascending: true })
      .limit(100),
    // Clientes inadimplentes
    // Bloqueio é decisão humana e vive em `delinquency_blocks`; a coluna
    // `customers.delinquency_status` era mantida por trigger inerte (F-04).
    // Log append-only: a última ação por cliente define o estado atual.
    supabase
      .from('delinquency_blocks')
      .select('customer_id, action, acted_at, customers(id, name)')
      .eq('tenant_id', tenantId)
      .order('acted_at', { ascending: false }),
    // Os totais vêm AGREGADOS do banco, não das listas acima.
    //
    // "Vencidas (total)" somava `overdueBillings`, que tem `.limit(50)`: com 179
    // cobranças vencidas o card exibia R$ 21.397,56 de um total real de
    // R$ 66.134,24 — um terço, sob o rótulo "(total)". O subtítulo "50
    // cobranças" era o próprio limite se anunciando.
    //
    // Os cards do mês somavam a lista completa do mês, que o PostgREST corta em
    // 1.000 linhas sem erro. Mesmo desfecho, só que mais adiante (ADR 0025).
    supabase
      .from('receivables_summary')
      .select('overdue_total, overdue_count')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase
      .from('receivables_by_month')
      .select('issued_total, paid_total, pending_total, charge_count, paid_count, pending_count, deposit_issued, deposit_paid')
      .eq('tenant_id', tenantId)
      .eq('month', monthStart)
      .maybeSingle(),
    // Última execução do faturamento. Existe para tornar visível a AUSÊNCIA de
    // execução: sem isto, "o job não rodou" e "rodou e não havia nada a fazer"
    // são indistinguíveis, e um segredo de ambiente faltando derruba a receita
    // recorrente em silêncio.
    supabase
      .from('billing_runs')
      .select('started_at, finished_at, charges_issued, error, triggered_by')
      .eq('tenant_id', tenantId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  type BillingRun = {
    started_at: string; finished_at: string | null
    charges_issued: number; error: string | null; triggered_by: string
  }
  const lastRun = (lastRunResult.data ?? null) as BillingRun | null

  const horasDesdeEmissao = lastRun
    ? Math.floor((Date.now() - new Date(lastRun.started_at).getTime()) / 3_600_000)
    : null

  // O job roda uma vez por dia. Passar de ~26h significa que uma execução foi
  // pulada — e é exatamente o que ninguém percebia antes.
  const emissaoAtrasada = horasDesdeEmissao === null || horasDesdeEmissao > 26

  const monthBillings = (monthBillingsResult.data ?? []) as unknown as BillingRow[]
  const overdueBillings = (overdueBillingsResult.data ?? []) as unknown as BillingRow[]
  const vehicles = vehiclesResult.data ?? []
  type BlockRow = {
    customer_id: string; action: string
    customers: { id: string; name: string } | { id: string; name: string }[] | null
  }
  // Já vem ordenado por acted_at desc: a primeira ocorrência de cada cliente é
  // a ação mais recente.
  const latestByCustomer = new Map<string, BlockRow>()
  for (const b of (delinquentResult.data ?? []) as unknown as BlockRow[]) {
    if (!latestByCustomer.has(b.customer_id)) latestByCustomer.set(b.customer_id, b)
  }

  const delinquentCustomers = [...latestByCustomer.values()]
    .filter((b) => b.action === 'block')
    .map((b) => {
      const c = Array.isArray(b.customers) ? b.customers[0] : b.customers
      return { id: c?.id ?? b.customer_id, name: c?.name ?? '—' }
    })

  // KPIs — agregados no banco. As listas abaixo são para EXIBIÇÃO e têm limite;
  // somar linha limitada foi o que fez "Vencidas (total)" mostrar um terço do
  // valor real (ADR 0025).
  const summary = summaryResult.data as { overdue_total: number; overdue_count: number } | null
  const mes = monthSummaryResult.data as {
    issued_total: number; paid_total: number; pending_total: number
    charge_count: number; paid_count: number; pending_count: number
    deposit_issued: number; deposit_paid: number
  } | null

  const totalBilledMonth  = Number(mes?.issued_total  ?? 0)
  const totalPaidMonth    = Number(mes?.paid_total    ?? 0)
  // Pendente exclui as vencidas de propósito: elas já aparecem no card ao lado,
  // e somá-las aqui contaria o mesmo dinheiro duas vezes.
  const totalPendingMonth = Number(mes?.pending_total ?? 0)
  const totalOverdueAll   = Number(summary?.overdue_total ?? 0)

  // Caução entra nos totais porque É recebível e ENTROU no caixa — tirá-la
  // faria o card deixar de bater com o extrato. Mas somada ao aluguel sem
  // distinção, "Recebido no mês" pode ser 100% depósito, dinheiro que sai de
  // volta. Fica declarada ao lado, e o DRE — que ignora passivo, corretamente —
  // deixa de parecer inconsistente com o painel.
  const depositIssuedMonth = Number(mes?.deposit_issued ?? 0)
  const depositPaidMonth   = Number(mes?.deposit_paid   ?? 0)

  const monthChargeCount  = Number(mes?.charge_count  ?? 0)
  const monthPaidCount    = Number(mes?.paid_count    ?? 0)
  const monthPendingCount = Number(mes?.pending_count ?? 0)
  const overdueCountAll   = Number(summary?.overdue_count ?? 0)

  // Cliente e placa vêm em consulta separada: `charge_balances` já agrega por
  // cobrança, e juntar tabelas ali reintroduziria o fan-out de F-01.
  const allRows = [...monthBillings, ...overdueBillings]
  const overdueCustomerIds = [...new Set(allRows.map(b => b.customer_id))]
  const overdueRentalIds = [...new Set(allRows.map(b => b.rental_id).filter(Boolean))] as string[]

  const [namesRes, platesRes] = await Promise.all([
    overdueCustomerIds.length
      ? supabase.from('customers').select('id, name').in('id', overdueCustomerIds)
      : Promise.resolve({ data: [] }),
    overdueRentalIds.length
      ? supabase.from('rentals').select('id, vehicles(license_plate)').in('id', overdueRentalIds)
      : Promise.resolve({ data: [] }),
  ])

  const nameById = new Map(
    ((namesRes.data ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]),
  )

  type RentalVehicle = { id: string; vehicles: { license_plate: string } | { license_plate: string }[] | null }
  const plateByRental = new Map(
    ((platesRes.data ?? []) as unknown as RentalVehicle[]).map(r => {
      const v = Array.isArray(r.vehicles) ? r.vehicles[0] : r.vehicles
      return [r.id, v?.license_plate ?? null] as const
    }),
  )

  // "agosto de 2026" → "Agosto de 2026". O `capitalize` do CSS maiúsculiza
  // TODA palavra e produzia "Agosto De 2026"; só a primeira letra deve subir.
  const monthLabel = (() => {
    const bruto = now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    return bruto.charAt(0).toUpperCase() + bruto.slice(1)
  })()

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex h-16 items-center border-b border-divider bg-bg px-6">
        <h1 className="text-[15px] font-bold text-fg">{monthLabel}</h1>
        <span className="ml-2 text-[13px] text-fg-mute">— Painel financeiro</span>
      </div>

      <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">

        {/* ── KPIs do mês ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-xl bg-surface p-4">
            <p className="text-[12px] text-fg-mute">Emitido no mês</p>
            <p className="mt-1 text-xl font-bold text-fg">{formatCurrency(totalBilledMonth)}</p>
            <p className="mt-0.5 text-[12px] text-fg-mute">
              {monthChargeCount} cobranças
              {depositIssuedMonth > 0 && ` · inclui ${formatCurrency(depositIssuedMonth)} de caução`}
            </p>
          </div>
          <div className="rounded-xl bg-surface p-4">
            <p className="text-[12px] text-fg-mute">Recebido no mês</p>
            <p className="mt-1 text-xl font-bold text-success">{formatCurrency(totalPaidMonth)}</p>
            <p className="mt-0.5 text-[12px] text-fg-mute">
              {monthPaidCount} pagas
              {depositPaidMonth > 0 && ` · inclui ${formatCurrency(depositPaidMonth)} de caução`}
            </p>
          </div>
          <div className="rounded-xl bg-surface p-4">
            <p className="text-[12px] text-fg-mute">Pendente no mês</p>
            <p className="mt-1 text-xl font-bold text-info">{formatCurrency(totalPendingMonth)}</p>
            <p className="mt-0.5 text-[12px] text-fg-mute">{monthPendingCount} pendentes</p>
          </div>
          <div className="rounded-xl bg-surface p-4">
            <p className="text-[12px] text-fg-mute">Vencidas (total)</p>
            <p className={`mt-1 text-xl font-bold ${overdueCountAll > 0 ? 'text-danger' : 'text-fg-mute'}`}>
              {formatCurrency(totalOverdueAll)}
            </p>
            <p className="mt-0.5 text-[12px] text-fg-mute">{overdueCountAll} cobranças</p>
          </div>
        </div>

        {/* ── Faturamento ───────────────────────────────────────────────────
            A emissão das cobranças de aluguel roda sozinha, uma vez por dia.
            Quando ela falha, nada na tela mudava: as cobranças simplesmente não
            apareciam, e não havia como distinguir isso de "não havia nada a
            faturar". Esta faixa existe para essa diferença ficar visível. */}
        <div className={`rounded-xl border p-4 ${
          emissaoAtrasada
            ? 'border-danger bg-danger-bg'
            : 'border-divider bg-surface'
        }`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className={`text-[13px] font-medium ${emissaoAtrasada ? 'text-danger' : 'text-fg'}`}>
              {lastRun === null
                ? 'O faturamento automático nunca rodou'
                : emissaoAtrasada
                  ? `Faturamento sem rodar há ${horasDesdeEmissao}h`
                  : 'Faturamento em dia'}
            </p>
            {lastRun && (
              <p className="text-[12px] text-fg-mute">
                Última execução {fmt(lastRun.started_at)}
                {lastRun.triggered_by === 'manual' ? ' (manual)' : ''}
                {' · '}
                {lastRun.charges_issued} cobrança{lastRun.charges_issued === 1 ? '' : 's'} emitida{lastRun.charges_issued === 1 ? '' : 's'}
              </p>
            )}
          </div>
          {lastRun?.error && (
            <p className="mt-2 text-[12px] text-danger">Erro na última execução: {lastRun.error}</p>
          )}
          {lastRun && !lastRun.finished_at && (
            <p className="mt-2 text-[12px] text-warning">A última execução não concluiu.</p>
          )}
        </div>

        {/* ── Cobranças vencidas ────────────────────────────────────────── */}
        {overdueBillings.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-bold text-primary">
                Cobranças vencidas
                <span className="ml-2 text-[12px] font-normal text-fg-mute">
                  {overdueCountAll > overdueBillings.length
                    ? `${overdueBillings.length} de ${overdueCountAll} — maiores atrasos`
                    : `${overdueBillings.length}`}
                </span>
              </h2>
              <Link href="/cobrancas" className="text-[12px] text-fg-mute transition-colors hover:text-primary">
                Ver em cobranças →
              </Link>
            </div>
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Cliente</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Veículo</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Atraso</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Vencimento</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {overdueBillings.map(b => (
                    <tr key={b.charge_id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 px-4">
                        <Link href={`/clientes/${b.customer_id}`} className="text-fg-soft hover:text-primary">
                          {nameById.get(b.customer_id) ?? '—'}
                        </Link>
                      </td>
                      <td className="h-9 px-4 font-mono text-fg-mute">
                        {b.rental_id ? plateByRental.get(b.rental_id) ?? '—' : '—'}
                      </td>
                      <td className="h-9 px-4 text-fg-mute">{b.days_overdue}d</td>
                      <td className="h-9 px-4 text-danger">{fmt(b.due_date)}</td>
                      <td className="h-9 px-4 text-right font-mono font-semibold text-danger">
                        {formatCurrency(b.open_amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Cobranças do mês ──────────────────────────────────────────── */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-bold text-primary">
              Cobranças do mês
              <span className="ml-2 text-[12px] font-normal text-fg-mute">({monthBillings.length})</span>
            </h2>
            <Link href="/cobrancas" className="text-[12px] text-fg-mute transition-colors hover:text-primary">
              Ver todas →
            </Link>
          </div>
          {monthBillings.length === 0 ? (
            <div className="flex items-center justify-center rounded-xl bg-surface py-10">
              <p className="text-[13px] text-fg-mute">Nenhuma cobrança neste mês.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Cliente</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Veículo</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Vencimento</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                    <th className="h-9 px-4 font-medium text-fg-mute">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {monthBillings.map(b => {
                    // Atraso é derivado na view — sem recálculo aqui (Princípio 4).
                    const dynStatus = b.is_overdue ? 'overdue' : b.status
                    const badge     = STATUS_BADGE[dynStatus] ?? STATUS_BADGE.open
                    return (
                      <tr key={b.charge_id} className="border-b border-border last:border-0 hover:bg-surface-2">
                        <td className="h-9 px-4">
                          <Link href={`/cobrancas/${b.charge_id}`} className="text-fg-soft hover:text-primary">
                            {nameById.get(b.customer_id) ?? '—'}
                          </Link>
                        </td>
                        <td className="h-9 px-4 font-mono text-fg-mute">
                          {b.rental_id ? plateByRental.get(b.rental_id) ?? '—' : '—'}
                        </td>
                        <td className="h-9 px-4 text-fg-soft">{fmt(b.due_date)}</td>
                        <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(b.total_amount)}</td>
                        <td className="h-9 px-4">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.bg} ${badge.text}`}>
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Clientes bloqueados ───────────────────────────────────────── */}
        {delinquentCustomers.length > 0 && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-primary">
              Clientes bloqueados
              <span className="ml-2 text-[12px] font-normal text-fg-mute">({delinquentCustomers.length})</span>
            </h2>
            <div className="flex flex-wrap gap-2">
              {delinquentCustomers.map(c => (
                <Link
                  key={c.id}
                  href={`/clientes/${c.id}`}
                  className="inline-flex h-8 items-center rounded-full border border-danger bg-danger-bg px-3 text-[13px] text-danger transition-colors hover:bg-danger-bg"
                >
                  {c.name}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ── ROI de veículos ───────────────────────────────────────────── */}
        {vehicles.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-bold text-primary">ROI de veículos</h2>
              {vehicles.length >= 100 && (
                <span className="text-[12px] text-fg-mute">Mostrando os 100 primeiros por placa</span>
              )}
            </div>
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Veículo</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Aquisição</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Venda</th>
                    <th className="h-9 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map(v => (
                    <tr key={v.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 px-4">
                        <Link href={`/financeiro/veiculos/${v.id}`} className="flex items-center gap-2 hover:text-primary">
                          <span className="font-mono text-primary">{v.license_plate}</span>
                          <span className="text-fg-mute">{v.make} {v.model}</span>
                        </Link>
                      </td>
                      <td className="h-9 px-4 text-right font-mono text-fg">
                        {v.acquisition_amount != null ? formatCurrency(v.acquisition_amount) : '—'}
                      </td>
                      <td className="h-9 px-4 text-right font-mono text-fg-mute">
                        {v.sale_value != null ? formatCurrency(v.sale_value) : '—'}
                      </td>
                      <td className="h-9 px-4 text-right">
                        <Link href={`/financeiro/veiculos/${v.id}`} className="text-[12px] text-fg-mute transition-colors hover:text-primary">
                          Ver ROI →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
