'use client'

import { useState, useTransition, useRef, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import {
  Upload,
  Sparkles,
  AlertCircle,
  X,
  Plus,
  Bike,
  Car,
  Check,
  ChevronDown,
  Fingerprint,
  FileText,
  CalendarClock,
  Banknote,
  MapPin,
  ShieldCheck,
  Camera,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import {
  VEHICLE_TYPE_LABELS,
  VEHICLE_PHOTO_SLOT_LABELS,
  VehicleSchema,
  ACQUISITION_TYPE_LABELS,
  type VehiclePhotoSlot,
  type VehicleType,
  type MaintenancePlanItem,
  vehicleTypeFromCrlv,
  canEditKmEntry,
  parseCRLVText,
  crlvSuccessRate,
  applyPlateMask, stripPlate,
  applyRenavamMask, stripRenavam,
  applyCpfMask, applyCnpjMask,
  stripDocument,
  stripIMEI,
  applyCurrencyMask, formatCurrencyInput,
} from '@gomoto/core'
import {
  useSupabaseContext,
  useRequiredTenantId,
  useMaintenancePlans,
  useMaintenancePlan,
} from '@gomoto/data'

import { createVehicle, updateVehicle, deleteVehiclePhoto, saveVehicleObligations, assignMaintenancePlan } from '../actions'
import { DocumentImportCard } from '@/components/documents/DocumentImportCard'
import { VEHICLE_TRACKER_ENABLED } from '@/lib/vehicles/features'

// ─── Constantes ──────────────────────────────────────────────────────────────

const PHOTO_SLOTS: VehiclePhotoSlot[] = ['principal', 'front', 'left_side', 'right_side', 'rear', 'dashboard']

const FUEL_OPTIONS = [
  { value: 'GASOLINA',        label: 'Gasolina' },
  { value: 'ÁLCOOL/GASOLINA', label: 'Flex (Álcool/Gasolina)' },
  { value: 'ELÉTRICO',        label: 'Elétrico' },
]

const OWNER_TYPE_OPTIONS = [
  { value: 'cpf',  label: 'CPF' },
  { value: 'cnpj', label: 'CNPJ' },
]

const OBLIGATION_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendente' },
  { value: 'paid',    label: 'Pago' },
  { value: 'exempt',  label: 'Isento' },
]

const VEHICLE_TYPE_OPTIONS: { value: VehicleType; Icon: LucideIcon }[] = [
  { value: 'motorcycle', Icon: Bike },
  { value: 'car',        Icon: Car },
]

/**
 * Seções opcionais, recolhidas por padrão. O cadastro mostra só o Essencial
 * (placa, tipo, marca, modelo, anos e cor); o resto abre sob demanda e pode
 * ser completado depois, na edição.
 */
const SECTIONS = {
  'sec-complement':  { title: 'Identificação complementar', description: 'RENAVAM, chassi, combustível, cilindrada e observações', icon: Fingerprint },
  'sec-document':    { title: 'Documentação (CRV)',         description: 'Proprietário registrado, CPF/CNPJ, UF, nº do CRV e transferência', icon: FileText },
  'sec-obligations': { title: 'IPVA e licenciamento',       description: 'Valor, vencimento e situação de IPVA, licenciamento e DPVAT', icon: CalendarClock },
  'sec-acquisition': { title: 'Aquisição',                  description: 'Tipo, data da compra, valor pago, FIPE e vendedor', icon: Banknote },
  'sec-tracker':     { title: 'Rastreador GPS',             description: 'Marca, modelo e IMEI', icon: MapPin },
  'sec-insurance':   { title: 'Seguro',                     description: 'Valor mensal e vencimento da apólice', icon: ShieldCheck },
  'sec-photos':      { title: 'Fotos',                      description: 'Principal, frente, laterais, traseira e painel · JPG, PNG ou WebP até 5MB', icon: Camera },
  'sec-maintenance': { title: 'Plano de manutenção',        description: 'Plano e a última vez que cada item foi feito', icon: Wrench },
} satisfies Record<string, { title: string; description: string; icon: LucideIcon }>

type SectionId = keyof typeof SECTIONS

/** Seções que aparecem na tela (o rastreador depende da flag). */
const VISIBLE_SECTIONS = (Object.keys(SECTIONS) as SectionId[])
  .filter((id) => id !== 'sec-tracker' || VEHICLE_TRACKER_ENABLED)

/** Campo com erro → seção que precisa abrir para o operador vê-lo. */
const FIELD_SECTION: Record<string, SectionId> = {
  renavam: 'sec-complement', chassis: 'sec-complement', fuel: 'sec-complement',
  engine_capacity: 'sec-complement', observations: 'sec-complement',
  registered_owner_name: 'sec-document', registered_owner_document: 'sec-document',
  registered_owner_type: 'sec-document', registration_state: 'sec-document',
  crv_number: 'sec-document', crv_exercise_year: 'sec-document',
  ownership_transferred: 'sec-document', ownership_transfer_date: 'sec-document',
  acquisition_type: 'sec-acquisition', purchase_date: 'sec-acquisition', acquisition_amount: 'sec-acquisition',
  fipe_value: 'sec-acquisition', previous_owner: 'sec-acquisition', previous_owner_cpf: 'sec-acquisition',
  tracker_brand: 'sec-tracker', tracker_model: 'sec-tracker', tracker_imei: 'sec-tracker',
  insurance_monthly_amount: 'sec-insurance', insurance_expiry_date: 'sec-insurance',
}

const REQUIRED_TOTAL = 7

// ─── Tipos ───────────────────────────────────────────────────────────────────

type ObligationStatus = 'pending' | 'paid' | 'exempt'
type ObligationEntry  = { amount: string; dueDate: string; status: ObligationStatus }
type ObligationType   = 'ipva' | 'licensing' | 'dpvat'

interface VehicleFormProps {
  vehicleId?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData?: Record<string, any>
  initialPhotoUrls?: Partial<Record<VehiclePhotoSlot, string>>
  initialObligations?: Partial<Record<ObligationType, { amount: string; dueDate: string; status: string } | null>>
}

// ─── Seção recolhível ────────────────────────────────────────────────────────

function CollapsibleSection({
  id, title, description, icon: Icon, filled, autoFilled, open, onToggle, children,
}: {
  id: string
  title: string
  description: string
  icon: LucideIcon
  filled: boolean
  /** algum campo da seção veio do CRLV e ainda não foi mexido */
  autoFilled?: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section id={id} className="border-t border-divider first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={onToggle}
        className="w-full min-h-[52px] px-4 py-2.5 flex items-center gap-3 text-left hover:bg-surface-2 transition-colors"
      >
        <span className="w-7 h-7 rounded-lg bg-surface-2 grid place-items-center text-fg-mute flex-shrink-0">
          <Icon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold text-fg">{title}</span>
          <span className="block text-[12px] text-fg-mute truncate">{description}</span>
        </span>
        {autoFilled ? (
          <span className="h-5 px-2 rounded-full bg-primary-tint text-primary text-[11px] font-semibold inline-flex items-center gap-1 flex-shrink-0">
            <Sparkles className="w-3 h-3" /> Do CRLV
          </span>
        ) : filled && !open && (
          <span className="h-5 px-2 rounded-full bg-success-bg text-success text-[11px] font-semibold inline-flex items-center gap-1 flex-shrink-0">
            <Check className="w-3 h-3" /> Preenchido
          </span>
        )}
        <span className="hidden sm:inline text-[12px] font-semibold text-primary whitespace-nowrap">
          {open ? 'Recolher' : filled ? 'Editar' : 'Adicionar'}
        </span>
        <ChevronDown className={`w-4 h-4 text-fg-mute flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={`${id}-body`} className="px-4 pt-1 pb-5 sm:pl-14">
          {children}
        </div>
      )}
    </section>
  )
}

// ─── Field wrapper ───────────────────────────────────────────────────────────

const labelCls = 'block text-[13px] text-fg-mute mb-1.5'
const inputCls = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-border text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-primary transition-all'
const inputAutoCls = 'w-full h-9 px-3 rounded-lg bg-primary-tint border border-primary text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-primary transition-all'
const inputErrCls = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-danger text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-danger transition-all'

function Field({
  label,
  error,
  children,
  className,
}: {
  label: string
  error?: string
  children: React.ReactNode
  className?: string
}) {
  // O `<label>` ENVOLVE o controle. Antes ele era irmão, sem `htmlFor`: nada
  // associava rótulo e campo, então leitor de tela anunciava um input sem nome
  // e `getByLabel` não encontrava nada — foi por isso que os testes deste form
  // acabaram presos a placeholder e posição.
  return (
    <label className={`block ${className ?? ''}`}>
      <span className={labelCls}>{label}</span>
      {children}
      {error && <p className="text-[12px] text-danger mt-1">{error}</p>}
    </label>
  )
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="w-10 h-5 bg-surface-2 rounded-full peer peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
    </label>
  )
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

function mapCombustivelToFuel(combustivel: string | null | undefined): string | null {
  if (!combustivel) return null
  const u = combustivel.toUpperCase()
  if (u.includes('ELÉTR') || u.includes('ELETR')) return 'ELÉTRICO'
  if (u.includes('FLEX') || u.includes('ÁLCOOL') || u.includes('ALCOOL') || u.includes('ETANOL')) return 'ÁLCOOL/GASOLINA'
  if (u.includes('GASOLINA')) return 'GASOLINA'
  return null
}

function detectOwnerType(doc: string | null | undefined): 'cpf' | 'cnpj' {
  if (!doc) return 'cnpj'
  return doc.replace(/\D/g, '').length === 11 ? 'cpf' : 'cnpj'
}

function planItemMetric(item: MaintenancePlanItem): 'km' | 'date' {
  return item.interval_km != null ? 'km' : 'date'
}

function planItemHint(item: MaintenancePlanItem): string {
  if (item.interval_km != null)   return `a cada ${item.interval_km.toLocaleString('pt-BR')} km`
  if (item.interval_days != null) return `a cada ${item.interval_days} dia${item.interval_days === 1 ? '' : 's'}`
  return ''
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildInitialForm(d?: Record<string, any>) {
  const ownerType = (d?.registered_owner_type ?? 'cnpj') as 'cpf' | 'cnpj'
  const ownerDoc  = d?.registered_owner_document ?? ''
  return {
    // Valor já salvo no banco não passa por applyPlateMask — a máscara é
    // progressiva (posição por posição) e feita pra digitação nova; reaplicada
    // em cima de um valor já completo, ela descarta silenciosamente qualquer
    // caractere fora do formato de placa real (ex.: placas de seed/teste).
    license_plate:             d?.license_plate ?? '',
    // Sem default na criação: o tipo é obrigatório e precisa ser escolhido
    // (ou vir do CRLV). Na edição vem do banco — o DEFAULT da coluna é moto.
    vehicle_type:              (d?.vehicle_type ?? '') as VehicleType | '',
    renavam:                   d?.renavam ? applyRenavamMask(d.renavam) : '',
    make:                      d?.make ?? '',
    model:                     d?.model ?? '',
    year_manufacture:          d?.year_manufacture ?? '',
    year_model:                d?.year_model ?? '',
    color:                     d?.color ?? '',
    fuel:                      d?.fuel ?? 'GASOLINA',
    chassis:                   d?.chassis ?? '',
    engine_capacity:           d?.engine_capacity ? String(d.engine_capacity).replace(/\D/g, '') : '',
    km_entry:                  '',
    observations:              d?.observations ?? '',
    acquisition_type:          d?.acquisition_type ?? 'used',
    purchase_date:             d?.purchase_date ?? '',
    acquisition_amount:        d?.acquisition_amount != null ? formatCurrencyInput(String(d.acquisition_amount)) : '',
    fipe_value:                d?.fipe_value != null ? formatCurrencyInput(String(d.fipe_value)) : '',
    previous_owner:            d?.previous_owner ?? '',
    previous_owner_cpf:        d?.previous_owner_cpf
      ? (stripDocument(d.previous_owner_cpf).length <= 11 ? applyCpfMask(d.previous_owner_cpf) : applyCnpjMask(d.previous_owner_cpf))
      : '',
    registered_owner_name:     d?.registered_owner_name ?? '',
    registered_owner_document: ownerDoc
      ? (ownerType === 'cpf' ? applyCpfMask(ownerDoc) : applyCnpjMask(ownerDoc))
      : '',
    registered_owner_type:     ownerType,
    registration_state:        d?.registration_state ?? '',
    ownership_transferred:     d?.ownership_transferred ? 'true' : 'false',
    ownership_transfer_date:   d?.ownership_transfer_date ?? '',
    crv_number:                '',
    crv_exercise_year:         '',
    has_tracker:               d?.has_tracker ? 'true' : 'false',
    tracker_brand:             d?.tracker_brand ?? '',
    tracker_model:             d?.tracker_model ?? '',
    tracker_imei:              d?.tracker_imei ? String(d.tracker_imei).replace(/\D/g, '').slice(0, 15) : '',
    has_insurance:             d?.has_insurance ? 'true' : 'false',
    insurance_monthly_amount:  d?.insurance_monthly_amount != null ? formatCurrencyInput(String(d.insurance_monthly_amount)) : '',
    insurance_expiry_date:     d?.insurance_expiry_date ?? '',
  }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function VehicleForm({ vehicleId, initialData, initialPhotoUrls = {}, initialObligations }: VehicleFormProps) {
  const isEditMode = !!vehicleId
  // KM de entrada é gravado uma vez só: na edição, o campo aparece enquanto
  // o veículo ainda não tem um (cadastro feito sem ele).
  const showKmEntry = !isEditMode || canEditKmEntry(initialData?.km_entry)

  const router = useRouter()
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const [isPending, startTransition] = useTransition()

  const [form, setForm] = useState(() => buildInitialForm(initialData))
  function set(key: keyof ReturnType<typeof buildInitialForm>, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
    // Editou à mão: o campo deixa de ser "vindo do CRLV".
    setAutoFilled((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  /** Campos preenchidos pela importação do CRLV — destacados até o operador mexer. */
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set())
  function fieldCls(key: string) {
    if (fieldErrors[key]) return inputErrCls
    return autoFilled.has(key) ? inputAutoCls : inputCls
  }

  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)

  /**
   * O aviso de erro fica no RODAPÉ de um formulário longo, e o botão Salvar
   * vive no cabeçalho fixo. Sem rolar até ele, o operador clica em Salvar no
   * topo e não vê absolutamente nada acontecer.
   */
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (globalError) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [globalError])
  const [postWarnings, setPostWarnings] = useState<string[] | null>(null)

  // ── Fotos
  const [photoUrls, setPhotoUrls] = useState<Partial<Record<VehiclePhotoSlot, string>>>(initialPhotoUrls)
  const [pendingFiles, setPendingFiles] = useState<Partial<Record<VehiclePhotoSlot, File>>>({})
  const [uploadingSlot, setUploadingSlot] = useState<VehiclePhotoSlot | null>(null)
  const fileInputRefs = useRef<Partial<Record<VehiclePhotoSlot, HTMLInputElement | null>>>({})

  // ── CRLV
  const [crvFile, setCrvFile] = useState<File | null>(null)
  const [crlvImporting, setCrlvImporting] = useState(false)
  const [crlvMsg, setCrlvMsg] = useState<
    | { kind: 'success'; found: number; total: number; fileName: string }
    | { kind: 'error'; text: string }
    | null
  >(null)

  // ── Obrigações anuais
  const [obligations, setObligations] = useState<Record<ObligationType, ObligationEntry>>(() => {
    function fromInit(key: ObligationType, defaultStatus: ObligationStatus): ObligationEntry {
      const init = initialObligations?.[key]
      if (init) return {
        amount: init.amount ? formatCurrencyInput(String(init.amount)) : '',
        dueDate: init.dueDate,
        status: (init.status as ObligationStatus) || defaultStatus,
      }
      return { amount: '', dueDate: '', status: defaultStatus }
    }
    return {
      ipva:      fromInit('ipva',      'pending'),
      licensing: fromInit('licensing', 'pending'),
      dpvat:     fromInit('dpvat',     'exempt'),
    }
  })
  function setObligation(key: ObligationType, patch: Partial<ObligationEntry>) {
    setObligations((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }

  // ── Manutenção
  const maintenancePlansQuery = useMaintenancePlans()
  const plans = useMemo(
    () => (maintenancePlansQuery.data ?? []).filter((p) => !p.archived_at),
    [maintenancePlansQuery.data],
  )
  // Plano já vinculado ao carregar o form — usado para saber se a troca é uma
  // atribuição nova (bootstrap de itens) ou só realinhar o vínculo.
  const originalPlanId = initialData?.maintenance_plan_id ?? ''
  const [selectedPlanId, setSelectedPlanId] = useState<string>(originalPlanId)
  const selectedPlanQuery = useMaintenancePlan(selectedPlanId || undefined)
  const planItems = (selectedPlanQuery.data?.items ?? []) as MaintenancePlanItem[]
  const [bootstrapItems, setBootstrapItems] = useState<Record<string, string>>({})
  // Só mostra os inputs de "última vez feito" quando o veículo ainda não tinha
  // plano nenhum — trocar de plano existente não deve exigir/gerar bootstrap.
  const showPlanBootstrap = !originalPlanId && !!selectedPlanId

  // ── Seções recolhidas
  function isSectionFilled(id: SectionId): boolean {
    switch (id) {
      case 'sec-complement':  return !!(form.renavam || form.chassis || form.engine_capacity || form.observations)
      case 'sec-document':    return !!(form.registered_owner_name || form.registered_owner_document || form.registration_state || form.crv_number || form.ownership_transferred === 'true' || (!isEditMode && crvFile))
      // DPVAT nasce "Isento" por padrão — isso sozinho não conta como preenchido.
      case 'sec-obligations': return Object.values(obligations).some((o) => o.amount || o.dueDate)
      case 'sec-acquisition': return !!(form.purchase_date || form.acquisition_amount || form.fipe_value || form.previous_owner)
      case 'sec-tracker':     return form.has_tracker === 'true'
      case 'sec-insurance':   return form.has_insurance === 'true'
      case 'sec-photos':      return Object.keys(photoUrls).length > 0
      case 'sec-maintenance': return !!selectedPlanId
    }
  }

  // Na edição, o que já tem dado abre expandido; na criação, tudo recolhido.
  const [openSections, setOpenSections] = useState<Set<SectionId>>(() =>
    isEditMode
      ? new Set(VISIBLE_SECTIONS.filter(isSectionFilled))
      : new Set(),
  )
  function toggleSection(id: SectionId) {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function sectionProps(id: SectionId) {
    const cfg = SECTIONS[id]
    return {
      id,
      title: cfg.title,
      description: cfg.description,
      icon: cfg.icon,
      filled: isSectionFilled(id),
      autoFilled: [...autoFilled].some((k) => FIELD_SECTION[k] === id),
      open: openSections.has(id),
      onToggle: () => toggleSection(id),
    }
  }

  // Erro num campo de seção recolhida abre a seção — senão a mensagem some.
  useEffect(() => {
    const toOpen = Object.keys(fieldErrors)
      .map((field) => (field.startsWith('photo_') ? 'sec-photos' : FIELD_SECTION[field]))
      .filter((id): id is SectionId => !!id)
    if (toOpen.length === 0) return
    setOpenSections((prev) => new Set([...prev, ...toOpen]))
  }, [fieldErrors])

  const requiredDone = [
    stripPlate(form.license_plate).length === 7,
    !!form.vehicle_type,
    !!form.make.trim(),
    !!form.model.trim(),
    form.year_manufacture.length === 4,
    form.year_model.length === 4,
    !!form.color.trim(),
  ].filter(Boolean).length

  // ─── CRLV ────────────────────────────────────────────────────────────────

  async function handleCrlvImport(file: File) {
    setCrvFile(file)
    setCrlvImporting(true)
    setCrlvMsg(null)
    try {
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js'
      const buffer = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
      let rawText = ''
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item)) continue
          rawText += item.str + (item.hasEOL ? '\n' : ' ')
        }
        rawText += '\n'
      }
      const fields = parseCRLVText(rawText)
      const stats = crlvSuccessRate(fields)
      const importedOwnerType = detectOwnerType(fields.cpfCnpj)
      const importedFuel = mapCombustivelToFuel(fields.combustivel)
      const imported: Record<string, unknown> = {
        license_plate: fields.placa, vehicle_type: vehicleTypeFromCrlv(fields.especieTipo),
        renavam: fields.renavam, make: fields.marca, model: fields.modelo,
        year_manufacture: fields.anoFabricacao, year_model: fields.anoModelo, color: fields.cor,
        chassis: fields.chassi, engine_capacity: fields.cilindrada, fuel: importedFuel,
        registered_owner_name: fields.proprietario, registered_owner_document: fields.cpfCnpj,
        registered_owner_type: fields.cpfCnpj, registration_state: fields.uf,
        crv_number: fields.numeroCrv, crv_exercise_year: fields.exercicio,
      }
      const importedKeys = Object.keys(imported).filter((k) => imported[k] != null && imported[k] !== '')
      setAutoFilled(new Set(importedKeys))
      setOpenSections((prev) => new Set([
        ...prev,
        ...importedKeys.map((k) => FIELD_SECTION[k]).filter((id): id is SectionId => !!id),
      ]))
      setForm((prev) => ({
        ...prev,
        license_plate:             fields.placa != null ? applyPlateMask(fields.placa) : prev.license_plate,
        vehicle_type:              vehicleTypeFromCrlv(fields.especieTipo) ?? prev.vehicle_type,
        renavam:                   fields.renavam != null ? applyRenavamMask(fields.renavam) : prev.renavam,
        make:                      fields.marca           ?? prev.make,
        model:                     [fields.modelo, fields.versao].filter(Boolean).join(' ') || prev.model,
        year_manufacture:          fields.anoFabricacao   ?? prev.year_manufacture,
        year_model:                fields.anoModelo       ?? prev.year_model,
        color:                     fields.cor             ?? prev.color,
        chassis:                   fields.chassi ? fields.chassi.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 17) : prev.chassis,
        engine_capacity:           fields.cilindrada ? fields.cilindrada.replace(/\D/g, '') : prev.engine_capacity,
        fuel:                      importedFuel ?? prev.fuel,
        registered_owner_name:     fields.proprietario    ?? prev.registered_owner_name,
        registered_owner_document: fields.cpfCnpj != null
          ? (importedOwnerType === 'cpf' ? applyCpfMask(fields.cpfCnpj) : applyCnpjMask(fields.cpfCnpj))
          : prev.registered_owner_document,
        registered_owner_type:     fields.cpfCnpj != null ? importedOwnerType : prev.registered_owner_type,
        registration_state:        fields.uf              ?? prev.registration_state,
        crv_number:                fields.numeroCrv ? fields.numeroCrv.replace(/\D/g, '') : (prev.crv_number),
        crv_exercise_year:         fields.exercicio ? fields.exercicio.replace(/\D/g, '').slice(0, 4) : prev.crv_exercise_year,
      }))
      setCrlvMsg({ kind: 'success', found: stats.found, total: stats.total, fileName: file.name })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'erro desconhecido'
      setCrlvMsg({ kind: 'error', text: `Erro ao processar o PDF: ${message}` })
    } finally {
      setCrlvImporting(false)
    }
  }

  // ─── Fotos ───────────────────────────────────────────────────────────────

  function handleFileSelect(slot: VehiclePhotoSlot, file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setFieldErrors((prev) => ({ ...prev, [`photo_${slot}`]: 'Use JPG, PNG ou WEBP até 5MB.' }))
      return
    }
    setFieldErrors((prev) => { const n = { ...prev }; delete n[`photo_${slot}`]; return n })

    if (isEditMode) {
      void uploadPhotoEdit(slot, file)
    } else {
      setPendingFiles((prev) => ({ ...prev, [slot]: file }))
      setPhotoUrls((prev) => ({ ...prev, [slot]: URL.createObjectURL(file) }))
    }
  }

  async function uploadPhotoEdit(slot: VehiclePhotoSlot, file: File) {
    const tenantId = getTenantId()
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const path = `${tenantId}/${vehicleId}/${slot}/${Date.now()}.${ext}`
    setUploadingSlot(slot)
    try {
      const { error } = await supabase.storage
        .from('vehicle-photos')
        .upload(path, file, { upsert: true, contentType: file.type })
      if (error) {
        setFieldErrors((prev) => ({ ...prev, [`photo_${slot}`]: `Upload falhou: ${error.message}` }))
        return
      }
      setPhotoUrls((prev) => ({ ...prev, [slot]: URL.createObjectURL(file) }))
      await updateVehicle(vehicleId!, { license_plate: form.license_plate }, { [slot]: path })
    } finally {
      setUploadingSlot(null)
    }
  }

  async function handleDeletePhoto(slot: VehiclePhotoSlot) {
    if (isEditMode) {
      const result = await deleteVehiclePhoto(vehicleId!, slot)
      if (!result.ok) {
        setFieldErrors((prev) => ({ ...prev, [`photo_${slot}`]: result.error.message }))
        return
      }
    } else {
      setPendingFiles((prev) => { const n = { ...prev }; delete n[slot]; return n })
    }
    setPhotoUrls((prev) => { const n = { ...prev }; delete n[slot]; return n })
  }

  // ─── Submit ───────────────────────────────────────────────────────────────

  function buildPayload() {
    // Currency fields: strip thousand separators before parsing
    const num = (v: string) => {
      const n = parseFloat(v.replace(/\./g, '').replace(',', '.'))
      return isNaN(n) ? null : n
    }
    return {
      license_plate:             stripPlate(form.license_plate),
      vehicle_type:              form.vehicle_type || undefined,
      renavam:                   stripRenavam(form.renavam) || null,
      make:                      form.make.toUpperCase().trim(),
      model:                     form.model.trim(),
      year_manufacture:          form.year_manufacture || null,
      year_model:                form.year_model || null,
      color:                     form.color.toUpperCase() || null,
      fuel:                      form.fuel || null,
      chassis:                   form.chassis || null,
      engine_capacity:           form.engine_capacity || null,
      observations:              form.observations || null,
      acquisition_type:          form.acquisition_type || null,
      purchase_date:             form.purchase_date || null,
      acquisition_amount:        num(form.acquisition_amount),
      fipe_value:                num(form.fipe_value),
      previous_owner:            form.acquisition_type !== 'zero_km' ? (form.previous_owner || null) : null,
      previous_owner_cpf:        form.acquisition_type !== 'zero_km' ? (stripDocument(form.previous_owner_cpf) || null) : null,
      registered_owner_name:     form.registered_owner_name || null,
      registered_owner_document: stripDocument(form.registered_owner_document) || null,
      registered_owner_type:     form.registered_owner_document ? form.registered_owner_type : null,
      registration_state:        form.registration_state || null,
      ownership_transferred:     form.ownership_transferred === 'true',
      ownership_transfer_date:   form.ownership_transfer_date || null,
      has_tracker:               form.has_tracker === 'true',
      tracker_brand:             form.has_tracker === 'true' ? (form.tracker_brand || null) : null,
      tracker_model:             form.has_tracker === 'true' ? (form.tracker_model || null) : null,
      tracker_imei:              form.has_tracker === 'true' ? (stripIMEI(form.tracker_imei) || null) : null,
      has_insurance:             form.has_insurance === 'true',
      insurance_monthly_amount:  form.has_insurance === 'true' ? num(form.insurance_monthly_amount) : null,
      insurance_expiry_date:     form.has_insurance === 'true' ? (form.insurance_expiry_date || null) : null,
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setGlobalError(null)
    setFieldErrors({})

    // Mesmo schema da action: o operador vê todos os campos com problema de
    // uma vez, sem ida ao servidor. Erro em seção recolhida abre a seção.
    const payload = buildPayload()
    const check = VehicleSchema.safeParse(payload)
    if (!check.success) {
      const errors: Record<string, string> = {}
      for (const issue of check.error.issues) {
        const key = String(issue.path[0] ?? '')
        if (key && !errors[key]) errors[key] = issue.message
      }
      setFieldErrors(errors)
      setGlobalError(check.error.issues[0]?.message ?? 'Revise os campos destacados.')
      return
    }

    startTransition(async () => {

      const kmEntry = showKmEntry && form.km_entry ? parseInt(form.km_entry, 10) : undefined

      if (isEditMode) {
        const result = await updateVehicle(vehicleId!, { ...payload, ...(kmEntry != null ? { km_entry: kmEntry } : {}) })
        if (!result.ok) {
          // O erro global sai SEMPRE, não só quando falta `field`. Erro
          // apontando para um campo sem slot de exibição — ou para uma seção
          // fora da tela, neste formulário longo — desaparecia por inteiro:
          // clicar em Salvar não produzia nada, nem mensagem nem navegação.
          if (result.error.field) setFieldErrors({ [result.error.field]: result.error.message })
          setGlobalError(
            result.error.field
              ? `${result.error.message} (campo: ${result.error.field})`
              : result.error.message,
          )
          return
        }

        // Plano de manutenção — só chama a action se a seleção mudou.
        if (selectedPlanId !== originalPlanId) {
          const planResult = await assignMaintenancePlan({
            vehicle_id: vehicleId!,
            plan_id: selectedPlanId || null,
            bootstrap_items: showPlanBootstrap ? bootstrapItems : undefined,
          })
          if (!planResult.ok) {
            setGlobalError(planResult.error.message)
            return
          }
        }

        // Salvar obrigações anuais em edit mode
        const today = new Date().toISOString().split('T')[0]
        const oblRows = (Object.entries(obligations) as [ObligationType, ObligationEntry][])
          .filter(([, e]) => e.amount || e.dueDate || e.status === 'exempt')
          .map(([type, e]) => {
            const dueDate = e.dueDate || today
            const refYear = parseInt(dueDate.slice(0, 4), 10) || new Date().getFullYear()
            const amount  = parseFloat(e.amount.replace(/\./g, '').replace(',', '.')) || 0
            return { type, amount, due_date: dueDate, status: e.status, reference_year: refYear }
          })
        if (oblRows.length > 0) {
          // O resultado era descartado: obrigação que falhava sumia sem aviso.
          const oblResult = await saveVehicleObligations(vehicleId!, oblRows)
          if (!oblResult.ok) {
            setGlobalError(`Obrigações anuais não salvas: ${oblResult.error.message}`)
            return
          }
        }

        router.push(`/veiculos/${vehicleId}`)
        return
      }

      // ── Criação
      const result = await createVehicle({ ...payload, ...(kmEntry != null ? { km_entry: kmEntry } : {}) })
      if (!result.ok) {
        if (result.error.field) setFieldErrors({ [result.error.field]: result.error.message })
        else setGlobalError(result.error.message)
        return
      }

      const newId = result.data.id
      const tenantId = getTenantId()
      const warnings: string[] = []

      // Upload fotos pendentes
      if (Object.keys(pendingFiles).length > 0) {
        const photoPaths: Partial<Record<VehiclePhotoSlot, string>> = {}
        await Promise.allSettled(
          (Object.entries(pendingFiles) as [VehiclePhotoSlot, File][]).map(async ([slot, file]) => {
            const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
            const path = `${tenantId}/${newId}/${slot}/${Date.now()}.${ext}`
            const { error } = await supabase.storage.from('vehicle-photos').upload(path, file, { contentType: file.type })
            if (error) warnings.push(`Foto "${VEHICLE_PHOTO_SLOT_LABELS[slot]}" não enviada: ${error.message}`)
            else photoPaths[slot] = path
          }),
        )
        if (Object.keys(photoPaths).length > 0) {
          await updateVehicle(newId, { license_plate: form.license_plate }, photoPaths)
        }
      }

      // CRV
      let crvFileUrl: string | null = null
      if (crvFile) {
        const ext = crvFile.name.split('.').pop()?.toLowerCase() || 'pdf'
        const path = `${tenantId}/${newId}/crv-${Date.now()}.${ext}`
        const { error } = await supabase.storage.from('vehicle-documents').upload(path, crvFile, { upsert: false, contentType: crvFile.type })
        if (error) warnings.push(`Anexo do CRV não salvo: ${error.message}`)
        else crvFileUrl = path
      }
      const hasCrvData = form.crv_number || form.crv_exercise_year || form.registered_owner_name || crvFileUrl
      if (hasCrvData) {
        const { error } = await supabase.from('vehicle_documents').insert({
          tenant_id: tenantId, vehicle_id: newId, type: 'crv',
          exercise_year:             form.crv_exercise_year ? parseInt(form.crv_exercise_year, 10) : null,
          document_number:           form.crv_number || null,
          registered_owner_name:     form.registered_owner_name || null,
          registered_owner_document: form.registered_owner_document || null,
          registered_owner_type:     form.registered_owner_document ? form.registered_owner_type : null,
          file_url: crvFileUrl, is_current: true,
        })
        if (error) warnings.push(`Registro do CRV não criado: ${error.message}`)
      }

      // Obrigações anuais — via Server Action, o mesmo caminho da edição. O
      // INSERT direto daqui ainda gravava `amount`/`status`/`paid_at`, colunas
      // removidas na ADR 0024: falhava sempre, e o erro morria no warning.
      const today = new Date().toISOString().split('T')[0]
      const obligationRows = []
      for (const [key, entry] of Object.entries(obligations) as ['ipva' | 'licensing' | 'dpvat', ObligationEntry][]) {
        if (!entry.amount && !entry.dueDate && entry.status !== 'exempt') continue
        const dueDate = entry.dueDate || today
        const amount = parseFloat(entry.amount.replace(/\./g, '').replace(',', '.')) || 0
        obligationRows.push({
          type: key,
          reference_year: parseInt(dueDate.slice(0, 4), 10) || new Date().getFullYear(),
          due_date: dueDate,
          amount: isNaN(amount) ? 0 : amount,
          status: entry.status,
        })
      }
      if (obligationRows.length > 0) {
        const result = await saveVehicleObligations(newId, obligationRows)
        if (!result.ok) warnings.push(`Obrigações anuais não salvas: ${result.error.message}`)
      }

      // Plano de manutenção
      if (selectedPlanId) {
        const planResult = await assignMaintenancePlan({
          vehicle_id: newId,
          plan_id: selectedPlanId,
          bootstrap_items: bootstrapItems,
        })
        if (!planResult.ok) warnings.push(`Plano de manutenção não atribuído: ${planResult.error.message}`)
      }

      if (warnings.length > 0) { setPostWarnings(warnings); return }
      router.push(`/veiculos/${newId}`)
    })
  }

  // ─── Avisos pós-cadastro ─────────────────────────────────────────────────

  if (postWarnings) {
    return (
      <div className="min-h-screen bg-bg px-6 py-8 max-w-2xl space-y-4">
        <div className="flex items-start gap-3 px-4 py-4 bg-pending-bg border border-pending rounded-xl">
          <AlertCircle className="w-4 h-4 text-pending flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-[13px] text-pending font-medium">Veículo cadastrado, mas alguns itens não foram salvos:</p>
            <ul className="list-disc list-inside text-[12px] text-pending space-y-0.5">
              {postWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
        <div className="flex justify-end">
          <button onClick={() => router.push('/veiculos')} className="h-9 px-6 rounded-full bg-primary text-bg text-[13px] font-bold hover:bg-primary-hover transition-colors">
            Ir para a listagem
          </button>
        </div>
      </div>
    )
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  const acquisitionOptions = Object.entries(ACQUISITION_TYPE_LABELS).map(([value, label]) => ({ value, label }))
  const backHref  = isEditMode ? `/veiculos/${vehicleId}` : '/veiculos'
  const backLabel = isEditMode ? (`${initialData?.make ?? ''} ${initialData?.model ?? ''}`.trim() || 'Veículo') : 'Veículos'

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Cabeçalho fixo ────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-bg backdrop-blur border-b border-border px-6 h-14 flex items-center gap-3">
        <Link href={backHref} className="text-[13px] text-fg-mute hover:text-fg transition-colors whitespace-nowrap">
          ← {backLabel}
        </Link>
        <span className="text-fg-mute">/</span>
        <h1 className="text-[15px] font-bold text-fg flex-1 truncate">
          {isEditMode ? 'Editar veículo' : 'Cadastrar veículo'}
        </h1>
      </div>

      {/* noValidate: a validação é o VehicleSchema (mesmo da action), com
          mensagem por campo — o balão nativo do navegador não alcança o tipo
          do veículo nem os campos dentro de seções recolhidas. */}
      <form
        id="vehicle-form"
        onSubmit={handleSubmit}
        noValidate
        className="max-w-3xl mx-auto px-6 py-8 space-y-8"
      >

        {/* Importar CRLV — somente criação. Parsing determinístico local
            (packages/core/src/parsers/crlv.ts) — NÃO passa por IA, mas
            reaproveita o ícone/título/padrão visual do card de extração
            por IA (Spec 0012) por escolha de produto; sem o selo "IA". */}
        {!isEditMode && (
          <DocumentImportCard
            icon={Sparkles}
            title="Preencher com IA"
            description="Anexe o CRLV para preencher automaticamente."
            accept="application/pdf"
            status={crlvImporting ? 'loading' : crlvMsg?.kind === 'success' ? 'success' : crlvMsg?.kind === 'error' ? 'error' : 'idle'}
            message={crlvMsg?.kind === 'success' ? `${crlvMsg.found}/${crlvMsg.total} campos importados.` : crlvMsg?.kind === 'error' ? crlvMsg.text : undefined}
            fileName={crvFile?.name}
            onSelect={(f) => void handleCrlvImport(f)}
            onRetry={() => { if (crvFile) void handleCrlvImport(crvFile) }}
            onDismissError={() => setCrlvMsg(null)}
            onClear={() => { setCrvFile(null); setCrlvMsg(null); setAutoFilled(new Set()) }}
          />
        )}

        {/* ══ Essencial ═══════════════════════════════════════════════════ */}
        <section aria-labelledby="sec-essential-title" className="bg-surface border border-divider rounded-xl p-5 space-y-4">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 id="sec-essential-title" className="text-[15px] font-bold text-fg">Essencial</h2>
            <span className="text-[12px] text-fg-mute">
              {isEditMode ? 'campos com * são obrigatórios' : 'o mínimo para o veículo entrar na frota · campos com * são obrigatórios'}
            </span>
          </div>
          {autoFilled.size > 0 && (
            <p className="flex items-center gap-2 text-[12px] text-primary">
              <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
              Campos em destaque vieram do CRLV. Confira antes de cadastrar.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Placa *" error={fieldErrors.license_plate}>
              <input
                className={fieldCls('license_plate')}
                placeholder="ABC1D23"
                value={form.license_plate}
                maxLength={8}
                onChange={(e) => set('license_plate', applyPlateMask(e.target.value))}
                aria-required
              />
            </Field>
            <div>
              <span id="vehicle-type-label" className={labelCls}>Tipo do veículo *</span>
              <div role="radiogroup" aria-labelledby="vehicle-type-label" className="flex gap-2">
                {VEHICLE_TYPE_OPTIONS.map(({ value, Icon }) => {
                  const active = form.vehicle_type === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => set('vehicle_type', value)}
                      className={`h-9 px-4 rounded-full border text-[13px] font-medium inline-flex items-center gap-2 transition-colors ${
                        active
                          ? 'bg-primary-tint text-primary border-primary'
                          : fieldErrors.vehicle_type
                            ? 'border-danger text-fg-mute hover:text-fg'
                            : 'border-border text-fg-mute hover:text-fg'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {VEHICLE_TYPE_LABELS[value]}
                    </button>
                  )
                })}
              </div>
              {fieldErrors.vehicle_type && <p className="text-[12px] text-danger mt-1">{fieldErrors.vehicle_type}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Marca *" error={fieldErrors.make}>
              <input className={fieldCls('make')} placeholder="HONDA" value={form.make} onChange={(e) => set('make', e.target.value)} aria-required />
            </Field>
            <Field label="Modelo *" error={fieldErrors.model}>
              <input className={fieldCls('model')} placeholder="CG 160 FAN" value={form.model} onChange={(e) => set('model', e.target.value)} aria-required />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Ano fabricação *" error={fieldErrors.year_manufacture}>
              <input
                className={fieldCls('year_manufacture')}
                placeholder="2025"
                value={form.year_manufacture}
                maxLength={4}
                inputMode="numeric"
                onChange={(e) => set('year_manufacture', e.target.value.replace(/\D/g, '').slice(0, 4))}
                aria-required
              />
            </Field>
            <Field label="Ano modelo *" error={fieldErrors.year_model}>
              <input
                className={fieldCls('year_model')}
                placeholder="2026"
                value={form.year_model}
                maxLength={4}
                inputMode="numeric"
                onChange={(e) => set('year_model', e.target.value.replace(/\D/g, '').slice(0, 4))}
                aria-required
              />
            </Field>
            <Field label="Cor *" error={fieldErrors.color}>
              <input className={fieldCls('color')} placeholder="PRETA" value={form.color} onChange={(e) => set('color', e.target.value)} aria-required />
            </Field>
          </div>

          {/* KM de entrada é gravado uma vez só (RN-010): na criação, ou na
              edição enquanto o veículo ainda não tem um. */}
          {showKmEntry && (
            <div className="pt-4 border-t border-divider">
              <Field label="KM de entrada" error={fieldErrors.km_entry} className="sm:max-w-[calc(33.333%-0.667rem)]">
                <input
                  className={fieldErrors.km_entry ? inputErrCls : inputCls}
                  placeholder="KM no painel"
                  value={form.km_entry}
                  inputMode="numeric"
                  onChange={(e) => set('km_entry', e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <p className="text-[12px] text-fg-mute mt-1.5">
                {isEditMode
                  ? 'Este veículo ainda não tem KM de entrada. É a base do plano de manutenção e, depois de salvo, não pode ser alterado.'
                  : 'Opcional, mas recomendado: é a base do plano de manutenção. Dá para informar depois, na edição, mas uma vez salvo não pode ser alterado.'}
              </p>
            </div>
          )}
        </section>

        {/* ══ Mais informações (seções recolhidas) ═══════════════════════ */}
        <div className="space-y-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-[15px] font-bold text-fg">Mais informações</h2>
            <span className="text-[12px] text-fg-mute">
              {isEditMode ? 'opcional' : 'opcional · dá para completar depois, na edição do veículo'}
            </span>
          </div>
          <div className="bg-surface border border-divider rounded-xl overflow-hidden">

          {/* ══ Identificação complementar ══════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-complement')}>
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="RENAVAM" error={fieldErrors.renavam}>
                  <input
                    className={fieldCls('renavam')}
                    placeholder="11 dígitos"
                    value={form.renavam}
                    maxLength={11}
                    inputMode="numeric"
                    onChange={(e) => set('renavam', applyRenavamMask(e.target.value))}
                  />
                </Field>
                <Field label="Chassi" error={fieldErrors.chassis}>
                  <input
                    className={fieldCls('chassis')}
                    placeholder="9C2KC2200RR000000"
                    value={form.chassis}
                    maxLength={17}
                    onChange={(e) => set('chassis', e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 17))}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Combustível">
                  <select className={fieldCls('fuel')} value={form.fuel} onChange={(e) => set('fuel', e.target.value)}>
                    {FUEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Cilindrada (cc)">
                  <input
                    className={fieldCls('engine_capacity')}
                    placeholder="162"
                    value={form.engine_capacity}
                    inputMode="numeric"
                    onChange={(e) => set('engine_capacity', e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
              </div>
              <Field label="Observações / Laudo de vistoria">
                <textarea className={`${inputCls} h-20 py-2 resize-none`} placeholder="Arranhões, avarias ou detalhes na entrega…" value={form.observations} onChange={(e) => set('observations', e.target.value)} />
              </Field>
            </div>
          </CollapsibleSection>

          {/* ══ Documentação ═════════════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-document')}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Proprietário registrado">
                  <input className={fieldCls('registered_owner_name')} placeholder="Quem consta no CRV" value={form.registered_owner_name} onChange={(e) => set('registered_owner_name', e.target.value)} />
                </Field>
                <div className="grid grid-cols-[90px_1fr] gap-2">
                  <Field label="Tipo doc.">
                    <select
                      className={fieldCls('registered_owner_type')}
                      value={form.registered_owner_type}
                      onChange={(e) => {
                        const t = e.target.value as 'cpf' | 'cnpj'
                        const digits = stripDocument(form.registered_owner_document)
                        setForm((prev) => ({
                          ...prev,
                          registered_owner_type:     t,
                          registered_owner_document: digits
                            ? (t === 'cpf' ? applyCpfMask(digits) : applyCnpjMask(digits))
                            : '',
                        }))
                      }}
                    >
                      {OWNER_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </Field>
                  <Field label="CPF / CNPJ">
                    <input
                      className={fieldCls('registered_owner_document')}
                      placeholder={form.registered_owner_type === 'cpf' ? '000.000.000-00' : '00.000.000/0001-00'}
                      value={form.registered_owner_document}
                      maxLength={form.registered_owner_type === 'cpf' ? 14 : 18}
                      inputMode="numeric"
                      onChange={(e) => set('registered_owner_document',
                        form.registered_owner_type === 'cpf'
                          ? applyCpfMask(e.target.value)
                          : applyCnpjMask(e.target.value)
                      )}
                    />
                  </Field>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4">
                <Field label="UF">
                  <input
                    className={fieldCls('registration_state')}
                    maxLength={2}
                    placeholder="SP"
                    value={form.registration_state}
                    onChange={(e) => set('registration_state', e.target.value.replace(/[^A-Z]/gi, '').toUpperCase())}
                  />
                </Field>
                <Field label="Número do CRV">
                  <input
                    className={fieldCls('crv_number')}
                    placeholder="1234567890"
                    value={form.crv_number}
                    inputMode="numeric"
                    onChange={(e) => set('crv_number', e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
                <Field label="Ano-exercício">
                  <input
                    className={fieldCls('crv_exercise_year')}
                    placeholder="2025"
                    value={form.crv_exercise_year}
                    maxLength={4}
                    inputMode="numeric"
                    onChange={(e) => set('crv_exercise_year', e.target.value.replace(/\D/g, '').slice(0, 4))}
                  />
                </Field>
                <Field label="Transferência">
                  <select className={inputCls} value={form.ownership_transferred} onChange={(e) => set('ownership_transferred', e.target.value)}>
                    <option value="false">Pendente</option>
                    <option value="true">Concluída</option>
                  </select>
                </Field>
              </div>

              {form.ownership_transferred === 'true' && (
                <Field label="Data da transferência" className="max-w-xs">
                  <input type="date" className={inputCls} value={form.ownership_transfer_date} onChange={(e) => set('ownership_transfer_date', e.target.value)} />
                </Field>
              )}

              {/* Anexo CRV — somente criação */}
              {!isEditMode && (
                <div>
                  <label className={labelCls}>Anexo do CRV <span className="text-[12px] text-fg-mute">PDF, JPG, PNG ou WebP · máx. 10MB</span></label>
                  <div className="flex items-center gap-3">
                    <label className="h-9 px-4 rounded-full bg-surface-2 border border-border text-[13px] text-fg-mute cursor-pointer hover:border-fg-mute transition-colors inline-flex items-center gap-2">
                      <Upload className="w-3.5 h-3.5" />
                      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => setCrvFile(e.target.files?.[0] ?? null)} />
                      {crvFile ? 'Trocar arquivo' : 'Selecionar arquivo'}
                    </label>
                    {crvFile && (
                      <div className="flex items-center gap-2 text-[12px] text-info">
                        <span>{crvFile.name} ({Math.round(crvFile.size / 1024)} KB)</span>
                        <button type="button" onClick={() => setCrvFile(null)} className="text-fg-mute hover:text-fg transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleSection>

          {/* ══ IPVA e licenciamento ═════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-obligations')}>
            {/* Obrigações anuais */}
            <div className="space-y-2.5">
              {([
                { key: 'ipva'      as const, label: 'IPVA' },
                { key: 'licensing' as const, label: 'Licenciamento' },
                { key: 'dpvat'     as const, label: 'DPVAT' },
              ]).map((row) => (
                <div key={row.key} className="grid grid-cols-[80px_1fr_1fr_130px] gap-3 items-end bg-divider border border-border rounded-xl px-4 py-3">
                  <span className="text-[13px] font-bold text-fg pb-2.5">{row.label}</span>
                  <Field label="Valor (R$)">
                    <input
                      className={inputCls}
                      placeholder="0,00"
                      value={obligations[row.key].amount}
                      inputMode="decimal"
                      onChange={(e) => setObligation(row.key, { amount: applyCurrencyMask(e.target.value) })}
                    />
                  </Field>
                  <Field label="Vencimento">
                    <input type="date" className={inputCls} value={obligations[row.key].dueDate} onChange={(e) => setObligation(row.key, { dueDate: e.target.value })} />
                  </Field>
                  <Field label="Status">
                    <select className={inputCls} value={obligations[row.key].status} onChange={(e) => setObligation(row.key, { status: e.target.value as ObligationStatus })}>
                      {OBLIGATION_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </Field>
                </div>
              ))}
            </div>
          </CollapsibleSection>

          {/* ══ Aquisição ════════════════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-acquisition')}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Tipo de aquisição">
                  <select className={inputCls} value={form.acquisition_type} onChange={(e) => set('acquisition_type', e.target.value)}>
                    <option value="">Selecione…</option>
                    {acquisitionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Data da compra">
                  <input type="date" className={inputCls} value={form.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Valor pago (R$)">
                  <input
                    className={inputCls}
                    placeholder="0,00"
                    value={form.acquisition_amount}
                    inputMode="decimal"
                    onChange={(e) => set('acquisition_amount', applyCurrencyMask(e.target.value))}
                  />
                </Field>
                <Field label="Valor FIPE (R$)">
                  <input
                    className={inputCls}
                    placeholder="0,00"
                    value={form.fipe_value}
                    inputMode="decimal"
                    onChange={(e) => set('fipe_value', applyCurrencyMask(e.target.value))}
                  />
                </Field>
              </div>
              {form.acquisition_type !== 'zero_km' && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Dono anterior">
                    <input className={inputCls} placeholder="Nome conforme documento" value={form.previous_owner} onChange={(e) => set('previous_owner', e.target.value)} />
                  </Field>
                  <Field label="CPF / CNPJ do vendedor">
                    <input
                      className={inputCls}
                      placeholder="000.000.000-00"
                      value={form.previous_owner_cpf}
                      maxLength={18}
                      inputMode="numeric"
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 14)
                        set('previous_owner_cpf', digits.length <= 11 ? applyCpfMask(digits) : applyCnpjMask(digits))
                      }}
                    />
                  </Field>
                </div>
              )}
            </div>
          </CollapsibleSection>

          {/* ══ Rastreador GPS — escondido até existir a integração ═════ */}
          {VEHICLE_TRACKER_ENABLED && (
            <CollapsibleSection {...sectionProps('sec-tracker')}>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Toggle
                    checked={form.has_tracker === 'true'}
                    onChange={(v) => set('has_tracker', v ? 'true' : 'false')}
                  />
                  <span className="text-[13px] text-fg">
                    {form.has_tracker === 'true' ? 'Possui rastreador instalado' : 'Sem rastreador'}
                  </span>
                </div>
                {form.has_tracker === 'true' && (
                  <div className="grid grid-cols-3 gap-4">
                    <Field label="Marca *">
                      <input className={inputCls} placeholder="Ex: Sascar" value={form.tracker_brand} onChange={(e) => set('tracker_brand', e.target.value)} />
                    </Field>
                    <Field label="Modelo *">
                      <input className={inputCls} placeholder="Ex: Track & Drive" value={form.tracker_model} onChange={(e) => set('tracker_model', e.target.value)} />
                    </Field>
                    <Field label="IMEI (15 dígitos) *" error={fieldErrors.tracker_imei}>
                      <input
                        className={fieldErrors.tracker_imei ? inputErrCls : inputCls}
                        maxLength={15}
                        placeholder="123456789012345"
                        value={form.tracker_imei}
                        inputMode="numeric"
                        onChange={(e) => set('tracker_imei', e.target.value.replace(/\D/g, '').slice(0, 15))}
                      />
                    </Field>
                  </div>
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* ══ Seguro ═══════════════════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-insurance')}>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={form.has_insurance === 'true'}
                  onChange={(v) => set('has_insurance', v ? 'true' : 'false')}
                />
                <span className="text-[13px] text-fg">
                  {form.has_insurance === 'true' ? 'Possui seguro ativo' : 'Sem seguro'}
                </span>
              </div>
              {form.has_insurance === 'true' && (
                <div className="grid grid-cols-2 gap-4 max-w-sm">
                  <Field label="Valor mensal (R$) *">
                    <input
                      className={inputCls}
                      placeholder="0,00"
                      value={form.insurance_monthly_amount}
                      inputMode="decimal"
                      onChange={(e) => set('insurance_monthly_amount', applyCurrencyMask(e.target.value))}
                    />
                  </Field>
                  <Field label="Vencimento *">
                    <input type="date" className={inputCls} value={form.insurance_expiry_date} onChange={(e) => set('insurance_expiry_date', e.target.value)} />
                  </Field>
                </div>
              )}
            </div>
          </CollapsibleSection>

          {/* ══ Fotos ════════════════════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-photos')}>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {PHOTO_SLOTS.map((slot) => {
                const url = photoUrls[slot]
                const isUploading = uploadingSlot === slot
                const slotError = fieldErrors[`photo_${slot}`]
                return (
                  <div key={slot} className="space-y-1.5">
                    <div className={`aspect-square rounded-xl overflow-hidden border relative group transition-colors ${slotError ? 'border-danger bg-danger-bg' : 'border-border bg-divider hover:border-fg-mute'}`}>
                      {url ? (
                        <>
                          <Image
                            src={url}
                            alt={VEHICLE_PHOTO_SLOT_LABELS[slot]}
                            width={160}
                            height={160}
                            className="w-full h-full object-cover"
                            unoptimized
                          />
                          <button
                            type="button"
                            onClick={() => handleDeletePhoto(slot)}
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white hidden group-hover:flex items-center justify-center"
                            title="Remover foto"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </>
                      ) : (
                        <label className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer text-fg-mute hover:text-fg-mute transition-colors">
                          {isUploading
                            ? <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            : <Plus className="w-5 h-5" />
                          }
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="hidden"
                            ref={(el) => { fileInputRefs.current[slot] = el }}
                            disabled={isUploading}
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) handleFileSelect(slot, file)
                              e.target.value = ''
                            }}
                          />
                        </label>
                      )}
                    </div>
                    <p className="text-[11px] text-center text-fg-mute leading-tight">{VEHICLE_PHOTO_SLOT_LABELS[slot]}</p>
                    {slotError && <p className="text-[10px] text-center text-danger leading-tight">{slotError}</p>}
                  </div>
                )
              })}
            </div>
          </CollapsibleSection>

          {/* ══ Plano de Manutenção ══════════════════════════════════════ */}
          <CollapsibleSection {...sectionProps('sec-maintenance')}>
            {maintenancePlansQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : plans.length === 0 ? (
              <div className="flex items-start gap-3 px-4 py-3 bg-pending-bg border border-pending/30 rounded-xl">
                <AlertCircle className="w-4 h-4 text-pending flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-[13px] text-pending">Nenhum plano cadastrado — você pode criar depois.</p>
                  <Link href="/planos-manutencao" className="text-[12px] text-primary hover:underline">Criar plano →</Link>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>Plano atribuído</label>
                  <select
                    className={`${inputCls} max-w-sm`}
                    value={selectedPlanId}
                    onChange={(e) => setSelectedPlanId(e.target.value)}
                  >
                    <option value="">Sem plano{isEditMode ? '' : ' (atribuir depois)'}</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.is_default ? `${p.name} (padrão)` : p.name}</option>
                    ))}
                  </select>
                </div>

                {isEditMode && originalPlanId && selectedPlanId !== originalPlanId && (
                  <div className="px-3 py-2.5 bg-info-bg border border-info/30 rounded-lg">
                    <p className="text-[12px] text-fg-mute">
                      {selectedPlanId
                        ? 'Trocar o plano atualiza só o vínculo — manutenções já agendadas não mudam automaticamente.'
                        : 'O veículo ficará sem plano de manutenção vinculado.'}
                    </p>
                  </div>
                )}

                {selectedPlanId && (
                  <>
                    {showPlanBootstrap && (
                      <div className="px-3 py-2.5 bg-primary-tint border border-primary/30 rounded-lg">
                        <p className="text-[12px] text-fg-mute">
                          Informe a <strong className="text-fg">última vez</strong> que cada item foi realizado. Deixe em branco se não souber — será marcado para revisão imediata.
                        </p>
                      </div>
                    )}
                    {selectedPlanQuery.isLoading ? (
                      <div className="flex justify-center py-4">
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : planItems.length === 0 ? (
                      <p className="text-[13px] text-fg-mute">Este plano ainda não tem itens.</p>
                    ) : !showPlanBootstrap ? (
                      <div className="space-y-2">
                        {planItems.map((item) => (
                          <div key={item.id} className="flex items-center gap-4 bg-divider border border-border rounded-xl px-4 py-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-bold text-fg truncate">{item.name}</p>
                              <p className="text-[11px] text-fg-mute">{planItemHint(item)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {planItems.map((item) => {
                          const metric = planItemMetric(item)
                          return (
                            <div key={item.id} className="flex items-center gap-4 bg-divider border border-border rounded-xl px-4 py-3">
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-bold text-fg truncate">{item.name}</p>
                                <p className="text-[11px] text-fg-mute">{planItemHint(item)}</p>
                              </div>
                              {metric === 'km' ? (
                                <div className="relative flex-shrink-0">
                                  <input
                                    type="number"
                                    placeholder="KM da última troca"
                                    value={bootstrapItems[item.id] ?? ''}
                                    onChange={(e) => setBootstrapItems((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                    className="w-36 h-8 px-3 pr-8 rounded-lg bg-surface-2 border border-border text-[12px] text-fg placeholder:text-fg-mute outline-none focus:border-primary text-right"
                                  />
                                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-fg-mute font-bold pointer-events-none">KM</span>
                                </div>
                              ) : (
                                <input
                                  type="date"
                                  value={bootstrapItems[item.id] ?? ''}
                                  onChange={(e) => setBootstrapItems((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                  className="w-36 h-8 px-3 rounded-lg bg-surface-2 border border-border text-[12px] text-fg outline-none focus:border-primary flex-shrink-0"
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </CollapsibleSection>

          </div>
          </div>

          {/* ── Erro global ────────────────────────────────────────────── */}
          {globalError && (
            <div ref={errorRef} className="flex items-start gap-3 px-4 py-3 bg-danger-bg border border-danger rounded-xl">
              <AlertCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-danger">{globalError}</p>
            </div>
          )}

      </form>

      {/* ── Rodapé fixo: o botão de salvar fica sempre à vista ─────────────── */}
      <div className="sticky bottom-0 z-20 bg-bg border-t border-border">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center gap-3">
          <p className="hidden sm:block flex-1 min-w-0 text-[12px] text-fg-mute" aria-live="polite">
            {requiredDone === REQUIRED_TOTAL
              ? <><strong className="text-fg">Obrigatórios completos.</strong>{isEditMode ? '' : ' O resto pode ficar para depois.'}</>
              : <><strong className="text-fg tabular-nums">{requiredDone}/{REQUIRED_TOTAL}</strong> obrigatórios preenchidos</>}
          </p>
          <Link href={backHref} className="ml-auto sm:ml-0 inline-flex items-center h-9 px-5 rounded-full border border-border text-fg-mute text-[13px] font-medium hover:text-fg hover:border-fg-mute transition-colors">
            Cancelar
          </Link>
          <button
            type="submit"
            form="vehicle-form"
            disabled={isPending}
            className="h-9 px-6 rounded-full bg-primary text-bg text-[13px] font-bold hover:bg-primary-hover transition-colors disabled:opacity-60"
          >
            {isPending ? 'Salvando…' : isEditMode ? 'Salvar' : 'Cadastrar'}
          </button>
        </div>
      </div>
    </div>
  )
}
