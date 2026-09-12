/**
 * @file AdjustRentalPeriodForm.tsx
 * @description Ajuste de período e condições da locação (ADR 0035).
 *
 * Substitui `AdjustRentalForm` (só valor) e `RenewForm` (só esticar o fim). Os
 * dois eram recortes do mesmo ato, e ter dois donos para `end_date` fazia as
 * regras divergirem: Renovar recusava encurtar, Reajustar não sabia que datas
 * existiam.
 *
 * A prévia sai de `planPeriodAdjustment`, a MESMA função que a Server Action
 * usa para gravar — pelo mesmo motivo que `generateSchedule` é única. O que o
 * operador confere é literalmente o que vai acontecer.
 */

'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react'

import {
  planPeriodAdjustment,
  scheduleParamLabel,
  formatDueDay,
  displayPeriodEnd,
  WEEK_DAY_OPTIONS,
  type PlannedScheduleLine,
  type RentalScheduleParams,
  type RentalType,
  type ScheduleLineChargeRow,
  type ScheduleLineRow,
} from '@gomoto/core'
import { formatCurrency, formatDate } from '@/lib/utils'
import { adjustRentalPeriod } from '../actions'

type RentalHeader = {
  id: string
  contract_type: RentalType
  signed_contract_path: string | null
  params: RentalScheduleParams
  customer: { id: string; name: string } | null
  vehicle: { id: string; license_plate: string; make: string | null; model: string | null } | null
}

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg outline-none transition-all focus:border-primary'
const labelCls = 'mb-1.5 block text-[13px] text-fg-mute'
const cardCls  = 'rounded-xl border border-divider bg-surface p-4'

const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => String(i + 1))

