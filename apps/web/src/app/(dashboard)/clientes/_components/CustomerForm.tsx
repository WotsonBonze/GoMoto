'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, Upload, X, Loader2, MapPin, Sparkles } from 'lucide-react'

import {
  applyCpfMask, normalizeCpf,
  applyCnpjMask,
  applyPhoneMask, stripPhone,
  applyZipMask,
} from '@gomoto/core'
import { useSupabaseContext, useRequiredTenantId } from '@gomoto/data'
import { useCepLookup } from '@/hooks/useCepLookup'
import { DocumentImportCard } from '@/components/documents/DocumentImportCard'

import { createCustomer, updateCustomer, extractCnhFields } from '../actions'
import { CNH_CATEGORIES, ExtractDocumentFileSchema, type Customer, type CnhFields } from '@gomoto/core'

// ─── Constantes ──────────────────────────────────────────────────────────────

const STATE_OPTIONS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS',
  'MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]


const NAV_ITEMS_INDIVIDUAL = [
  { id: 'sec-type',      label: 'Tipo de Pessoa' },
  { id: 'sec-ai-cnh',    label: 'Preencher com IA' },
  { id: 'sec-personal',  label: 'Dados Pessoais' },
  { id: 'sec-license',   label: 'Habilitação' },
  { id: 'sec-contact',   label: 'Contato' },
  { id: 'sec-address',   label: 'Endereço' },
  { id: 'sec-documents', label: 'Documentos' },
  { id: 'sec-notes',     label: 'Observações' },
]

const NAV_ITEMS_COMPANY = [
  { id: 'sec-type',      label: 'Tipo de Pessoa' },
  { id: 'sec-personal',  label: 'Dados da Empresa' },
  { id: 'sec-contact',   label: 'Contato' },
  { id: 'sec-address',   label: 'Endereço' },
  { id: 'sec-documents', label: 'Documentos' },
  { id: 'sec-notes',     label: 'Observações' },
]

const BUCKET = 'customer-documents'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type PersonType = 'individual' | 'company'

interface FormState {
  person_type: PersonType
  // PF
  name: string
  cpf: string
  rg: string
  birth_date: string
  // PJ
  company_name: string
  trade_name: string
  cnpj: string
  // Contato
  phone: string
  phone2: string
  email: string
  emergency_contact_name: string
  emergency_contact_phone: string
  emergency_contact_name2: string
  emergency_contact_phone2: string
  emergency_contact_name3: string
  emergency_contact_phone3: string
  // Endereço
  zip_code: string
  street: string
  street_number: string
  complement: string
  neighborhood: string
  city: string
  state: string
  // Habilitação
  drivers_license: string
  drivers_license_category: string
  drivers_license_validity: string
  // Gestão
  observations: string
  active: boolean
  departure_date: string
  departure_reason: string
}

/**
 * Os três contatos de emergência. O primeiro par não tem sufixo por ser o que
 * já existia — mesma convenção de phone/phone2.
 */
const EMERGENCY_CONTACT_FIELDS: {
  position: 1 | 2 | 3
  nameKey: keyof FormState & `emergency_contact_name${'' | '2' | '3'}`
  phoneKey: keyof FormState & `emergency_contact_phone${'' | '2' | '3'}`
}[] = [
  { position: 1, nameKey: 'emergency_contact_name',  phoneKey: 'emergency_contact_phone'  },
  { position: 2, nameKey: 'emergency_contact_name2', phoneKey: 'emergency_contact_phone2' },
  { position: 3, nameKey: 'emergency_contact_name3', phoneKey: 'emergency_contact_phone3' },
]

export interface CustomerFormProps {
  customerId?: string
  initialData?: Customer
}

// ─── Primitivas de estilo ─────────────────────────────────────────────────────

