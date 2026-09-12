import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import {
  BILLING_STATUS_BADGE, BILLING_TYPE_LABEL,
} from '@/lib/billing-status'
import { contractedBacklog, displayPeriodEnd } from '@gomoto/core'
import { getRentalCore } from '../_lib/get-rental-core'
import { fmt } from '../_lib/shared'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDatetime(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
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
}

/**
 * Linha do razão na conta de caução.
 *
 * Já foi `deposit_movements`, tabela com `movement_type` e `reason` próprios.
 * A consulta migrou para `financial_entries` (ADR 0024 — movimento de caução é
 * transação no ledger, não tabela paralela); a TABELA da tela continuou lendo
 * os campos antigos, que a consulta não traz. A coluna "Tipo" saía em branco e
 * "Motivo" saía sempre "—".
 */
type DepositMovementRow = {
  id: string
  amount: number
  direction: 'debit' | 'credit'
  created_at: string
  transaction: { event_type: string; description: string } | { event_type: string; description: string }[] | null
}

/** Linha do plano de cobrança. Existe antes de virar documento. */
type ScheduleRow = {
  id: string
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
  status: 'scheduled' | 'issued' | 'cancelled' | 'superseded'
}

const SCHEDULE_STATUS: Record<ScheduleRow['status'], { label: string; cls: string }> = {
  scheduled:  { label: 'A emitir',  cls: 'text-info' },
  issued:     { label: 'Emitida',   cls: 'text-fg' },
  cancelled:  { label: 'Cancelada', cls: 'text-fg-mute line-through' },
  superseded: { label: 'Substituída', cls: 'text-fg-mute line-through' },
}

function ScheduleRowCells({ line }: { line: ScheduleRow }) {
  const st = SCHEDULE_STATUS[line.status]
  return (
    <tr className="border-b border-divider last:border-0">
      <td className="h-9 w-12 px-4 font-mono text-fg-mute">{line.sequence_number}</td>
      {/* `period_end` é a fronteira exclusiva (= vencimento, coluna ao lado) —
          exibe o último dia de USO, não o vencimento repetido. */}
      <td className="h-9 px-4 text-fg-mute">{fmt(line.period_start)} a {fmt(displayPeriodEnd(line.period_end))}</td>
      <td className="h-9 px-4 text-fg">{fmt(line.due_date)}</td>
      <td className="h-9 px-4 text-right font-mono tabular-nums text-fg">
        {formatCurrency(line.amount)}
      </td>
      <td className={`h-9 px-4 text-right ${st.cls}`}>{st.label}</td>
    </tr>
  )
}

type AdjustmentRow = {
  id: string
  justification: string
  previous_cycle_amount: number
  new_cycle_amount: number
  adjusted_at: string
}