export function AdjustRentalPeriodForm({
  rental,
  lines,
  charges,
  otherRentals,
  today,
}: {
  rental: RentalHeader
  lines: ScheduleLineRow[]
  charges: ScheduleLineChargeRow[]
  otherRentals: Array<{ start_date: string; end_date: string | null }>
  today: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [form, setForm] = useState({
    start_date:   rental.params.start_date,
    end_date:     rental.params.end_date,
    cycle:        rental.params.cycle,
    due_day:      String(rental.params.due_day),
    cycle_amount: String(rental.params.cycle_amount),
    use_pro_rata: rental.params.use_pro_rata,
  })
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [justification, setJustification] = useState('')
  const [error, setError] = useState('')

  const next: RentalScheduleParams = useMemo(() => ({
    start_date:   form.start_date,
    end_date:     form.end_date,
    cycle:        form.cycle,
    due_day:      parseInt(form.due_day, 10) || 0,
    cycle_amount: parseFloat(form.cycle_amount) || 0,
    use_pro_rata: form.use_pro_rata,
  }), [form])

  const plan = useMemo(() => planPeriodAdjustment({
    current: rental.params,
    next,
    contract_type: rental.contract_type,
    lines,
    charges,
    effective_from: effectiveFrom,
    today,
    has_signed_contract: !!rental.signed_contract_path,
    other_rentals: otherRentals,
  }), [rental, next, lines, charges, otherRentals, effectiveFrom, today])

  // A fronteira sugerida depende dos parâmetros novos (o fallback é a data de
  // início), então só é possível preencher o campo depois do primeiro cálculo.
  const effectiveValue = effectiveFrom || plan.default_effective_from

  // Sem nenhuma condição alterada, o plano ainda "substituiria" as linhas
  // futuras por linhas idênticas — verdade matemática, ruído na tela. As
  // seções de efeito só existem depois que há efeito.
  const hasChanges = plan.changed_fields.length > 0 && plan.blockers.length === 0
  const supersededPlanLines = hasChanges ? plan.supersede_lines.filter((l) => !l.was_issued) : []
  const cancelCharges = hasChanges ? plan.cancel_charges : []
  const newLines      = hasChanges ? plan.new_lines : []
  const canSubmit =
    plan.blockers.length === 0 &&
    plan.changed_fields.length > 0 &&
    justification.trim().length >= 3 &&
    !isPending

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  /** Troca de ciclo muda o significado do dia de vencimento: 1 é "dia 1" no
   *  mensal e "segunda-feira" no semanal. Manter o número seria manter um
   *  valor que passou a querer dizer outra coisa. */
  function handleCycle(value: 'weekly' | 'monthly') {
    setForm((f) => ({ ...f, cycle: value, due_day: value === 'weekly' ? '1' : '10' }))
  }

  function handleConfirm() {
    setError('')
    startTransition(async () => {
      const result = await adjustRentalPeriod({
        rental_id:      rental.id,
        start_date:     next.start_date,
        end_date:       next.end_date,
        cycle:          next.cycle,
        due_day:        next.due_day,
        cycle_amount:   next.cycle_amount,
        use_pro_rata:   next.use_pro_rata,
        effective_from: effectiveValue,
        justification,
      })
      if (!result.ok) { setError(result.error.message); return }
      // A confirmação é a aba Financeiro mostrando o cronograma novo. Um aviso
      // de sucesso aqui piscaria por um instante antes da navegação — pior do
      // que não ter.
      router.push(`/locacoes/${rental.id}/financeiro`)
    })
  }

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-bg px-6">
        <Link href={`/locacoes/${rental.id}`} className="text-[13px] text-fg-mute transition-colors hover:text-fg">
          ← {rental.vehicle?.license_plate ?? 'Locação'}
        </Link>
        <span className="text-fg-mute">/</span>
        <h1 className="flex-1 text-[15px] font-bold text-fg">Ajustar locação</h1>
        <Link
          href={`/locacoes/${rental.id}`}
          className="inline-flex h-8 items-center rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
        >
          Cancelar
        </Link>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canSubmit}
          className="inline-flex h-8 items-center rounded-full bg-primary px-5 text-[13px] font-bold text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {isPending ? 'Aplicando…' : 'Confirmar ajuste'}
        </button>
      </div>

      <div className="mx-auto grid max-w-5xl gap-6 px-6 py-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">

        {/* ── Parâmetros ───────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className={cardCls}>
            <p className="text-[13px] font-semibold text-fg">
              {rental.vehicle?.license_plate} — {rental.vehicle?.make} {rental.vehicle?.model}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-mute">{rental.customer?.name}</p>
          </div>

          <div className={`${cardCls} space-y-4`}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Início" was={rental.params.start_date !== next.start_date ? formatDate(rental.params.start_date) : null}>
                <input
                  type="date" className={inputCls}
                  value={form.start_date}
                  onChange={(e) => set('start_date', e.target.value)}
                />
              </Field>
              <Field label="Fim" was={rental.params.end_date !== next.end_date ? formatDate(rental.params.end_date) : null}>
                <input
                  type="date" className={inputCls}
                  min={form.start_date || undefined}
                  value={form.end_date}
                  onChange={(e) => set('end_date', e.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Ciclo" was={rental.params.cycle !== next.cycle ? (rental.params.cycle === 'weekly' ? 'Semanal' : 'Mensal') : null}>
                <select
                  className={inputCls}
                  value={form.cycle}
                  onChange={(e) => handleCycle(e.target.value as 'weekly' | 'monthly')}
                >
                  <option value="monthly">Mensal</option>
                  <option value="weekly">Semanal</option>
                </select>
              </Field>
              <Field
                label="Vencimento"
                was={rental.params.due_day !== next.due_day ? formatDueDay(rental.params.cycle, String(rental.params.due_day)) : null}
              >
                <select
                  className={inputCls}
                  value={form.due_day}
                  onChange={(e) => set('due_day', e.target.value)}
                >
                  {form.cycle === 'weekly'
                    ? WEEK_DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
                    : MONTH_DAYS.map((d) => <option key={d} value={d}>Dia {d}</option>)}
                </select>
              </Field>
            </div>

            <Field
              label="Valor do ciclo (R$)"
              was={rental.params.cycle_amount !== next.cycle_amount ? formatCurrency(rental.params.cycle_amount) : null}
            >
              <input
                type="number" step="0.01" min="0" className={inputCls}
                value={form.cycle_amount}
                onChange={(e) => set('cycle_amount', e.target.value)}
              />
            </Field>

            <label className="flex items-center gap-2 text-[13px] text-fg-soft">
              <input
                type="checkbox"
                checked={form.use_pro_rata}
                onChange={(e) => set('use_pro_rata', e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Cobrar proporcional nas pontas (pro rata)
              {rental.params.use_pro_rata !== next.use_pro_rata && (
                <span className="text-[12px] text-fg-mute line-through">
                  {rental.params.use_pro_rata ? 'Sim' : 'Não'}
                </span>
              )}
            </label>
          </div>

          <div className={`${cardCls} space-y-4`}>
            <Field label="Aplicar a partir de">
              <input
                type="date" className={inputCls}
                min={plan.min_effective_from}
                value={effectiveValue}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-fg-mute">
                Períodos que terminam até esta data não mudam. Antecipe para alcançar
                cobranças já emitidas — elas aparecem ao lado antes de qualquer coisa
                acontecer.
              </p>
            </Field>

            <Field label="Justificativa *">
              <textarea
                rows={3}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Motivo do ajuste"
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none transition-all focus:border-primary"
              />
            </Field>
          </div>
        </div>

        {/* ── Efeito ───────────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {plan.changed_fields.length === 0 ? (
            <div className={`${cardCls} text-[13px] text-fg-mute`}>
              Altere alguma condição para ver o efeito no cronograma.
            </div>
          ) : (
            <p className="text-[13px] text-fg-mute">
              Alterando <span className="text-fg">{plan.changed_fields.map(scheduleParamLabel).join(', ')}</span>.
            </p>
          )}

          {plan.blockers.map((b) => (
            <Notice key={b.code} tone="danger" icon={<AlertCircle className="h-4 w-4" />}>
              {b.message}
            </Notice>
          ))}

          {hasChanges && plan.keep_lines.length > 0 && (
            <div className={`${cardCls} text-[13px] text-fg-mute`}>
              <span className="tabular-nums text-fg">{plan.keep_lines.length}</span>{' '}
              parcela{plan.keep_lines.length !== 1 ? 's' : ''} até {formatDate(effectiveValue)}{' '}
              não muda{plan.keep_lines.length !== 1 ? 'm' : ''}.
            </div>
          )}

          {cancelCharges.length > 0 && (
            <Section
              title={`${cancelCharges.length} cobrança${cancelCharges.length !== 1 ? 's serão canceladas' : ' será cancelada'}`}
              tone="danger"
              note="Cancelar estorna o lançamento de emissão no razão e encerra o código de pagamento no gateway."
            >
              <Table head={[
                { label: 'Cobrança' }, { label: 'Vencimento' },
                { label: 'Valor', right: true }, { label: 'Recebido', right: true },
              ]}>
                {cancelCharges.map((c) => (
                  <tr key={c.charge_id} className="h-9 border-b border-border last:border-0">
                    <td className="px-3 font-mono text-fg-soft">#{c.charge_number}</td>
                    <td className="px-3 text-fg-soft">{formatDate(c.due_date)}</td>
                    <td className="px-3 text-right font-mono text-fg">{formatCurrency(c.total_amount)}</td>
                    <td className="px-3 text-right font-mono text-fg-mute">{formatCurrency(c.paid_amount)}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          )}

          {supersededPlanLines.length > 0 && (
            <Section
              title={`${supersededPlanLines.length} parcela${supersededPlanLines.length !== 1 ? 's' : ''} do plano substituída${supersededPlanLines.length !== 1 ? 's' : ''}`}
              note="Ainda não viraram cobrança: nenhum dinheiro se move."
            >
              <Table head={[
                { label: 'Período' }, { label: 'Vencimento' }, { label: 'Valor', right: true },
              ]}>
                {supersededPlanLines.map((l) => (
                  <tr key={l.id} className="h-9 border-b border-border last:border-0">
                    {/* `period_end` é a fronteira exclusiva (= vencimento, coluna
                        ao lado) — exibe o último dia de USO, não o vencimento
                        repetido. */}
                    <td className="px-3 text-fg-mute">{formatDate(l.period_start)} a {formatDate(displayPeriodEnd(l.period_end))}</td>
                    <td className="px-3 text-fg-soft">{formatDate(l.due_date)}</td>
                    <td className="px-3 text-right font-mono text-fg-mute line-through">{formatCurrency(l.amount)}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          )}

          {newLines.length > 0 && (
            <Section
              title={`${newLines.length} parcela${newLines.length !== 1 ? 's' : ''} criada${newLines.length !== 1 ? 's' : ''}`}
              note="Cada uma vira cobrança quando o período dela chegar."
            >
              <Table head={[
                { label: 'Período' }, { label: 'Vencimento' },
                { label: 'Valor', right: true }, { label: 'Emissão', right: true },
              ]}>
                {newLines.map((l) => (
                  <tr key={l.sequence_number} className="h-9 border-b border-border last:border-0">
                    {/* `period_end` é a fronteira exclusiva (= vencimento, coluna
                        ao lado) — exibe o último dia de USO, não o vencimento
                        repetido. */}
                    <td className="px-3 text-fg-mute">{formatDate(l.period_start)} a {formatDate(displayPeriodEnd(l.period_end))}</td>
                    <td className="px-3 text-fg-soft">{formatDate(l.due_date)}</td>
                    <td className="px-3 text-right font-mono text-fg">{formatCurrency(l.amount)}</td>
                    <td className="px-3 text-right"><EmissionTag line={l} /></td>
                  </tr>
                ))}
              </Table>
            </Section>
          )}

          {hasChanges && (
            <div className={`${cardCls} space-y-1 text-[13px]`}>
              <Row label="Substituído do plano" value={formatCurrency(plan.totals.superseded)} />
              <Row label="Cancelado (emitido)"  value={formatCurrency(plan.totals.cancelled)} />
              <Row label="Criado"               value={formatCurrency(plan.totals.created)} strong />
              <div className="mt-2 flex justify-between border-t border-divider pt-2">
                <span className="text-fg-mute">Diferença</span>
                <span className={`tabular-nums font-medium ${plan.totals.delta >= 0 ? 'text-success' : 'text-danger'}`}>
                  {plan.totals.delta >= 0 ? '+' : ''}{formatCurrency(plan.totals.delta)}
                </span>
              </div>
            </div>
          )}

          {plan.warnings.map((w) => (
            <Notice key={w.code} tone="pending" icon={<AlertTriangle className="h-4 w-4" />}>
              {w.message}
            </Notice>
          ))}

          {error && (
            <Notice tone="danger" icon={<AlertCircle className="h-4 w-4" />}>{error}</Notice>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Peças locais ─────────────────────────────────────────────────────────────

/** Rótulo + campo, mostrando o valor anterior riscado quando ele mudou. */
function Field({ label, was, children }: { label: string; was?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <label className={labelCls}>{label}</label>
        {was && <span className="mb-1.5 text-[12px] text-fg-mute line-through">{was}</span>}
      </div>
      {children}
    </div>
  )
}

function Section({
  title, note, tone, children,
}: {
  title: string; note?: string; tone?: 'danger'; children: React.ReactNode
}) {
  return (
    <div className={cardCls}>
      <p className={`text-[13px] font-semibold ${tone === 'danger' ? 'text-danger' : 'text-fg'}`}>{title}</p>
      {note && <p className="mt-0.5 text-[12px] text-fg-mute">{note}</p>}
      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-divider">{children}</div>
    </div>
  )
}

type Column = { label: string; right?: boolean }

function Table({ head, children }: { head: Column[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-divider text-left text-fg-mute">
          {head.map((c) => (
            <th key={c.label} className={`h-8 px-3 font-normal ${c.right ? 'text-right' : ''}`}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

/**
 * Quando a parcela vira documento.
 *
 * `critical` é o token de alarme universal (ADR 0020) — cobrança que nasce
 * vencida já entra com encargo correndo, e isso precisa saltar antes do clique,
 * não depois.
 */
function EmissionTag({ line }: { line: PlannedScheduleLine }) {
  if (line.born_overdue) {
    return <span className="rounded-full bg-critical-bg px-2 py-0.5 text-[12px] text-critical">Já vencida</span>
  }
  if (line.emits_now) {
    return <span className="rounded-full bg-pending-bg px-2 py-0.5 text-[12px] text-pending">Emite agora</span>
  }
  return <span className="text-[12px] text-fg-mute">{formatDate(line.period_start)}</span>
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-fg-mute">{label}</span>
      <span className={`tabular-nums ${strong ? 'font-medium text-fg' : 'text-fg-soft'}`}>{value}</span>
    </div>
  )
}

function Notice({
  tone, icon, children,
}: {
  tone: 'danger' | 'pending'; icon?: React.ReactNode; children: React.ReactNode
}) {
  const cls = {
    danger:  'border-danger bg-danger-bg text-danger',
    pending: 'border-pending bg-pending-bg text-pending',
  }[tone]
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px] ${cls}`}>
      <span className="mt-0.5 shrink-0">{icon ?? <Info className="h-4 w-4" />}</span>
      <p className="leading-relaxed">{children}</p>
    </div>
  )
}