const labelCls = 'block text-[13px] text-fg-mute mb-1.5'
const inputCls = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-border text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-primary transition-all'
const selectCls = 'w-full h-9 px-3 rounded-lg bg-surface-2 border border-border text-[13px] text-fg outline-none focus:border-primary transition-all'
const textareaCls = 'w-full px-3 py-2 rounded-lg bg-surface-2 border border-border text-[13px] text-fg placeholder:text-fg-mute outline-none focus:border-primary transition-all resize-none'

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-5">
      <h2 className="text-[15px] font-bold text-fg">{title}</h2>
      {hint && <span className="text-[12px] text-fg-mute">{hint}</span>}
    </div>
  )
}

function Field({
  label, children, className, lowConfidence, htmlFor,
}: { label: string; children: React.ReactNode; className?: string; lowConfidence?: boolean; htmlFor?: string }) {
  return (
    <div className={className}>
      <label className={labelCls} htmlFor={htmlFor}>
        {label}
        {lowConfidence && (
          <span
            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-warning-bg text-warning"
            title="Extraído da CNH com baixa confiança — confira o valor"
          >
            Confira
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="w-10 h-5 bg-surface-2 rounded-full peer peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
    </label>
  )
}

// ─── Upload de arquivo ────────────────────────────────────────────────────────

function DocumentUpload({
  label,
  hint,
  existingUrl,
  pendingFile,
  uploading,
  onSelect,
  onClear,
}: {
  label: string
  hint?: string
  existingUrl?: string | null
  pendingFile?: File | null
  uploading: boolean
  onSelect: (file: File) => void
  onClear: () => void
}) {
  const preview = pendingFile ? URL.createObjectURL(pendingFile) : existingUrl

  return (
    <div>
      <label className={labelCls}>{label}</label>
      {hint && <p className="text-[12px] text-fg-mute mb-2">{hint}</p>}

      {preview ? (
        <div className="relative group rounded-xl overflow-hidden border border-border bg-surface-2">
          {pendingFile?.type === 'application/pdf' || existingUrl?.endsWith('.pdf') ? (
            <div className="flex items-center gap-3 p-4">
              <div className="w-10 h-10 rounded-lg bg-surface-2 flex items-center justify-center text-fg-mute text-[11px] font-bold">PDF</div>
              <span className="text-[13px] text-fg truncate">{pendingFile?.name ?? 'documento.pdf'}</span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt={label} className="w-full h-40 object-cover" />
          )}
          <button
            type="button"
            onClick={onClear}
            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-danger-bg text-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            title="Remover"
          >
            <X className="w-4 h-4" />
          </button>
          {uploading && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      ) : (
        <label className="flex flex-col items-center justify-center gap-2 h-32 rounded-xl border-2 border-dashed border-border bg-surface-2 cursor-pointer hover:border-primary hover:bg-divider transition-all">
          <Upload className="w-5 h-5 text-fg-mute" />
          <span className="text-[13px] text-fg-mute">Clique para selecionar</span>
          <span className="text-[11px] text-border">JPG, PNG, WebP ou PDF — máx. 10MB</span>
          <input
            type="file"
            className="sr-only"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onSelect(f) }}
          />
        </label>
      )}
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function CustomerForm({ customerId, initialData }: CustomerFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const supabase = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const isEditing = !!customerId

  const [form, setForm] = useState<FormState>({
    person_type:              (initialData?.person_type as PersonType) ?? 'individual',
    name:                     initialData?.name ?? '',
    cpf:                      initialData?.cpf ? applyCpfMask(initialData.cpf) : '',
    rg:                       initialData?.rg ?? '',
    birth_date:               initialData?.birth_date ?? '',
    company_name:             initialData?.company_name ?? '',
    trade_name:               initialData?.trade_name ?? '',
    cnpj:                     initialData?.cnpj ? applyCnpjMask(initialData.cnpj) : '',
    phone:                    initialData?.phone ? applyPhoneMask(initialData.phone) : '',
    phone2:                   initialData?.phone2 ? applyPhoneMask(initialData.phone2) : '',
    email:                    initialData?.email ?? '',
    emergency_contact_name:   initialData?.emergency_contact_name ?? '',
    emergency_contact_phone:  initialData?.emergency_contact_phone ? applyPhoneMask(initialData.emergency_contact_phone) : '',
    emergency_contact_name2:  initialData?.emergency_contact_name2 ?? '',
    emergency_contact_phone2: initialData?.emergency_contact_phone2 ? applyPhoneMask(initialData.emergency_contact_phone2) : '',
    emergency_contact_name3:  initialData?.emergency_contact_name3 ?? '',
    emergency_contact_phone3: initialData?.emergency_contact_phone3 ? applyPhoneMask(initialData.emergency_contact_phone3) : '',
    zip_code:                 initialData?.zip_code ? applyZipMask(initialData.zip_code) : '',
    street:                   initialData?.street ?? '',
    street_number:            initialData?.street_number ?? '',
    complement:               initialData?.complement ?? '',
    neighborhood:             initialData?.neighborhood ?? '',
    city:                     initialData?.city ?? '',
    state:                    initialData?.state ?? 'RJ',
    drivers_license:          initialData?.drivers_license ?? '',
    drivers_license_category: initialData?.drivers_license_category ?? 'A',
    drivers_license_validity: initialData?.drivers_license_validity ?? '',
    observations:             initialData?.observations ?? '',
    active:                   initialData?.active ?? true,
    departure_date:           initialData?.departure_date ?? '',
    departure_reason:         initialData?.departure_reason ?? '',
  })

  // Uploads pendentes (antes do save no modo criação)
  const [cnh, setCnh]           = useState<File | null>(null)
  const [residency, setResidency] = useState<File | null>(null)

  // URLs atuais (no modo edição)
  const [cnhUrl, setCnhUrl]             = useState<string | null>(initialData?.drivers_license_photo_url ?? null)
  const [residencyUrl, setResidencyUrl] = useState<string | null>(initialData?.residency_proof_url ?? null)

  const [uploadingDoc, setUploadingDoc] = useState<'cnh' | 'residency' | null>(null)

  // Extração de CNH via IA (PRD/Spec 0012) — nunca bloqueia o cadastro (RNF-002).
  const [cnhExtraction, setCnhExtraction] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; fieldsFound: number; fieldsTotal: number }
  >({ status: 'idle' })
  const [lowConfidenceFields, setLowConfidenceFields] = useState<Set<keyof FormState>>(new Set())

  const cepLookup = useCepLookup()

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function runCnhExtraction(file: File) {
    // Validação imediata no client (mesmo schema do Server Action, RNF-003) —
    // feedback rápido sem gastar round-trip antes da checagem definitiva.
    const validFile = ExtractDocumentFileSchema.safeParse(file)
    if (!validFile.success) {
      setCnhExtraction({ status: 'error', message: validFile.error.issues[0]?.message ?? 'Arquivo inválido' })
      return
    }

    setCnhExtraction({ status: 'loading' })
    const formData = new FormData()
    formData.append('file', file)
    const result = await extractCnhFields(formData)

    if (!result.ok) {
      setCnhExtraction({ status: 'error', message: result.error.message })
      return
    }

    type CnhMappedField =
      | 'name' | 'cpf' | 'rg' | 'birth_date'
      | 'drivers_license' | 'drivers_license_category' | 'drivers_license_validity'

    const { fields, fieldsFound, fieldsTotal } = result.data
    const lowConf = new Set<keyof FormState>()
    const patch: Partial<Record<CnhMappedField, string>> = {}

    function applyField(key: CnhMappedField, field: CnhFields[keyof CnhFields], mask?: (v: string) => string) {
      // Confiança baixa é sinalizada mesmo com value null (RF-004/CA-004) —
      // "não deu pra ler com confiança" é sinal diferente de "não achei o campo".
      if (field.confidence === 'low') lowConf.add(key)
      if (field.value === null) return
      patch[key] = mask ? mask(field.value) : field.value
    }

    applyField('name', fields.name)
    applyField('cpf', fields.cpf, applyCpfMask)
    applyField('rg', fields.rg)
    applyField('birth_date', fields.birth_date)
    applyField('drivers_license', fields.drivers_license)
    applyField('drivers_license_category', fields.drivers_license_category)
    applyField('drivers_license_validity', fields.drivers_license_validity)

    setForm((prev) => ({ ...prev, ...patch }))
    setLowConfidenceFields(lowConf)
    setCnhExtraction({ status: 'success', fieldsFound, fieldsTotal })
  }

  async function uploadFile(file: File, slot: 'cnh' | 'residency', entityId: string): Promise<string | null> {
    const tenantId = getTenantId()
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const path = `${tenantId}/${entityId}/${slot}/${Date.now()}.${ext}`
    setUploadingDoc(slot)
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type })
    setUploadingDoc(null)
    if (uploadErr) {
      setError(`Upload de ${slot === 'cnh' ? 'CNH' : 'comprovante'} falhou: ${uploadErr.message}`)
      return null
    }
    return path
  }

  async function handleEditUpload(file: File, slot: 'cnh' | 'residency') {
    if (!customerId) return
    const path = await uploadFile(file, slot, customerId)
    if (!path) return
    const field = slot === 'cnh' ? 'drivers_license_photo_url' : 'residency_proof_url'
    const result = await updateCustomer(customerId, { [field]: path })
    if (result.error) { setError(result.error); return }
    if (slot === 'cnh') setCnhUrl(path)
    else setResidencyUrl(path)
  }

  function handleSubmit() {
    setError(null)
    startTransition(async () => {
      const isCompany = form.person_type === 'company'

      const payload = {
        person_type:              form.person_type,
        name:                     form.name.trim(),
        // PF
        cpf:                      !isCompany && form.cpf ? normalizeCpf(form.cpf) : null,
        rg:                       !isCompany ? (form.rg.trim() || null) : null,
        birth_date:               !isCompany ? (form.birth_date || null) : null,
        drivers_license:          !isCompany ? (form.drivers_license.trim() || null) : null,
        drivers_license_category: !isCompany ? (form.drivers_license_category || null) : null,
        drivers_license_validity: !isCompany ? (form.drivers_license_validity || null) : null,
        // PJ
        cnpj:                     isCompany ? form.cnpj.replace(/\D/g, '') || null : null,
        company_name:             isCompany ? (form.company_name.trim() || null) : null,
        trade_name:               isCompany ? (form.trade_name.trim() || null) : null,
        // Contato
        phone:                    form.phone.trim() || null,
        phone2:                   form.phone2.trim() || null,
        email:                    form.email.trim() || null,
        emergency_contact_name:   !isCompany ? (form.emergency_contact_name.trim() || null) : null,
        emergency_contact_phone:  !isCompany ? (stripPhone(form.emergency_contact_phone) || null) : null,
        emergency_contact_name2:  !isCompany ? (form.emergency_contact_name2.trim() || null) : null,
        emergency_contact_phone2: !isCompany ? (stripPhone(form.emergency_contact_phone2) || null) : null,
        emergency_contact_name3:  !isCompany ? (form.emergency_contact_name3.trim() || null) : null,
        emergency_contact_phone3: !isCompany ? (stripPhone(form.emergency_contact_phone3) || null) : null,
        // Endereço
        zip_code:                 form.zip_code.replace(/\D/g, '') || null,
        street:                   form.street.trim() || null,
        street_number:            form.street_number.trim() || null,
        complement:               form.complement.trim() || null,
        neighborhood:             form.neighborhood.trim() || null,
        city:                     form.city.trim() || null,
        state:                    form.state || null,
        // Gestão
        observations:             form.observations.trim() || null,
        active:                   form.active,
        departure_date:           !form.active ? (form.departure_date || null) : null,
        departure_reason:         !form.active ? (form.departure_reason.trim() || null) : null,
        in_queue:                 false,
      }

      if (isEditing) {
        const result = await updateCustomer(customerId, payload)
        if (result.error) { setError(result.error); return }
        router.push(`/clientes/${customerId}`)
      } else {
        const result = await createCustomer(payload)
        if (result.error) { setError(result.error); return }
        const newId = result.data?.id
        if (newId) {
          // Upload docs pendentes após criação
          if (cnh) {
            const path = await uploadFile(cnh, 'cnh', newId)
            if (path) await updateCustomer(newId, { drivers_license_photo_url: path })
          }
          if (residency) {
            const path = await uploadFile(residency, 'residency', newId)
            if (path) await updateCustomer(newId, { residency_proof_url: path })
          }
        }
        router.push('/clientes')
      }
    })
  }

  const navItems = [
    ...(form.person_type === 'individual' ? NAV_ITEMS_INDIVIDUAL : NAV_ITEMS_COMPANY),
    ...(isEditing ? [{ id: 'sec-departure', label: 'Encerramento' }] : []),
  ]

  const isCompany = form.person_type === 'company'

  return (
    <div className="min-h-screen bg-bg">

      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg border-b border-divider px-6 h-16 flex items-center gap-4">
        <Link
          href={isEditing ? `/clientes/${customerId}` : '/clientes'}
          className="text-[13px] text-fg-mute hover:text-fg transition-colors"
        >
          ← {isEditing ? 'Voltar' : 'Clientes'}
        </Link>
        <span className="text-border">/</span>
        <h1 className="text-[18px] font-bold text-fg">
          {isEditing ? 'Editar Cliente' : 'Novo Cliente'}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          <Link
            href={isEditing ? `/clientes/${customerId}` : '/clientes'}
            className="inline-flex items-center h-9 px-4 rounded-full bg-surface-2 text-fg text-[13px] font-medium hover:bg-divider transition-colors"
          >
            Cancelar
          </Link>
          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="inline-flex items-center h-9 px-4 rounded-full bg-primary text-bg text-[13px] font-bold hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>

      <div className="flex max-w-5xl mx-auto">

        {/* Nav lateral */}
        <nav className="w-48 shrink-0 py-6 pl-6 pr-4 sticky top-16 self-start h-[calc(100vh-4rem)] overflow-y-auto">
          <ul className="space-y-1">
            {navItems.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="block px-3 py-1.5 rounded-lg text-[13px] text-fg-mute hover:text-fg hover:bg-surface-2 transition-colors"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Conteúdo */}
        <div className="flex-1 py-6 pr-6 space-y-10 min-w-0">

          {error && (
            <div className="flex items-center gap-3 px-4 py-3 bg-danger-bg border border-danger rounded-xl">
              <AlertCircle className="w-4 h-4 text-danger shrink-0" />
              <p className="text-[13px] text-danger">{error}</p>
            </div>
          )}

          {/* ── Tipo de pessoa ───────────────────────────────────────────────── */}
          <section id="sec-type" className="bg-surface rounded-2xl p-6">
            <SectionHeader title="Tipo de Pessoa" />
            <div className="flex gap-3">
              {([['individual', 'Pessoa Física (CPF)'], ['company', 'Pessoa Jurídica (CNPJ)']] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => set('person_type', val)}
                  className={`flex-1 h-11 rounded-xl border text-[13px] font-medium transition-all ${
                    form.person_type === val
                      ? 'bg-primary border-primary text-primary-contrast'
                      : 'bg-surface-2 border-border text-fg-mute hover:border-fg-mute'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/* ── Preencher com IA (só PF — CNH) ───────────────────────────────── */}
          {!isCompany && (
            <div id="sec-ai-cnh">
              <DocumentImportCard
                icon={Sparkles}
                badge="IA"
                title="Preencher com IA"
                description="Anexe a CNH para preencher automaticamente."
                accept="image/jpeg,image/png,image/webp,application/pdf"
                processingMessages={['Lendo o documento…', 'Identificando os campos…', 'Conferindo os dados…']}
                status={cnhExtraction.status}
                message={
                  cnhExtraction.status === 'error'
                    ? cnhExtraction.message
                    : cnhExtraction.status === 'success'
                      ? `${cnhExtraction.fieldsFound} de ${cnhExtraction.fieldsTotal} campos identificados.`
                      : undefined
                }
                fileName={cnh?.name ?? (cnhUrl ? cnhUrl.split('/').pop() : null)}
                existingUrl={cnhUrl}
                onSelect={(f) => {
                  setCnh(f)
                  if (isEditing) { handleEditUpload(f, 'cnh') }
                  void runCnhExtraction(f)
                }}
                onRetry={() => { if (cnh) void runCnhExtraction(cnh) }}
                onDismissError={() => setCnhExtraction({ status: 'idle' })}
                onClear={() => {
                  setCnh(null); setCnhUrl(null)
                  setCnhExtraction({ status: 'idle' }); setLowConfidenceFields(new Set())
                }}
              />
            </div>
          )}

          {/* ── Dados Pessoais / Empresa ─────────────────────────────────────── */}
          <section id="sec-personal" className="bg-surface rounded-2xl p-6">
            <SectionHeader title={isCompany ? 'Dados da Empresa' : 'Dados Pessoais'} />
            <div className="grid grid-cols-2 gap-4">

              {isCompany ? (
                <>
                  <Field label="Razão Social" className="col-span-2">
                    <input className={inputCls} placeholder="Nome empresarial completo"
                      value={form.company_name} onChange={(e) => set('company_name', e.target.value)} />
                  </Field>
                  <Field label="Nome Fantasia" className="col-span-2">
                    <input className={inputCls} placeholder="Nome comercial"
                      value={form.trade_name} onChange={(e) => set('trade_name', e.target.value)} />
                  </Field>
                  <Field label="Nome do Responsável" className="col-span-2">
                    <input className={inputCls} placeholder="Nome completo do responsável pelo contrato"
                      value={form.name} onChange={(e) => set('name', e.target.value)} />
                  </Field>
                  <Field label="CNPJ">
                    <input className={inputCls} placeholder="00.000.000/0000-00"
                      value={form.cnpj} onChange={(e) => set('cnpj', applyCnpjMask(e.target.value))} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Nome completo" className="col-span-2" lowConfidence={lowConfidenceFields.has('name')}>
                    <input className={inputCls} placeholder="Nome completo do cliente"
                      value={form.name} onChange={(e) => set('name', e.target.value)} />
                  </Field>
                  <Field label="CPF" lowConfidence={lowConfidenceFields.has('cpf')}>
                    <input className={inputCls} placeholder="000.000.000-00"
                      value={form.cpf} onChange={(e) => set('cpf', applyCpfMask(e.target.value))} />
                  </Field>
                  <Field label="RG" lowConfidence={lowConfidenceFields.has('rg')}>
                    <input className={inputCls} placeholder="Número do RG" maxLength={9}
                      value={form.rg}
                      onChange={(e) => set('rg', e.target.value.replace(/\D/g, '').slice(0, 9))} />
                  </Field>
                  <Field label="Data de Nascimento" lowConfidence={lowConfidenceFields.has('birth_date')}>
                    <input type="date" className={inputCls}
                      value={form.birth_date} onChange={(e) => set('birth_date', e.target.value)} />
                  </Field>
                </>
              )}

              {isEditing && (
                <Field label="Status do Cliente" className="col-span-2">
                  <div className="flex items-center gap-3">
                    <Toggle checked={form.active} onChange={(v) => set('active', v)} />
                    <span className="text-[13px] text-fg">
                      {form.active ? 'Ativo' : 'Ex-Cliente'}
                    </span>
                  </div>
                </Field>
              )}

            </div>
          </section>

          {/* ── Habilitação (somente PF) ─────────────────────────────────────── */}
          {!isCompany && (
            <section id="sec-license" className="bg-surface rounded-2xl p-6">
              <SectionHeader title="Habilitação (CNH)" />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Número da CNH" lowConfidence={lowConfidenceFields.has('drivers_license')}>
                  <input className={inputCls} placeholder="Número da habilitação" maxLength={11}
                    value={form.drivers_license}
                    onChange={(e) => set('drivers_license', e.target.value.replace(/\D/g, '').slice(0, 11))} />
                </Field>
                <Field label="Categoria" lowConfidence={lowConfidenceFields.has('drivers_license_category')}>
                  <select className={selectCls} value={form.drivers_license_category}
                    onChange={(e) => set('drivers_license_category', e.target.value)}>
                    {/* Valor legado fora da lista aparece como está — senão o select
                        exibiria a 1ª opção e salvaria outro valor sem o operador ver. */}
                    {form.drivers_license_category && !(CNH_CATEGORIES as readonly string[]).includes(form.drivers_license_category) && (
                      <option value={form.drivers_license_category} className="bg-surface">{form.drivers_license_category}</option>
                    )}
                    {CNH_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat} className="bg-surface">{cat}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Validade" lowConfidence={lowConfidenceFields.has('drivers_license_validity')}>
                  <input type="date" className={inputCls}
                    value={form.drivers_license_validity}
                    onChange={(e) => set('drivers_license_validity', e.target.value)} />
                </Field>
              </div>
            </section>
          )}

          {/* ── Contato ─────────────────────────────────────────────────────── */}
          <section id="sec-contact" className="bg-surface rounded-2xl p-6">
            <SectionHeader title="Contato" />
            <div className="grid grid-cols-2 gap-4">
              <Field label="Telefone 1">
                <input className={inputCls} placeholder="(21) 99999-9999"
                  value={form.phone} onChange={(e) => set('phone', applyPhoneMask(e.target.value))} />
              </Field>
              <Field label="Telefone 2">
                <input className={inputCls} placeholder="(21) 99999-9999"
                  value={form.phone2} onChange={(e) => set('phone2', applyPhoneMask(e.target.value))} />
              </Field>
              <Field label="Email" className="col-span-2">
                <input type="email" className={inputCls} placeholder="email@exemplo.com"
                  value={form.email} onChange={(e) => set('email', e.target.value)} />
              </Field>
              {!isCompany && (
                <>
                  {EMERGENCY_CONTACT_FIELDS.map(({ position, nameKey, phoneKey }) => (
                    <Fragment key={position}>
                      <Field label={`Nome do Contato de Emergência ${position}`} htmlFor={nameKey}>
                        <input id={nameKey} className={inputCls} placeholder="Nome do familiar ou responsável"
                          value={form[nameKey]} onChange={(e) => set(nameKey, e.target.value)} />
                      </Field>
                      <Field label={`Telefone do Contato de Emergência ${position}`} htmlFor={phoneKey}>
                        <input id={phoneKey} className={inputCls} placeholder="(21) 99999-9999"
                          value={form[phoneKey]} onChange={(e) => set(phoneKey, applyPhoneMask(e.target.value))} />
                      </Field>
                    </Fragment>
                  ))}
                </>
              )}
            </div>
          </section>

          {/* ── Endereço ────────────────────────────────────────────────────── */}
          <section id="sec-address" className="bg-surface rounded-2xl p-6">
            <SectionHeader title="Endereço" />
            <div className="grid grid-cols-6 gap-4">

              {/* CEP com busca automática */}
              <div className="col-span-2">
                <label className={labelCls}>CEP</label>
                <div className="relative">
                  <input
                    className={inputCls}
                    placeholder="00000-000"
                    value={form.zip_code}
                    onChange={async (e) => {
                      const masked = applyZipMask(e.target.value)
                      set('zip_code', masked)
                      if (masked.replace(/\D/g, '').length === 8) {
                        const addr = await cepLookup.lookup(masked)
                        if (addr) {
                          setForm((prev) => ({
                            ...prev,
                            street:       addr.street       || prev.street,
                            complement:   addr.complement   || prev.complement,
                            neighborhood: addr.neighborhood || prev.neighborhood,
                            city:         addr.city         || prev.city,
                            state:        addr.state        || prev.state,
                          }))
                        }
                      } else {
                        cepLookup.clearError()
                      }
                    }}
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                    {cepLookup.loading
                      ? <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      : <MapPin className="w-4 h-4 text-fg-mute" />
                    }
                  </div>
                </div>
                {cepLookup.error && (
                  <p className="mt-1 text-[12px] text-danger">{cepLookup.error}</p>
                )}
              </div>

              <Field label="Logradouro" className="col-span-4">
                <input className={inputCls} placeholder="Rua, Avenida, Travessa…"
                  value={form.street} onChange={(e) => set('street', e.target.value)} />
              </Field>

              <Field label="Número" className="col-span-2">
                <input className={inputCls} placeholder="Ex: 123"
                  value={form.street_number} onChange={(e) => set('street_number', e.target.value)} />
              </Field>

              <Field label="Complemento" className="col-span-4">
                <input className={inputCls} placeholder="Apto, Bloco, Sala…"
                  value={form.complement} onChange={(e) => set('complement', e.target.value)} />
              </Field>

              <Field label="Bairro" className="col-span-3">
                <input className={inputCls} placeholder="Nome do bairro"
                  value={form.neighborhood} onChange={(e) => set('neighborhood', e.target.value)} />
              </Field>

              <Field label="Cidade" className="col-span-3">
                <input className={inputCls} placeholder="Nome da cidade"
                  value={form.city} onChange={(e) => set('city', e.target.value)} />
              </Field>

              <Field label="UF" className="col-span-2">
                <select className={selectCls} value={form.state} onChange={(e) => set('state', e.target.value)}>
                  <option value="">—</option>
                  {STATE_OPTIONS.map((uf) => (
                    <option key={uf} value={uf} className="bg-surface">{uf}</option>
                  ))}
                </select>
              </Field>

            </div>
          </section>

          {/* ── Documentos ──────────────────────────────────────────────────── */}
          <section id="sec-documents" className="bg-surface rounded-2xl p-6">
            <SectionHeader title="Documentos" hint="JPG, PNG, WebP ou PDF — máx. 10MB" />
            <div className="grid grid-cols-2 gap-6">

              <DocumentUpload
                label={isCompany ? 'Cartão CNPJ ou documento da empresa' : 'Comprovante de Residência'}
                existingUrl={residencyUrl}
                pendingFile={residency}
                uploading={uploadingDoc === 'residency'}
                onSelect={(f) => {
                  if (isEditing) { handleEditUpload(f, 'residency') }
                  else { setResidency(f) }
                }}
                onClear={() => { setResidency(null); setResidencyUrl(null) }}
              />

            </div>
          </section>

          {/* ── Observações ──────────────────────────────────────────────────── */}
          <section id="sec-notes" className="bg-surface rounded-2xl p-6">
            <SectionHeader title="Observações" />
            <div className="grid grid-cols-1 gap-4">
              <Field label="Observações internas">
                <textarea rows={4} className={textareaCls} placeholder="Notas internas sobre o cliente…"
                  value={form.observations} onChange={(e) => set('observations', e.target.value)} />
              </Field>
            </div>
          </section>

          {/* ── Encerramento (só na edição) ──────────────────────────────────── */}
          {isEditing && (
            <section id="sec-departure" className="bg-surface rounded-2xl p-6">
              <SectionHeader title="Encerramento" hint="Preencha ao desativar o cliente" />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Data de Saída">
                  <input type="date" className={inputCls}
                    value={form.departure_date} onChange={(e) => set('departure_date', e.target.value)}
                    disabled={form.active} />
                </Field>
                <Field label="Motivo da Saída" className="col-span-2">
                  <textarea rows={3} className={textareaCls} placeholder="Descreva o motivo do encerramento…"
                    value={form.departure_reason} onChange={(e) => set('departure_reason', e.target.value)}
                    disabled={form.active} />
                </Field>
                {form.active && (
                  <p className="col-span-2 text-[12px] text-fg-mute">
                    Altere o status para "Ex-Cliente" para habilitar os campos de encerramento.
                  </p>
                )}
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  )
}