const SOURCE_LABELS: Record<string, string> = {
  cycle:        'Ciclo',
  rental_cycle: 'Ciclo',
  fine:         'Multa',
  maintenance:  'Manutenção',
  expense:      'Despesa',
  manual:       'Manual',
  deposit:      'Caução',
  down_payment: 'Entrada',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function RentalFinancialTab({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { tenantId, supabase } = await getRentalCore(id)

  const [
    billingsResult, depositResult, depositMovementsResult, adjustmentsResult, scheduleResult,
  ] = await Promise.all([
    supabase
      // Saldo derivado; atraso vem de `is_overdue`, sem recálculo na tela.
      .from('charge_balances')
      .select('charge_id, status, total_amount, paid_amount, open_amount, is_overdue, days_overdue, due_date')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .order('due_date', { ascending: true }),
    supabase
      .from('deposits')
      .select('amount, closed_at')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .is('closed_at', null)
      .maybeSingle(),
    // Movimento de caução é transação no ledger, não tabela própria.
    supabase
      .from('financial_entries')
      .select('id, amount, direction, created_at, transaction:financial_transactions(event_type, description)')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .eq('account_code', 'caucoes_a_devolver')
      .order('created_at', { ascending: false }),
    supabase
      .from('rental_adjustments')
      .select('id, justification, previous_cycle_amount, new_cycle_amount, adjusted_at')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .order('adjusted_at', { ascending: false }),
    // Cronograma contratado. A aba só mostrava DOCUMENTO emitido, então um
    // contrato recém-aberto exibia apenas caução e entrada — as parcelas
    // existiam no plano e não apareciam em lugar nenhum da tela do contrato.
    supabase
      .from('rental_billing_schedules')
      .select('id, sequence_number, period_start, period_end, due_date, amount, status')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      // Cronológica, não por sequência. Depois de um ajuste de período (ADR
      // 0035) as linhas novas CONTINUAM a numeração — a UNIQUE proíbe reuso —,
      // então ordenar por `sequence_number` colocaria a parcela de janeiro
      // depois da de dezembro.
      .order('period_start', { ascending: true })
      .order('sequence_number', { ascending: true }),
  ])

  const deposit = depositResult.data as { amount: number; closed_at: string | null } | null
  const billings = (billingsResult.data ?? []) as unknown as BillingRow[]
  const depositMovements = (depositMovementsResult.data ?? []) as unknown as DepositMovementRow[]
  const adjustments = (adjustmentsResult.data ?? []) as unknown as AdjustmentRow[]
  const schedule = (scheduleResult.data ?? []) as unknown as ScheduleRow[]

  // `contractedBacklog` de @gomoto/core é a MESMA função que o reajuste e o
  // encerramento usam. Recalcular aqui faria três telas divergirem sobre o
  // mesmo contrato.
  const backlog        = contractedBacklog(schedule)
  const scheduleIssued = schedule.filter(l => l.status === 'issued')
    .reduce((sum, l) => sum + Number(l.amount), 0)
  const scheduleActive  = schedule.filter(l => l.status !== 'cancelled' && l.status !== 'superseded')
  const scheduleHistory = schedule.filter(l => l.status === 'cancelled' || l.status === 'superseded')
  const contractedTotal = scheduleActive.reduce((sum, l) => sum + Number(l.amount), 0)

  // A descrição vive nos ITENS, não no documento. Consulta separada: juntar
  // charge_items dentro de charge_balances reintroduziria o fan-out de F-01.
  const { data: itemRows } = billings.length
    ? await supabase
        .from('charge_items')
        .select('charge_id, description, amount')
        .in('charge_id', billings.map(b => b.charge_id))
    : { data: [] }

  const descByCharge = new Map<string, string>()
  for (const i of (itemRows ?? []) as { charge_id: string; description: string; amount: number }[]) {
    // Item de maior valor representa a cobrança.
    const atual = descByCharge.get(i.charge_id)
    if (!atual) descByCharge.set(i.charge_id, i.description)
  }

  // ── Totais ────────────────────────────────────────────────────────────────
  // Mesma regra de @/lib/billing-status usada em /locacoes/[id], para os dois
  // nunca mostrarem números divergentes.
  // Saldos derivados de `charge_balances`. Os helpers de @/lib/billing-status
  // recalculavam atraso e recompunham valor a partir de desconto/crédito —
  // ambos deixaram de existir como colunas (Princípios 2 e 4).
  const totalPaid    = billings.reduce((s, b) => s + b.paid_amount, 0)
  const totalPending = billings.filter(b => b.status === 'open' && !b.is_overdue)
    .reduce((s, b) => s + b.open_amount, 0)
  const totalOverdue = billings.filter(b => b.is_overdue)
    .reduce((s, b) => s + b.open_amount, 0)
  const totalBilled  = billings.reduce((s, b) => s + b.total_amount, 0)

  // Caução: movimentos são LANÇAMENTOS na conta de passivo. Crédito aumenta o
  // passivo (recebimento), débito reduz (devolução ou retenção).
  // `DepositEntry` era uma segunda declaração da mesma linha, criada quando o
  // tipo do topo ainda descrevia a tabela `deposit_movements`. Com aquele
  // corrigido, sobra um.
  const depositEntries = depositMovements
  const entryEvent = (e: DepositMovementRow) => {
    const t = Array.isArray(e.transaction) ? e.transaction[0] : e.transaction
    return t?.event_type ?? ''
  }

  const depositReceived = depositEntries
    .filter(e => e.direction === 'credit')
    .reduce((s, e) => s + e.amount, 0)
  const depositReturned = depositEntries
    .filter(e => entryEvent(e) === 'deposit_returned')
    .reduce((s, e) => s + e.amount, 0)
  const depositRetained = depositEntries
    .filter(e => entryEvent(e) === 'deposit_retained')
    .reduce((s, e) => s + e.amount, 0)
  const depositBalance = depositReceived - depositReturned - depositRetained

  // Eventos do razão, não os `movement_type` da tabela extinta ('received',
  // 'returned', 'partial_return', 'retained', 'forfeited') — nenhum deles
  // chega mais aqui, por isso a coluna aparecia vazia.
  //
  // A caução credita o passivo na EMISSÃO da cobrança, então o evento é
  // `charge_issued`: a empresa passa a dever a devolução a partir do momento em
  // que a cobra. Devolver e reter têm evento próprio.
  const EVENT_LABELS: Record<string, string> = {
    charge_issued:    'Caução cobrada',
    payment_received: 'Recebida',
    deposit_returned: 'Devolvida',
    deposit_retained: 'Retida',
    charge_cancelled: 'Cobrança cancelada',
    payment_reversed: 'Recebimento estornado',
  }

  /** Rótulo do movimento. Evento desconhecido aparece cru — em branco, não. */
  const rotuloDoEvento = (m: DepositMovementRow) => {
    const evento = entryEvent(m)
    return EVENT_LABELS[evento] ?? evento ?? '—'
  }

  const motivoDoEvento = (m: DepositMovementRow) => {
    const t = Array.isArray(m.transaction) ? m.transaction[0] : m.transaction
    return t?.description ?? '—'
  }

  return (
    <>

      {/* ── KPIs ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl bg-surface p-4">
          <p className="text-[12px] text-fg-mute">Total emitido</p>
          <p className="mt-1 text-xl font-bold text-fg">{formatCurrency(totalBilled)}</p>
          <p className="mt-0.5 text-[12px] text-fg-mute">{billings.length} cobranças</p>
        </div>
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
      </div>

      {/* ── Caução ────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-[14px] font-bold text-primary">Caução</h2>
        <div className="overflow-hidden rounded-xl bg-surface">
          <table className="w-full text-[13px]">
            <tbody>
              <tr className="border-b border-divider">
                <td className="h-9 w-52 px-4 text-fg-mute">Valor contratado</td>
                <td className="h-9 px-4 font-mono text-fg">
                  {deposit != null ? formatCurrency(deposit.amount) : '—'}
                </td>
              </tr>
              <tr className="border-b border-divider">
                <td className="h-9 w-52 px-4 text-fg-mute">Recebido</td>
                <td className="h-9 px-4 font-mono text-success">{formatCurrency(depositReceived)}</td>
              </tr>
              {depositReturned > 0 && (
                <tr className="border-b border-divider">
                  <td className="h-9 w-52 px-4 text-fg-mute">Devolvido</td>
                  <td className="h-9 px-4 font-mono text-fg-mute">− {formatCurrency(depositReturned)}</td>
                </tr>
              )}
              {depositRetained > 0 && (
                <tr className="border-b border-divider">
                  <td className="h-9 w-52 px-4 text-fg-mute">Retido</td>
                  <td className="h-9 px-4 font-mono text-warning">− {formatCurrency(depositRetained)}</td>
                </tr>
              )}
              <tr>
                <td className="h-9 w-52 px-4 font-medium text-fg">Saldo</td>
                <td className={`h-9 px-4 font-mono font-bold ${depositBalance > 0 ? 'text-primary' : 'text-fg-mute'}`}>
                  {formatCurrency(depositBalance)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Movimentações de caução ───────────────────────────────────── */}
      {depositMovements.length > 0 && (
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">
            Movimentações de caução
            <span className="ml-2 text-[12px] font-normal text-fg-mute">({depositMovements.length})</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-divider">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-divider bg-surface">
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Tipo</th>
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Data</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {depositMovements.map(m => (
                  <tr key={m.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="h-9 px-4 text-fg-soft">{rotuloDoEvento(m)}</td>
                    <td className="h-9 px-4 text-fg-mute">{fmtDatetime(m.created_at)}</td>
                    <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(m.amount)}</td>
                    <td className="h-9 max-w-[200px] truncate px-4 text-fg-mute">{motivoDoEvento(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Ajustes de mensalidade ───────────────────────────────────── */}
      {adjustments.length > 0 && (
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">
            Ajustes de mensalidade
            <span className="ml-2 text-[12px] font-normal text-fg-mute">({adjustments.length})</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-divider">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-divider bg-surface">
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Data</th>
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Motivo</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Anterior</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Novo</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map(a => (
                  <tr key={a.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="h-9 px-4 text-fg-mute">{fmt(a.adjusted_at)}</td>
                    <td className="h-9 max-w-[180px] truncate px-4 text-fg-soft">{a.justification}</td>
                    <td className="h-9 px-4 text-right font-mono text-fg-mute">{formatCurrency(a.previous_cycle_amount)}</td>
                    <td className="h-9 px-4 text-right font-mono font-semibold text-fg">{formatCurrency(a.new_cycle_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Cronograma contratado ─────────────────────────────────────── */}
      {/* Distinto de "Cobranças": aqui está o que o contrato PREVÊ, incluindo o
          que ainda não virou documento. Sem esta seção, um contrato novo
          mostrava só caução e entrada, e o operador não tinha onde conferir as
          parcelas que acabara de contratar. */}
      {schedule.length > 0 && (
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">Cronograma contratado</h2>

          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-surface p-4">
              <p className="text-[12px] text-fg-mute">Total contratado</p>
              <p className="mt-1 text-lg font-bold text-fg">{formatCurrency(contractedTotal)}</p>
              <p className="mt-0.5 text-[12px] text-fg-mute">
                {scheduleActive.length} parcela{scheduleActive.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="rounded-xl bg-surface p-4">
              <p className="text-[12px] text-fg-mute">Já emitido</p>
              <p className="mt-1 text-lg font-bold text-fg">{formatCurrency(scheduleIssued)}</p>
              <p className="mt-0.5 text-[12px] text-fg-mute">virou cobrança</p>
            </div>
            <div className="rounded-xl bg-surface p-4">
              <p className="text-[12px] text-fg-mute">A emitir</p>
              <p className="mt-1 text-lg font-bold text-info">{formatCurrency(backlog)}</p>
              {/* Carteira contratada ≠ contas a receber: isto ainda não é
                  dívida do cliente, é previsão do contrato. */}
              <p className="mt-0.5 text-[12px] text-fg-mute">ainda não cobrado</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl bg-surface">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-divider text-fg-mute">
                  <th className="h-9 w-12 px-4 text-left font-medium">#</th>
                  <th className="h-9 px-4 text-left font-medium">Período</th>
                  <th className="h-9 px-4 text-left font-medium">Vencimento</th>
                  <th className="h-9 px-4 text-right font-medium">Valor</th>
                  <th className="h-9 px-4 text-right font-medium">Situação</th>
                </tr>
              </thead>
              <tbody>
                {scheduleActive.map((l) => <ScheduleRowCells key={l.id} line={l} />)}
              </tbody>
            </table>
          </div>

          {/* Plano substituído fica atrás de um disclosure nativo: é histórico,
              não previsão, e misturar os dois faz "Total contratado" parecer
              não bater com a tabela. */}
          {scheduleHistory.length > 0 && (
            <details className="mt-3 rounded-xl bg-surface">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] text-fg-mute hover:text-fg">
                Histórico do plano ({scheduleHistory.length} parcela
                {scheduleHistory.length === 1 ? '' : 's'} substituída
                {scheduleHistory.length === 1 ? '' : 's'} ou cancelada
                {scheduleHistory.length === 1 ? '' : 's'})
              </summary>
              <div className="overflow-x-auto border-t border-divider">
                <table className="w-full text-[13px]">
                  <tbody>
                    {scheduleHistory.map((l) => <ScheduleRowCells key={l.id} line={l} />)}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}

      {/* ── Cobranças ─────────────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-bold text-primary">
            Cobranças
            <span className="ml-2 text-[12px] font-normal text-fg-mute">({billings.length})</span>
          </h2>
          <Link href="/cobrancas" className="text-[12px] text-fg-mute transition-colors hover:text-primary">
            Ver em cobranças →
          </Link>
        </div>
        {billings.length === 0 ? (
          <div className="flex items-center justify-center rounded-xl bg-surface py-8">
            <p className="text-[13px] text-fg-mute">Nenhuma cobrança.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-divider">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-divider bg-surface">
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Vencimento</th>
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Descrição</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Pago</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Em aberto</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Total</th>
                  <th className="h-9 px-4 font-medium text-fg-mute">Status</th>
                  <th className="h-9 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {billings.map(b => {
                  // Atraso é derivado, não status armazenado (Princípio 4); o
                  // resto é o próprio `charge_status`. O mapeamento de 'open'
                  // para 'pending' que existia aqui vinha do enum antigo e
                  // fazia cobrança BAIXADA cair no fallback e exibir "Pendente".
                  const dynStatus = b.is_overdue ? 'overdue' : b.status
                  const badge     = BILLING_STATUS_BADGE[dynStatus] ?? BILLING_STATUS_BADGE.open
                  return (
                    <tr key={b.charge_id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 px-4 text-fg-soft">
                        {fmt(b.due_date)}
                        {b.is_overdue && <span className="ml-2 text-danger">{b.days_overdue}d</span>}
                      </td>
                      <td className="h-9 px-4 text-fg-soft">{descByCharge.get(b.charge_id) ?? '—'}</td>
                      <td className="h-9 px-4 text-right font-mono text-fg-mute">
                        {b.paid_amount > 0 ? formatCurrency(b.paid_amount) : '—'}
                      </td>
                      <td className="h-9 px-4 text-right font-mono text-fg-soft">{formatCurrency(b.open_amount)}</td>
                      <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(b.total_amount)}</td>
                      <td className="h-9 px-4">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.bg} ${badge.text}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="h-9 px-4 text-right">
                        <Link href={`/cobrancas/${b.charge_id}`} className="text-[12px] text-fg-mute transition-colors hover:text-primary">
                          Ver →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </>
  )
}
