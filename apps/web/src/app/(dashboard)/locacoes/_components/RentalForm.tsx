'use client'

import { useState, useMemo, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'

import { useCustomers, useAvailableVehicles, useContractTemplates, useContractTemplate, useInspectionProfiles } from '@gomoto/data'
import { generateCycleCharges, WEEK_DAY_OPTIONS, formatDueDay, resolveContractVariables, substituteVariables } from '@gomoto/core'
import type { CycleCharge, Rental } from '@gomoto/core'
import { formatCurrency, formatDate } from '@/lib/utils'
import { renderContractTemplateHtml } from '@/lib/contract-render'
import { printHtmlDocument, buildContractFileName } from '@/lib/contract-print'
import { createRental, updateRental, updateContractTemplate, getCustomerDelinquency } from '../actions'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface RentalFormProps {
  rentalId?: string
  // security_deposit/down_payment não são coluna de rentals (vivem em
  // `deposits`/`billings`) — a página de edição computa os valores à parte
  // e injeta aqui como campos extra.
  initialData?: Partial<Rental> & {
    security_deposit?: number | null
    down_payment?: number | null
    down_payment_status?: string | null
    down_payment_due_date?: string | null
  }
  defaultCustomerId?: string
  // Usado na variável {{nome_empresa}} ao gerar o contrato — só relevante na criação.
  tenantName?: string
}

type FormState = {
  vehicle_id:       string
  customer_id:      string
  contract_type:    'rental' | 'rent_to_own'
  cycle:            'weekly' | 'monthly'
  due_day:          string
  cycle_amount:     string
  start_date:       string
  end_date:         string
  use_pro_rata:     boolean
  km_initial:       string
  security_deposit: string
  down_payment:          string
  down_payment_due_date: string
  contract_template_id: string
  observations:     string
  checkin_checkout_inspection_profile_id: string
  periodic_inspection_profile_id:         string
  periodic_inspection_frequency_days:     string
  // Multa por rescisão antecipada e prazo mínimo de contrato (Spec 0015) —
  // opcionais, configuráveis por locação.
  early_termination_fine_amount: string
  minimum_term_days:             string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const labelCls    = 'block text-[13px] text-fg-mute mb-1.5'
const inputCls    = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-border text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-primary transition-all'
const selectCls   = inputCls
const inputErrCls = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-danger text-[13px] text-fg outline-none focus:border-danger transition-all'
const readOnlyCls = 'flex h-9 w-full items-center rounded-lg border border-divider bg-surface px-3 text-[13px] text-fg-soft'

const CONTRACT_TYPE_LABEL = { rental: 'Locação', rent_to_own: 'Compra Programada' }
const CYCLE_LABEL         = { weekly: 'Semanal', monthly: 'Mensal' }

function computeEndDate(startDate: string, qty: number, unit: 'months' | 'weeks'): string {
  if (!startDate || qty <= 0) return ''
  const [y, m, d] = startDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (unit === 'months') {
    date.setMonth(date.getMonth() + qty)
  } else {
    date.setDate(date.getDate() + qty * 7)
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function computePeriod(start: string, end: string, cycle: 'monthly' | 'weekly'): string {
  if (!start || !end) return ''
  const s = new Date(start)
  const e = new Date(end)
  if (e <= s) return ''
  if (cycle === 'monthly') {
    const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth())
    return String(Math.max(1, months))
  }
  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000)
  return String(Math.max(1, Math.floor(days / 7)))
}

function buildInitialForm(
  d?: Partial<Rental> & {
    security_deposit?: number | null
    down_payment?: number | null
    down_payment_due_date?: string | null
  },
  defaultCustomerId?: string,
): FormState {
  return {
    vehicle_id:       d?.vehicle_id ?? '',
    customer_id:      d?.customer_id ?? defaultCustomerId ?? '',
    contract_type:    d?.contract_type ?? 'rental',
    cycle:            d?.cycle ?? 'monthly',
    due_day:          String(d?.due_day ?? 10),
    cycle_amount:     d?.cycle_amount != null ? String(d.cycle_amount) : '',
    start_date:       d?.start_date ?? '',
    end_date:         d?.end_date ?? '',
    use_pro_rata:     d?.use_pro_rata ?? true,
    km_initial:       d?.km_initial != null ? String(d.km_initial) : '',
    security_deposit: d?.security_deposit != null ? String(d.security_deposit) : '',
    down_payment:          d?.down_payment != null ? String(d.down_payment) : '',
    down_payment_due_date: d?.down_payment_due_date ?? '',
    contract_template_id: d?.contract_template_id ?? '',
    observations:     d?.observations ?? '',
    checkin_checkout_inspection_profile_id: '',
    periodic_inspection_profile_id:         '',
    periodic_inspection_frequency_days:     '',
    early_termination_fine_amount: d?.early_termination_fine_amount != null ? String(d.early_termination_fine_amount) : '',
    minimum_term_days:             d?.minimum_term_days != null ? String(d.minimum_term_days) : '',
  }
}

// ─── ChargePreview ────────────────────────────────────────────────────────────

type ExtraChargeRow = { due_date: string; label: string; amount: number }

function ChargePreview({ charges, extraRows = [] }: { charges: CycleCharge[]; extraRows?: ExtraChargeRow[] }) {
  if (charges.length === 0 && extraRows.length === 0) return null
  const total = charges.reduce((s, c) => s + c.amount, 0) + extraRows.reduce((s, r) => s + r.amount, 0)
  const count = charges.length + extraRows.length
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold text-fg">
        {count} cobrança{count !== 1 ? 's' : ''} · {formatCurrency(total)} total
      </p>
      <div className="max-h-52 overflow-y-auto rounded-lg border border-divider">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-divider text-left text-fg-mute">
              <th className="h-8 px-3 font-normal">Vencimento</th>
              <th className="h-8 px-3 font-normal">Tipo</th>
              <th className="h-8 px-3 text-right font-normal">Valor</th>
            </tr>
          </thead>
          <tbody>
            {charges.map((c, i) => (
              <tr key={i} className="h-9 border-b border-border last:border-0">
                <td className="px-3 text-fg-soft">{formatDate(c.due_date)}</td>
                <td className="px-3 text-fg-mute">
                  {c.billing_type === 'cycle' ? 'Ciclo' : 'Complementar'}
                </td>
                <td className="px-3 text-right font-mono text-fg">{formatCurrency(c.amount)}</td>
              </tr>
            ))}
            {extraRows.map((r, i) => (
              <tr key={`extra-${i}`} className="h-9 border-b border-border last:border-0">
                <td className="px-3 text-fg-soft">{formatDate(r.due_date)}</td>
                <td className="px-3 text-fg-mute">{r.label}</td>
                <td className="px-3 text-right font-mono text-fg">{formatCurrency(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── RentalForm ───────────────────────────────────────────────────────────────

export function RentalForm({ rentalId, initialData, defaultCustomerId, tenantName }: RentalFormProps) {
  const isEditMode = !!rentalId
  const router     = useRouter()
  const [isPending, startTransition] = useTransition()

  const customersQuery = useCustomers()
  const vehiclesQuery  = useAvailableVehicles()
  const templatesQuery = useContractTemplates()
  const inspectionProfilesQuery = useInspectionProfiles()

  const activeInspectionProfiles = useMemo(
    () => (inspectionProfilesQuery.data ?? []).filter(p => p.archived_at === null).sort((a, b) => a.name.localeCompare(b.name)),
    [inspectionProfilesQuery.data],
  )

  const customers = useMemo(
    () => (customersQuery.data ?? []).filter(c => c.active).sort((a,b) => a.name.localeCompare(b.name)),
    [customersQuery.data],
  )
  const vehicles = useMemo(
    () => (vehiclesQuery.data ?? []).sort((a, b) => a.license_plate.localeCompare(b.license_plate)),
    [vehiclesQuery.data],
  )

  const [form, setForm] = useState<FormState>(() => buildInitialForm(initialData, defaultCustomerId))
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({})

  const [periodQty, setPeriodQty] = useState('3')

  // Caução gera cobrança própria — paga (default, preserva o comportamento
  // de quem já recebe em dinheiro na assinatura) ou pendente até o cliente pagar.
  const [depositPaid, setDepositPaid] = useState(true)
  const [depositPaymentDate, setDepositPaymentDate] = useState(() => todayISO())
  const [depositDueDate, setDepositDueDate] = useState('')

  // Entrada (Spec 0010) — opcional, não reembolsável, definida só na criação
  // (RN-002). Mesma dinâmica paga/pendente da Caução, mas sem saldo a rastrear.
  const [downPaymentPaid, setDownPaymentPaid] = useState(true)
  const [downPaymentPaymentDate, setDownPaymentPaymentDate] = useState(() => todayISO())
  const [downPaymentDueDate, setDownPaymentDueDate] = useState('')
  const isDownPaymentPaid = initialData?.down_payment_status === 'paid'
  const isDownPaymentEditable = initialData?.down_payment != null && initialData?.down_payment_status === 'pending'

  // Modelo de contrato — só na criação; geração roda no client com os dados
  // já preenchidos no form, sem depender da locação existir no banco ainda.
  const selectedTemplateQuery = useContractTemplate(form.contract_template_id)
  const [generatingContract, setGeneratingContract] = useState(false)
  const [contractError, setContractError] = useState<string | null>(null)

  async function handleGenerateContract() {
    setContractError(null)
    const template = selectedTemplateQuery.data
    const customer = customers.find(c => c.id === form.customer_id)
    const vehicle  = vehicles.find(v => v.id === form.vehicle_id)
    if (!template || !customer || !vehicle) {
      setContractError('Selecione cliente, veículo e modelo antes de gerar o contrato.')
      return
    }
    setGeneratingContract(true)
    try {
      const html = renderContractTemplateHtml(template.content)
      if (!html) {
        setContractError('Este modelo ainda não possui conteúdo.')
        return
      }
      const variables = resolveContractVariables({
        customer,
        vehicle,
        rental: {
          cycle:        form.cycle,
          due_day:      parseInt(form.due_day, 10),
          cycle_amount: parseFloat(form.cycle_amount) || 0,
          start_date:   form.start_date,
          end_date:     form.end_date,
          security_deposit: form.security_deposit ? parseFloat(form.security_deposit) : null,
          km_initial:   form.km_initial ? parseInt(form.km_initial, 10) : null,
        },
        tenantName: tenantName ?? '',
      })
      const fileName = buildContractFileName({
        customerName: customer.name,
        licensePlate: vehicle.license_plate,
        startDate: form.start_date,
      })
      await printHtmlDocument(substituteVariables(html, variables), fileName)
    } finally {
      setGeneratingContract(false)
    }
  }

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }))
  }

  function handleStartDateChange(value: string) {
    const n = parseInt(periodQty, 10)
    const unit = form.cycle === 'monthly' ? 'months' : 'weeks'
    const computed = n > 0 && value ? computeEndDate(value, n, unit) : ''
    setForm(f => ({
      ...f,
      start_date: value,
      ...(computed ? { end_date: computed } : {}),
    }))
  }

  function handleEndDateChange(value: string) {
    set('end_date', value)
    const period = computePeriod(form.start_date, value, form.cycle)
    if (period) setPeriodQty(period)
  }

  function handlePeriodChange(qty: string) {
    setPeriodQty(qty)
    const n = parseInt(qty, 10)
    if (n > 0 && form.start_date) {
      const unit = form.cycle === 'monthly' ? 'months' : 'weeks'
      const computed = computeEndDate(form.start_date, n, unit)
      if (computed) set('end_date', computed)
    }
  }

  const previewCharges = useMemo<CycleCharge[]>(() => {
    const dueDay = parseInt(form.due_day, 10)
    const amount = parseFloat(form.cycle_amount)
    if (
      !form.start_date || !form.end_date ||
      isNaN(dueDay) || dueDay < 1 || dueDay > 28 ||
      isNaN(amount) || amount <= 0 ||
      form.end_date <= form.start_date
    ) return []
    try {
      return generateCycleCharges({
        start_date:   form.start_date,
        end_date:     form.end_date,
        cycle:        form.cycle,
        due_day:      dueDay,
        cycle_amount: amount,
        use_pro_rata: form.use_pro_rata,
      })
    } catch { return [] }
  }, [form.start_date, form.end_date, form.cycle, form.due_day, form.cycle_amount, form.use_pro_rata])

  /**
   * Garantias que viram documento junto com o cronograma.
   *
   * A caução ficava de fora do preview: o resumo dizia "Caução R$ 800" e a
   * lista abaixo não a incluía, nem no total. Quem confirmava via "R$ 2.100" e
   * criava R$ 2.900 em documentos. Caução é cobrança como as outras — só
   * credita passivo em vez de receita.
   */
  const guaranteePreviewRows = useMemo<ExtraChargeRow[]>(() => {
    const rows: ExtraChargeRow[] = []

    const deposit = parseFloat(form.security_deposit)
    if (deposit > 0) {
      const due = depositPaid ? depositPaymentDate : (depositDueDate || form.start_date)
      if (due) rows.push({ due_date: due, label: 'Caução', amount: deposit })
    }

    const down = parseFloat(form.down_payment)
    if (down > 0) {
      const due = downPaymentPaid ? downPaymentPaymentDate : (downPaymentDueDate || form.start_date)
      if (due) rows.push({ due_date: due, label: 'Entrada', amount: down })
    }

    return rows
  }, [
    form.security_deposit, form.down_payment, form.start_date,
    depositPaid, depositPaymentDate, depositDueDate,
    downPaymentPaid, downPaymentPaymentDate, downPaymentDueDate,
  ])

  const totalPreviewCount = previewCharges.length + guaranteePreviewRows.length

  /**
   * Inadimplência AVISA, não impede (decisão do Alan, 2026-08-15).
   *
   * `createRental` recusava a locação para cliente bloqueado. Quem decide se
   * vale a pena locar para quem está devendo é a empresa, caso a caso — o
   * sistema mostra a situação e o operador escolhe.
   */
  const [delinquency, setDelinquency] = useState<{
    status: string; overdue_count: number; max_days_overdue: number
    overdue_amount: number; manually_blocked: boolean
  } | null>(null)

  useEffect(() => {
    if (!form.customer_id) { setDelinquency(null); return }
    let ativo = true
    getCustomerDelinquency(form.customer_id).then((r: Awaited<ReturnType<typeof getCustomerDelinquency>>) => {
      if (ativo) setDelinquency(r.ok ? r.data : null)
    })
    return () => { ativo = false }
  }, [form.customer_id])


  /**
   * Aviso de inadimplência — exibido nos DOIS passos.
   *
   * No passo 1 ele aparece ao escolher o cliente, para o operador saber antes
   * de preencher. No passo 2 aparece de novo, ao lado do botão que cria a
   * locação: é ali que a decisão acontece, e um aviso que ficou para trás não
   * decide nada.
   */
  const avisoInadimplencia = delinquency && (delinquency.manually_blocked || delinquency.overdue_count > 0) ? (
    <div className="rounded-lg border border-pending bg-pending-bg px-3 py-2">
      <p className="text-[13px] font-medium text-pending">
        {delinquency.manually_blocked
          ? 'Cliente bloqueado manualmente'
          : 'Cliente com cobranças vencidas'}
      </p>
      <p className="mt-0.5 text-[12px] text-fg-soft">
        {delinquency.overdue_count > 0
          ? `${delinquency.overdue_count} vencida${delinquency.overdue_count !== 1 ? 's' : ''} · ${formatCurrency(delinquency.overdue_amount)} · maior atraso de ${delinquency.max_days_overdue} dia${delinquency.max_days_overdue !== 1 ? 's' : ''}`
          : 'Sem cobranças vencidas no momento.'}
      </p>
      <p className="mt-1 text-[12px] text-fg-mute">
        A locação não fica impedida — a decisão é sua.
      </p>
    </div>
  ) : null

  const isFormReady = Boolean(
    form.vehicle_id && form.customer_id && form.start_date && form.end_date &&
    form.cycle_amount && form.due_day && form.end_date > form.start_date &&
    (isEditMode || form.km_initial !== '')
  )

  function validateStep() {
    const errors: typeof fieldErrors = {}
    if (!form.vehicle_id)   errors.vehicle_id  = 'Selecione um veículo'
    if (!form.customer_id)  errors.customer_id = 'Selecione um cliente'
    if (!form.start_date)   errors.start_date  = 'Data de início obrigatória'
    if (!form.end_date)     errors.end_date    = 'Data de fim obrigatória'
    if (form.end_date && form.start_date && form.end_date <= form.start_date)
      errors.end_date = 'Data de fim deve ser posterior ao início'
    if (!form.cycle_amount || parseFloat(form.cycle_amount) <= 0)
      errors.cycle_amount = 'Informe o valor do ciclo'
    if (!isEditMode) {
      const km = parseInt(form.km_initial, 10)
      const vehicleKm = vehicles.find(v => v.id === form.vehicle_id)?.km_current ?? 0
      if (form.km_initial === '' || isNaN(km) || km < 0) {
        errors.km_initial = 'Informe o km inicial'
      } else if (km < vehicleKm) {
        errors.km_initial = `Km não pode ser menor que ${vehicleKm.toLocaleString('pt-BR')} (km atual do veículo)`
      }
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  function handleNext() {
    if (validateStep() && previewCharges.length > 0) setStep('preview')
  }

  function handleSubmit() {
    setGlobalError(null)
    startTransition(async () => {
      if (isEditMode) {
        // Editar só grava caução + observações + modelo de contrato — tudo
        // que afeta cobranças (valor, ciclo, dia, datas) passa por
        // Reajustar/Renovar/Encerrar.
        const result = await updateRental(rentalId!, {
          observations:     form.observations || null,
          security_deposit: form.security_deposit ? parseFloat(form.security_deposit) : null,
          ...(isDownPaymentEditable ? {
            down_payment:          form.down_payment ? parseFloat(form.down_payment) : null,
            down_payment_due_date: form.down_payment_due_date || undefined,
          } : {}),
          early_termination_fine_amount: form.early_termination_fine_amount ? parseFloat(form.early_termination_fine_amount) : null,
          minimum_term_days:             form.minimum_term_days ? parseInt(form.minimum_term_days, 10) : null,
        })
        if (!result.ok) { setGlobalError(result.error.message); return }

        const templateResult = await updateContractTemplate(rentalId!, form.contract_template_id || null)
        if (!templateResult.ok) { setGlobalError(templateResult.error.message); return }

        router.push(`/locacoes/${rentalId}`)
        return
      }

      // RN-005 — frequência é obrigatória quando o vínculo periódico é associado
      if (form.periodic_inspection_profile_id && !form.periodic_inspection_frequency_days) {
        setGlobalError('Informe a frequência da vistoria periódica.')
        return
      }

      const result = await createRental({
        vehicle_id:       form.vehicle_id,
        customer_id:      form.customer_id,
        contract_type:    form.contract_type,
        cycle:            form.cycle,
        due_day:          parseInt(form.due_day, 10),
        cycle_amount:     parseFloat(form.cycle_amount),
        start_date:       form.start_date,
        end_date:         form.end_date,
        use_pro_rata:     form.use_pro_rata,
        km_initial:       parseInt(form.km_initial, 10),
        security_deposit:     form.security_deposit ? parseFloat(form.security_deposit) : null,
        deposit_paid:         depositPaid,
        deposit_payment_date: depositPaid ? depositPaymentDate : undefined,
        deposit_due_date:     !depositPaid ? (depositDueDate || form.start_date || undefined) : undefined,
        down_payment:              form.down_payment ? parseFloat(form.down_payment) : null,
        down_payment_paid:         downPaymentPaid,
        down_payment_payment_date: downPaymentPaid ? downPaymentPaymentDate : undefined,
        down_payment_due_date:     !downPaymentPaid ? (downPaymentDueDate || form.start_date || undefined) : undefined,
        contract_template_id: form.contract_template_id || null,
        observations:     form.observations || null,
        checkin_checkout_inspection_profile_id: form.checkin_checkout_inspection_profile_id || null,
        periodic_inspection_profile_id:         form.periodic_inspection_profile_id || null,
        periodic_inspection_frequency_days:     form.periodic_inspection_profile_id && form.periodic_inspection_frequency_days
          ? parseInt(form.periodic_inspection_frequency_days, 10)
          : null,
        early_termination_fine_amount: form.early_termination_fine_amount ? parseFloat(form.early_termination_fine_amount) : null,
        minimum_term_days:             form.minimum_term_days ? parseInt(form.minimum_term_days, 10) : null,
      })
      if (!result.ok) { setGlobalError(result.error.message); return }
      router.push(`/locacoes/${result.data.lease_id}`)
    })
  }

  // Em edição, cliente/veículo vêm do relacionamento já carregado (initialData) —
  // as listas de useCustomers/useAvailableVehicles não incluem necessariamente o
  // cliente/veículo já vinculados (ex.: veículo alugado não aparece em "disponíveis").
  const customerName = isEditMode
    ? (initialData?.customer?.name ?? '—')
    : (customers.find(c => c.id === form.customer_id)?.name ?? '—')
  const vehicleLabel = vehicles.find(v => v.id === form.vehicle_id)
  const vehicleName  = isEditMode
    ? (initialData?.vehicle
        ? `${initialData.vehicle.license_plate} — ${initialData.vehicle.make} ${initialData.vehicle.model}`
        : '—')
    : (vehicleLabel ? `${vehicleLabel.license_plate} — ${vehicleLabel.make} ${vehicleLabel.model}` : '—')

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Sticky header ────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-bg px-6 backdrop-blur">
        <Link href="/locacoes" className="whitespace-nowrap text-[13px] text-fg-mute transition-colors hover:text-fg">
          ← Locações
        </Link>
        <span className="text-fg-mute">/</span>
        <h1 className="flex-1 truncate text-[15px] font-bold text-fg">
          {isEditMode ? 'Editar locação' : 'Nova locação'}
        </h1>
        {!isEditMode && step === 'preview' && (
          <button
            type="button"
            onClick={() => setStep('form')}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" />
            Editar
          </button>
        )}
        <Link
          href="/locacoes"
          className="inline-flex h-8 items-center rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
        >
          Cancelar
        </Link>
        {isEditMode ? (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="inline-flex h-8 items-center rounded-full bg-primary px-5 text-[13px] font-bold text-bg transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {isPending ? 'Salvando…' : 'Salvar'}
          </button>
        ) : step === 'form' ? (
          <button
            type="button"
            onClick={handleNext}
            disabled={!isFormReady || previewCharges.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-5 text-[13px] font-bold text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            Preview
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="inline-flex h-8 items-center rounded-full bg-primary px-5 text-[13px] font-bold text-bg transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {/* Mesma contagem da lista: o botão somava só os ciclos e dizia "4"
                enquanto o cabeçalho dizia "5". */}
            {isPending
              ? 'Criando…'
              : `Confirmar — ${totalPreviewCount} cobrança${totalPreviewCount !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      <div className="mx-auto max-w-3xl px-6 py-8">

        {isEditMode || step === 'form' ? (
          <div className="space-y-8">

            {/* ── Seção: Partes ─────────────────────────────────────────── */}
            <section>
              <h2 className="mb-5 text-[14px] font-bold text-primary">Partes do contrato</h2>
              {isEditMode ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Cliente</label>
                      <div className={readOnlyCls}>{customerName}</div>
                    </div>
                    <div>
                      <label className={labelCls}>Veículo</label>
                      <div className={`${readOnlyCls} font-mono`}>{vehicleName}</div>
                    </div>
                  </div>
                  <p className="text-[12px] text-fg-mute">
                    Cliente e veículo não podem ser alterados. Para trocar, encerre esta locação e crie uma nova.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Cliente *</label>
                    <select
                      className={fieldErrors.customer_id ? inputErrCls : selectCls}
                      value={form.customer_id}
                      onChange={e => set('customer_id', e.target.value)}
                    >
                      <option value="">Selecione um cliente…</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {avisoInadimplencia && (
                      <div className="mt-2">{avisoInadimplencia}</div>
                    )}
                    {fieldErrors.customer_id && (
                      <p className="mt-1 text-[12px] text-danger">{fieldErrors.customer_id}</p>
                    )}
                  </div>
                  <div>
                    <label className={labelCls}>Veículo *</label>
                    <select
                      className={fieldErrors.vehicle_id ? inputErrCls : selectCls}
                      value={form.vehicle_id}
                      onChange={e => {
                        const vehicleId = e.target.value
                        const vehicle = vehicles.find(v => v.id === vehicleId)
                        setForm(f => ({
                          ...f,
                          vehicle_id: vehicleId,
                          // Pré-preenchido com o km atual do veículo — editável,
                          // mas evita o operador digitar do zero o caso comum
                          // (entrega no mesmo km que o veículo já registra).
                          km_initial: vehicle?.km_current != null ? String(vehicle.km_current) : f.km_initial,
                        }))
                      }}
                    >
                      <option value="">Selecione um veículo…</option>
                      {vehicles.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.license_plate} — {v.make} {v.model}
                        </option>
                      ))}
                    </select>
                    {fieldErrors.vehicle_id && (
                      <p className="mt-1 text-[12px] text-danger">{fieldErrors.vehicle_id}</p>
                    )}
                  </div>
                </div>
              )}
              {!isEditMode && form.vehicle_id && (
                <div className="mt-4 max-w-xs">
                  <label className={labelCls}>Km inicial *</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Km do veículo na entrega"
                    className={fieldErrors.km_initial ? inputErrCls : inputCls}
                    value={form.km_initial}
                    onChange={e => set('km_initial', e.target.value)}
                  />
                  {fieldErrors.km_initial ? (
                    <p className="mt-1 text-[12px] text-danger">{fieldErrors.km_initial}</p>
                  ) : (
                    <p className="mt-1 text-[12px] text-fg-mute">
                      Km do veículo no momento da entrega — é o km impresso no contrato.
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* ── Seção: Condições ──────────────────────────────────────── */}
            <section>
              <h2 className="mb-5 text-[14px] font-bold text-primary">Condições do contrato</h2>
              {isEditMode ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Tipo de contrato</label>
                      <div className={readOnlyCls}>{CONTRACT_TYPE_LABEL[form.contract_type]}</div>
                    </div>
                    <div>
                      <label className={labelCls}>Ciclo de cobrança</label>
                      <div className={readOnlyCls}>{CYCLE_LABEL[form.cycle]}</div>
                    </div>
                    <div>
                      <label className={labelCls}>Vencimento</label>
                      <div className={readOnlyCls}>{formatDueDay(form.cycle, form.due_day)}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Valor do ciclo</label>
                      <div className={readOnlyCls}>{formatCurrency(parseFloat(form.cycle_amount) || 0)}</div>
                    </div>
                    <div>
                      <label className={labelCls}>Data de início</label>
                      <div className={readOnlyCls}>{form.start_date ? formatDate(form.start_date) : '—'}</div>
                    </div>
                    <div>
                      <label className={labelCls}>Data de fim</label>
                      <div className={readOnlyCls}>{form.end_date ? formatDate(form.end_date) : '—'}</div>
                    </div>
                  </div>
                  <div className={`${readOnlyCls} w-fit px-4`}>Pro rata: {form.use_pro_rata ? 'Sim' : 'Não'}</div>
                  <p className="text-[12px] text-fg-mute">
                    Período, ciclo, dia de vencimento e valor → <Link href={`/locacoes/${rentalId}/ajustar`} className="text-primary hover:underline">Ajustar</Link>.{' '}
                    Para encerrar o contrato e liberar o veículo → <Link href={`/locacoes/${rentalId}/encerrar`} className="text-primary hover:underline">Encerrar</Link>.{' '}
                    Tipo, ciclo, dia de vencimento, início e pro rata não podem ser alterados — encerre esta locação e crie uma nova.
                  </p>

                  {/* Multa/prazo mínimo (Spec 0015) — diferente do resto desta
                      seção, continuam editáveis em locação ativa (RF-002). A
                      Server Action recusa se a locação já foi encerrada. */}
                  <div className="grid max-w-md grid-cols-2 gap-4 border-t border-divider pt-4">
                    <div>
                      <label className={labelCls}>Multa por rescisão antecipada (R$)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0,00 — opcional"
                        className={inputCls}
                        value={form.early_termination_fine_amount}
                        onChange={e => set('early_termination_fine_amount', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Prazo mínimo (dias)</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="Opcional"
                        className={inputCls}
                        value={form.minimum_term_days}
                        onChange={e => set('minimum_term_days', e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-[12px] text-fg-mute">
                    Configuração opcional. Se preenchidos, o encerramento dentro do prazo mínimo
                    exibe a multa e o operador decide, na hora, se cobra.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Tipo de contrato</label>
                      <select
                        className={selectCls}
                        value={form.contract_type}
                        onChange={e => set('contract_type', e.target.value as FormState['contract_type'])}
                      >
                        <option value="rental">Locação</option>
                        <option value="rent_to_own">Compra Programada</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Ciclo de cobrança</label>
                      <select
                        className={selectCls}
                        value={form.cycle}
                        onChange={e => {
                          const newCycle = e.target.value as FormState['cycle']
                          const unit = newCycle === 'monthly' ? 'months' : 'weeks'
                          const n = parseInt(periodQty, 10)
                          const computed = n > 0 && form.start_date
                            ? computeEndDate(form.start_date, n, unit)
                            : ''
                          if (!computed && form.start_date && form.end_date) {
                            const newPeriod = computePeriod(form.start_date, form.end_date, newCycle)
                            if (newPeriod) setPeriodQty(newPeriod)
                          }
                          setForm(f => ({
                            ...f,
                            cycle:   newCycle,
                            due_day: newCycle === 'monthly' ? '10' : '1',
                            ...(computed ? { end_date: computed } : {}),
                          }))
                        }}
                      >
                        <option value="monthly">Mensal</option>
                        <option value="weekly">Semanal</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>
                        {form.cycle === 'monthly' ? 'Dia de vencimento' : 'Dia da semana'}
                      </label>
                      {form.cycle === 'monthly' ? (
                        <select
                          className={selectCls}
                          value={form.due_day}
                          onChange={e => set('due_day', e.target.value)}
                        >
                          {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                            <option key={d} value={String(d)}>Dia {d}</option>
                          ))}
                        </select>
                      ) : (
                        <select
                          className={selectCls}
                          value={form.due_day}
                          onChange={e => set('due_day', e.target.value)}
                        >
                          {WEEK_DAY_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Valor do ciclo (R$) *</label>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="0,00"
                        className={fieldErrors.cycle_amount ? inputErrCls : inputCls}
                        value={form.cycle_amount}
                        onChange={e => set('cycle_amount', e.target.value)}
                      />
                      {fieldErrors.cycle_amount && (
                        <p className="mt-1 text-[12px] text-danger">{fieldErrors.cycle_amount}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls}>Data de início *</label>
                      <input
                        type="date"
                        className={fieldErrors.start_date ? inputErrCls : inputCls}
                        value={form.start_date}
                        onChange={e => handleStartDateChange(e.target.value)}
                      />
                      {fieldErrors.start_date && (
                        <p className="mt-1 text-[12px] text-danger">{fieldErrors.start_date}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls}>Data de fim *</label>
                      <input
                        type="date"
                        min={form.start_date || undefined}
                        className={fieldErrors.end_date ? inputErrCls : inputCls}
                        value={form.end_date}
                        onChange={e => handleEndDateChange(e.target.value)}
                      />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <input
                          type="number"
                          min="1"
                          max="120"
                          className="h-7 w-14 rounded-md border border-divider bg-surface-2 px-2 text-[12px] text-fg outline-none focus:border-primary"
                          value={periodQty}
                          onChange={e => handlePeriodChange(e.target.value)}
                        />
                        <span className="text-[12px] text-fg-mute">
                          {form.cycle === 'monthly' ? 'meses' : 'semanas'}
                        </span>
                      </div>
                      {fieldErrors.end_date && (
                        <p className="mt-1 text-[12px] text-danger">{fieldErrors.end_date}</p>
                      )}
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-soft">
                    <input
                      type="checkbox"
                      checked={form.use_pro_rata}
                      onChange={e => set('use_pro_rata', e.target.checked)}
                      className="rounded accent-primary"
                    />
                    Calcular pro rata na primeira e última cobranças
                  </label>

                  {/* Multa por rescisão antecipada e prazo mínimo (Spec 0015) —
                      opcionais, configuráveis por locação. */}
                  <div className="grid max-w-md grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Multa por rescisão antecipada (R$)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0,00 — opcional"
                        className={inputCls}
                        value={form.early_termination_fine_amount}
                        onChange={e => set('early_termination_fine_amount', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Prazo mínimo (dias)</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="Opcional"
                        className={inputCls}
                        value={form.minimum_term_days}
                        onChange={e => set('minimum_term_days', e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-[12px] text-fg-mute">
                    Configuração opcional. Se preenchidos, o encerramento dentro do prazo mínimo
                    exibe a multa e o operador decide, na hora, se cobra.
                  </p>
                </div>
              )}
            </section>

            {/* Encargo por atraso não é mais configuração por locação (R-07/R-08).
                A seção coletava multa, juros e carência, montava
                `late_charge_config` — e o valor morria aqui: `createRental` não
                o inclui no payload da RPC, `rentals` não tem essas colunas, e a
                emissão sempre resolve a política vigente do tenant em
                `late_charge_policies`. O operador ajustava juros para um
                contrato e o sistema cobrava outro, sem avisar. A mesma remoção
                já havia sido feita na tela de reajuste. */}

            {/* ── Seção: Financeiro ─────────────────────────────────────── */}
            <section>
              <h2 className="mb-5 text-[14px] font-bold text-primary">Garantias e observações</h2>
              <div className="space-y-4">
                <div className="max-w-xs">
                  <label className={labelCls}>Caução / depósito de segurança (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0,00 — opcional"
                    className={inputCls}
                    value={form.security_deposit}
                    onChange={e => set('security_deposit', e.target.value)}
                  />
                  <p className="mt-1 text-[12px] text-fg-mute">
                    Valor retido como garantia. Devolvido ao encerrar.
                  </p>
                  {!isEditMode && form.security_deposit && (
                    <>
                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] text-fg-soft">
                        <input
                          type="checkbox"
                          checked={depositPaid}
                          onChange={e => setDepositPaid(e.target.checked)}
                          className="rounded accent-primary"
                        />
                        Caução já foi paga
                      </label>
                      <div className="mt-2">
                        {depositPaid ? (
                          <>
                            <label className={labelCls}>Data do pagamento</label>
                            <input
                              type="date"
                              className={inputCls}
                              value={depositPaymentDate}
                              onChange={e => setDepositPaymentDate(e.target.value)}
                            />
                          </>
                        ) : (
                          <>
                            <label className={labelCls}>Data de vencimento</label>
                            <input
                              type="date"
                              className={inputCls}
                              value={depositDueDate || form.start_date}
                              onChange={e => setDepositDueDate(e.target.value)}
                            />
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="max-w-xs">
                  <label className={labelCls}>Entrada (R$)</label>
                  {isEditMode ? (
                    initialData?.down_payment == null ? (
                      <p className="text-[12px] text-fg-mute">
                        Nenhuma Entrada foi definida na criação desta locação.
                      </p>
                    ) : isDownPaymentPaid ? (
                      <>
                        <div className={readOnlyCls}>{formatCurrency(initialData.down_payment)}</div>
                        <p className="mt-1 text-[12px] text-fg-mute">
                          Entrada já paga — não pode ser alterada.
                        </p>
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0,00"
                          className={inputCls}
                          value={form.down_payment}
                          onChange={e => set('down_payment', e.target.value)}
                        />
                        <label className={`${labelCls} mt-2`}>Data de vencimento</label>
                        <input
                          type="date"
                          className={inputCls}
                          value={form.down_payment_due_date}
                          onChange={e => set('down_payment_due_date', e.target.value)}
                        />
                      </>
                    )
                  ) : (
                    <>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0,00 — opcional"
                        className={inputCls}
                        value={form.down_payment}
                        onChange={e => set('down_payment', e.target.value)}
                      />
                      <p className="mt-1 text-[12px] text-fg-mute">
                        Valor não reembolsável, cobrado à parte da Caução.
                      </p>
                      {form.down_payment && (
                        <>
                          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] text-fg-soft">
                            <input
                              type="checkbox"
                              checked={downPaymentPaid}
                              onChange={e => setDownPaymentPaid(e.target.checked)}
                              className="rounded accent-primary"
                            />
                            Entrada já foi paga
                          </label>
                          <div className="mt-2">
                            {downPaymentPaid ? (
                              <>
                                <label className={labelCls}>Data do pagamento</label>
                                <input
                                  type="date"
                                  className={inputCls}
                                  value={downPaymentPaymentDate}
                                  onChange={e => setDownPaymentPaymentDate(e.target.value)}
                                />
                              </>
                            ) : (
                              <>
                                <label className={labelCls}>Data de vencimento</label>
                                <input
                                  type="date"
                                  className={inputCls}
                                  value={downPaymentDueDate || form.start_date}
                                  onChange={e => setDownPaymentDueDate(e.target.value)}
                                />
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>

                <div>
                  <label className={labelCls}>Observações</label>
                  <textarea
                    className={`${inputCls} h-20 resize-none py-2`}
                    placeholder="Condições especiais, observações do contrato…"
                    value={form.observations}
                    onChange={e => set('observations', e.target.value)}
                    maxLength={2000}
                  />
                </div>
              </div>
            </section>

            {/* ── Seção: Vistoria (Spec 0009 — só na criação) ──────────────── */}
            {!isEditMode && (
              <section>
                <h2 className="mb-5 text-[14px] font-bold text-primary">Vistoria</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Perfil — Check-in/Check-out</label>
                    <select
                      className={selectCls}
                      value={form.checkin_checkout_inspection_profile_id}
                      onChange={e => set('checkin_checkout_inspection_profile_id', e.target.value)}
                    >
                      <option value="">Nenhum — sem check-in/check-out</option>
                      {activeInspectionProfiles.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-[12px] text-fg-mute">
                      Check-in nasce pendente na criação; check-out fica disponível ao encerrar.
                    </p>
                  </div>
                  <div>
                    <label className={labelCls}>Perfil — Vistoria Periódica</label>
                    <select
                      className={selectCls}
                      value={form.periodic_inspection_profile_id}
                      onChange={e => set('periodic_inspection_profile_id', e.target.value)}
                    >
                      <option value="">Nenhum — sem vistoria periódica</option>
                      {activeInspectionProfiles.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    {form.periodic_inspection_profile_id && (
                      <div className="mt-2">
                        <label className={labelCls}>Frequência (dias) *</label>
                        <input
                          type="number" min={1} step={1} placeholder="Ex.: 30"
                          className={inputCls}
                          value={form.periodic_inspection_frequency_days}
                          onChange={e => set('periodic_inspection_frequency_days', e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* ── Seção: Modelo de contrato ──────────────────────────────── */}
            <section>
              <h2 className="mb-5 text-[14px] font-bold text-primary">Modelo de contrato</h2>
              <div className="max-w-md">
                <label className={labelCls}>Modelo (opcional)</label>
                <select
                  className={selectCls}
                  value={form.contract_template_id}
                  onChange={e => set('contract_template_id', e.target.value)}
                >
                  <option value="">Nenhum{!isEditMode ? ' — gerar depois' : ''}</option>
                  {(templatesQuery.data ?? []).map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-[12px] text-fg-mute">
                  {isEditMode
                    ? 'Ao salvar, o novo modelo fica vinculado à locação — visualize ou baixe o contrato atualizado na tela de detalhe.'
                    : 'Selecione um modelo para gerar o contrato preenchido na etapa de revisão.'}
                </p>
              </div>
            </section>

            {/* Preview de cobranças (inline) — só na criação */}
            {!isEditMode && previewCharges.length > 0 && (
              <ChargePreview charges={previewCharges} extraRows={guaranteePreviewRows} />
            )}

            {!isEditMode && previewCharges.length === 0 && isFormReady && (
              <p className="text-[13px] text-fg-mute">
                Preencha as datas e valor para visualizar as cobranças.
              </p>
            )}

            {isEditMode && globalError && (
              <div className="flex items-start gap-3 rounded-xl border border-danger bg-danger-bg px-4 py-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <p className="text-[13px] text-danger">{globalError}</p>
              </div>
            )}
          </div>

        ) : (
          /* ── Step 2: Preview ──────────────────────────────────────────── */
          <div className="space-y-6">
            <div className="rounded-xl bg-surface p-5 text-[13px]">
              {avisoInadimplencia && <div className="mb-4">{avisoInadimplencia}</div>}
              <h2 className="mb-4 text-[14px] font-bold text-primary">Resumo do contrato</h2>
              <div className="grid grid-cols-2 gap-x-8 gap-y-2.5">
                {([
                  ['Cliente',     customerName],
                  ['Veículo',     vehicleName],
                  ['Tipo',        CONTRACT_TYPE_LABEL[form.contract_type]],
                  ['Ciclo',       CYCLE_LABEL[form.cycle]],
                  ['Vencimento',  formatDueDay(form.cycle, form.due_day)],
                  ['Valor/ciclo', formatCurrency(parseFloat(form.cycle_amount) || 0)],
                  ['Início', form.start_date ? formatDate(form.start_date) : '—'],
                  ['Fim',    form.end_date   ? formatDate(form.end_date)   : '—'],
                  ['Pro rata',    form.use_pro_rata ? 'Sim' : 'Não'],
                  ['Km inicial',  form.km_initial ? `${parseInt(form.km_initial, 10).toLocaleString('pt-BR')} km` : '—'],
                  ...(form.security_deposit
                    ? [['Caução', formatCurrency(parseFloat(form.security_deposit))]]
                    : []),
                  ...(form.down_payment
                    ? [['Entrada', formatCurrency(parseFloat(form.down_payment))]]
                    : []),
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <span className="min-w-[90px] text-fg-mute">{label}:</span>
                    <span className="text-fg">{value}</span>
                  </div>
                ))}
              </div>
              {form.observations && (
                <div className="mt-4 border-t border-divider pt-4">
                  <span className="text-fg-mute">Observações: </span>
                  <span className="text-fg-soft">{form.observations}</span>
                </div>
              )}
            </div>

            <div className="rounded-xl bg-surface p-5 text-[13px]">
              <h2 className="mb-3 text-[14px] font-bold text-primary">Contrato</h2>
              {form.contract_template_id ? (
                <div className="flex items-center justify-between gap-4">
                  <p className="text-fg-mute">
                    Modelo selecionado: <span className="text-fg">{selectedTemplateQuery.data?.name ?? '…'}</span>
                  </p>
                  <button
                    type="button"
                    onClick={handleGenerateContract}
                    disabled={generatingContract || !selectedTemplateQuery.data}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] text-fg transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {generatingContract ? 'Gerando…' : 'Gerar contrato (PDF)'}
                  </button>
                </div>
              ) : (
                <p className="text-fg-mute">
                  Nenhum modelo selecionado — você poderá anexar o contrato assinado depois de criar a locação.
                </p>
              )}
              {contractError && (
                <p className="mt-2 text-[12px] text-danger">{contractError}</p>
              )}
            </div>

            <ChargePreview charges={previewCharges} extraRows={guaranteePreviewRows} />

            {globalError && (
              <div className="flex items-start gap-3 rounded-xl border border-danger bg-danger-bg px-4 py-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <p className="text-[13px] text-danger">{globalError}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
