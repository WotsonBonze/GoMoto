import Link from 'next/link'
import {
  ChevronRight, Users, Bike,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { getRentalCore } from './_lib/get-rental-core'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function RentalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { rental, tenantId, supabase } = await getRentalCore(id)

  const [billingsResult, depositResult, depositBalanceResult, downPaymentResult] = await Promise.all([
    supabase
      .from('charge_balances')
      .select('charge_id, status, total_amount, paid_amount, open_amount, is_overdue, days_overdue, due_date')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .order('due_date', { ascending: true }),
    // `deposits.balance` deixou de existir: saldo vem de deposit_balances.
    supabase
      .from('deposits')
      .select('amount, received_at, closed_at')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    // Saldo da caução: derivado do ledger, não coluna mutável (F-08).
    supabase
      .from('deposit_balances')
      .select('balance')
      .eq('rental_id', id)
      .maybeSingle(),
    // Entrada localizada pela ORIGEM do item. `billing_type` não existe mais:
    // a origem vive no item, não no documento (F-11).
    supabase
      .from('charge_items')
      .select('amount, charge:charges(id, status, due_date)')
      .eq('tenant_id', tenantId)
      .eq('source_module', 'down_payment')
      .eq('source_id', id)
      .maybeSingle(),
  ])

  type ChargeRow = {
    charge_id: string; status: 'open' | 'paid' | 'cancelled' | 'written_off'
    total_amount: number; paid_amount: number; open_amount: number
    is_overdue: boolean; days_overdue: number; due_date: string
  }
  const billings = (billingsResult.data ?? []) as unknown as ChargeRow[]

  const depositRow = depositResult.data as { amount: number; received_at: string; closed_at: string | null } | null
  const depositBalance = (depositBalanceResult.data as { balance: number } | null)?.balance ?? 0
  const deposit = depositRow
    ? {
        amount: depositRow.amount,
        balance: depositBalance,
        status: depositRow.closed_at ? 'closed' : 'received',
        received_at: depositRow.received_at,
      }
    : null

  type DownPaymentItem = {
    amount: number
    charge: { id: string; status: string; due_date: string } | { id: string; status: string; due_date: string }[] | null
  }
  const rawDp = downPaymentResult.data as unknown as DownPaymentItem | null
  const dpCharge = rawDp ? (Array.isArray(rawDp.charge) ? rawDp.charge[0] : rawDp.charge) : null

  // Totais financeiros — mesma regra de @/lib/billing-status usada em /financeiro,
  // para os dois nunca mostrarem números divergentes.
  // Saldos vêm derivados de `charge_balances`; nada aqui recalcula atraso nem
  // recompõe valor a partir de desconto ou crédito (Princípios 2 e 4).
  const totalPaid = billings.reduce((s, b) => s + b.paid_amount, 0)
  const totalPending = billings
    .filter(b => b.status === 'open' && !b.is_overdue)
    .reduce((s, b) => s + b.open_amount, 0)
  const overdueBillings = billings.filter(b => b.is_overdue)
  const totalOverdue = overdueBillings.reduce((s, b) => s + b.open_amount, 0)
  const overdueCount = overdueBillings.length

  // O card mostrava o valor da ENTRADA com o status da COBRANÇA — coisas
  // diferentes assim que um encargo por atraso entra no mesmo documento. Uma
  // entrada de R$ 150 integralmente paga, com R$ 3,25 de encargo em aberto,
  // aparecia como "R$ 150,00 · Vencida": o operador lê que o cliente não pagou
  // a entrada. O que falta é o saldo da cobrança, então é ele que precisa
  // aparecer junto.
  const dpBalance = dpCharge
    ? billings.find(b => b.charge_id === dpCharge.id)
    : undefined
  const downPayment = rawDp && dpCharge
    ? {
        amount: rawDp.amount,
        status: dpCharge.status,
        due_date: dpCharge.due_date,
        open: dpBalance?.open_amount ?? 0,
      }
    : null

  return (
    <>

      {/* ── Alerta de vencidas ────────────────────────────────────────── */}
      {overdueCount > 0 && (
        <span className="inline-flex rounded-full bg-danger-bg px-3 py-0.5 text-[13px] font-semibold text-danger">
          {overdueCount} cobrança{overdueCount !== 1 ? 's' : ''} vencida{overdueCount !== 1 ? 's' : ''}
        </span>
      )}

      {/* ── Cards de totais ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Total pago</p>
          <p className="mt-1 text-xl font-bold text-success">{formatCurrency(totalPaid)}</p>
        </div>
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Em aberto</p>
          <p className={`mt-1 text-xl font-bold ${totalPending > 0 ? 'text-info' : 'text-fg-mute'}`}>
            {formatCurrency(totalPending)}
          </p>
        </div>
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Vencido</p>
          <p className={`mt-1 text-xl font-bold ${totalOverdue > 0 ? 'text-danger' : 'text-fg-mute'}`}>
            {formatCurrency(totalOverdue)}
          </p>
        </div>
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Caução</p>
          <p className="mt-1 text-xl font-bold text-fg">
            {deposit != null ? formatCurrency(deposit.amount) : '—'}
          </p>
          {/* Saldo vem de `deposit_balances`, derivado do ledger. Antes lia
              `deposit.status`/`deposit.balance` — colunas que não existem, então
              a condição era sempre verdadeira e o valor saía indefinido. */}
          {deposit && depositBalance !== deposit.amount && (
            <p className="mt-0.5 text-[12px] text-fg-mute">
              Saldo: {formatCurrency(depositBalance)}
            </p>
          )}
        </div>
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Entrada</p>
          <p className="mt-1 text-xl font-bold text-fg">
            {downPayment ? formatCurrency(downPayment.amount) : '—'}
          </p>
          {downPayment && downPayment.status !== 'paid' && downPayment.open > 0 && (
            <p className="mt-0.5 text-[12px] text-fg-mute">
              {downPayment.due_date < new Date().toISOString().slice(0, 10) ? 'Vencida' : 'Pendente'}
              {' · falta '}{formatCurrency(downPayment.open)}
            </p>
          )}
        </div>
      </div>

      {/* ── Vínculo: cliente + veículo ─────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[14px] font-bold text-primary">Vínculo</h2>
        <div className="grid grid-cols-2 gap-4">

          <div className="space-y-1 rounded-xl bg-surface p-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-fg-mute" />
              <p className="text-[12px] font-medium uppercase tracking-wide text-fg-mute">Cliente</p>
            </div>
            {rental.customer ? (
              <>
                <p className="text-[15px] font-bold text-fg">{rental.customer.name}</p>
                {rental.customer.phone && <p className="text-[13px] text-fg-mute">{rental.customer.phone}</p>}
                {rental.customer.cpf   && <p className="text-[13px] text-fg-mute">CPF: {rental.customer.cpf}</p>}
                <Link
                  href={`/clientes/${rental.customer.id}`}
                  className="inline-flex items-center gap-1 text-[12px] text-fg-mute transition-colors hover:text-primary"
                >
                  Ver cliente <ChevronRight className="h-3 w-3" />
                </Link>
              </>
            ) : (
              <p className="text-[13px] text-fg-mute">Não vinculado</p>
            )}
          </div>

          <div className="space-y-1 rounded-xl bg-surface p-4">
            <div className="flex items-center gap-2">
              <Bike className="h-4 w-4 text-fg-mute" />
              <p className="text-[12px] font-medium uppercase tracking-wide text-fg-mute">Veículo</p>
            </div>
            {rental.vehicle ? (
              <>
                <p className="font-mono text-[15px] font-bold text-primary">{rental.vehicle.license_plate}</p>
                <p className="text-[13px] text-fg">{rental.vehicle.make} {rental.vehicle.model}</p>
                {rental.vehicle.year_manufacture && (
                  <p className="text-[13px] text-fg-mute">{rental.vehicle.year_manufacture} · {rental.vehicle.color}</p>
                )}
                {/* RF-003 — km inicial/final/rodado. `—` em locação anterior a
                    esta feature (km_initial nulo). */}
                <p className="text-[13px] text-fg-mute">
                  Km inicial: {rental.km_initial != null ? rental.km_initial.toLocaleString('pt-BR') : '—'}
                  {' · '}
                  Km final: {rental.km_final != null ? rental.km_final.toLocaleString('pt-BR') : '—'}
                  {rental.km_initial != null && rental.km_final != null && (
                    <> {' · '}Km rodado: {(rental.km_final - rental.km_initial).toLocaleString('pt-BR')}</>
                  )}
                </p>
                <Link
                  href={`/veiculos/${rental.vehicle.id}`}
                  className="inline-flex items-center gap-1 text-[12px] text-fg-mute transition-colors hover:text-primary"
                >
                  Ver veículo <ChevronRight className="h-3 w-3" />
                </Link>
              </>
            ) : (
              <p className="text-[13px] text-fg-mute">Não vinculado</p>
            )}
          </div>
        </div>
      </section>

    </>
  )
}
