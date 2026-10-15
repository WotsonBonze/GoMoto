import { z } from 'zod'
import { isCpfDigits, normalizeCpf, validateCpfDigits } from '../identity/index'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)')
const timeString = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time format (HH:MM)')

/**
 * CPF aceita qualquer formato na entrada (com ou sem máscara) e
 * normaliza para 11 dígitos antes de validar. Rejeita ausente/inválido —
 * é identidade obrigatória do cliente (ADR 0004 §2).
 */
const cpfDigitsString = z
  .string({ error: 'CPF é obrigatório' })
  .transform((input) => normalizeCpf(input))
  .refine((digits) => isCpfDigits(digits), { message: 'CPF inválido: precisa ter 11 dígitos' })
  .refine((digits) => validateCpfDigits(digits), { message: 'CPF inválido: dígito verificador incorreto' })

/**
 * VehicleDocumentSchema — CRV/CRLV/recibo de transferência (PRD 0002).
 * Cada moto tem no máximo 1 documento `is_current=true` por tipo
 * (garantido por índice parcial único na migration).
 */
export const VehicleDocumentSchema = z.object({
  vehicle_id: z.string().uuid(),
  type: z.enum(['crv', 'crlv', 'transfer_receipt', 'other']),
  exercise_year: z.number().int().min(1900).max(2100).optional().nullable(),
  document_number: z.string().trim().max(50).optional().nullable(),
  issued_at: dateString.optional().nullable(),
  registered_owner_name: z.string().trim().max(200).optional().nullable(),
  registered_owner_document: z.string().trim().max(20).optional().nullable(),
  registered_owner_type: z.enum(['cpf', 'cnpj']).optional().nullable(),
  file_url: z.string().url().optional().nullable(),
  is_current: z.boolean().optional(),
  observations: z.string().trim().max(2000).optional().nullable(),
})

/**
 * VehicleObligationSchema — IPVA/licenciamento/DPVAT/seguro/taxa (PRD 0002).
 * `overdue` é derivado em runtime (rules/documentation) e não deve ser
 * gravado diretamente no V1, mas é aceito no enum para o futuro PRD de alertas.
 */
export const VehicleObligationSchema = z.object({
  vehicle_id: z.string().uuid(),
  type: z.enum(['ipva', 'licensing', 'dpvat', 'insurance', 'crv_issuance', 'detran_fee', 'other']),
  reference_year: z.number().int().min(1900).max(2100),
  description: z.string().trim().max(300).optional().nullable(),
  amount: z.number().min(0).max(9999999),
  due_date: dateString,
  status: z.enum(['pending', 'paid', 'overdue', 'exempt', 'cancelled']).optional(),
  paid_at: dateString.optional().nullable(),
  payment_method: z.string().trim().max(50).optional().nullable(),
  payment_reference: z.string().trim().max(200).optional().nullable(),
  receipt_url: z.string().url().optional().nullable(),
  observations: z.string().trim().max(2000).optional().nullable(),
})

const cnpjDigitsString = z
  .string()
  .transform((s) => s.replace(/\D/g, ''))
  .refine((d) => d.length === 14, { message: 'CNPJ inválido: precisa ter 14 dígitos' })

export const CustomerSchema = z.object({
  person_type: z.enum(['individual', 'company']).default('individual'),
  name: z.string().trim().min(1).max(200),
  // Pessoa física
  cpf: cpfDigitsString.optional().nullable(),
  rg: z.string().trim().max(9).optional().nullable(),
  birth_date: dateString.optional().nullable(),
  drivers_license: z.string().trim().max(11).optional().nullable(),
  drivers_license_validity: dateString.optional().nullable(),
  drivers_license_category: z.string().trim().max(10).optional().nullable(),
  // Pessoa jurídica
  cnpj: cnpjDigitsString.optional().nullable(),
  company_name: z.string().trim().max(200).optional().nullable(),
  trade_name: z.string().trim().max(200).optional().nullable(),
  // Contato
  phone: z.string().trim().max(20).optional().nullable(),
  phone2: z.string().trim().max(20).optional().nullable(),
  email: z.string().email().max(200).optional().nullable(),
  emergency_contact: z.string().trim().max(300).optional().nullable(),
  emergency_contact_name: z.string().trim().max(200).optional().nullable(),
  emergency_contact_phone: z.string().trim().max(20).optional().nullable(),
  emergency_contact_name2: z.string().trim().max(200).optional().nullable(),
  emergency_contact_phone2: z.string().trim().max(20).optional().nullable(),
  emergency_contact_name3: z.string().trim().max(200).optional().nullable(),
  emergency_contact_phone3: z.string().trim().max(20).optional().nullable(),
  // Endereço estruturado
  street: z.string().trim().max(300).optional().nullable(),
  street_number: z.string().trim().max(20).optional().nullable(),
  complement: z.string().trim().max(100).optional().nullable(),
  neighborhood: z.string().trim().max(100).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(2).optional().nullable(),
  zip_code: z.string().trim().max(10).optional().nullable(),
  // Legado
  address: z.string().trim().max(1000).optional().nullable(),
  // Documentos — path no bucket customer-documents, não URL pública (Spec 0012 §4.3)
  drivers_license_photo_url: z.string().trim().max(500).optional().nullable(),
  residency_proof_url: z.string().trim().max(500).optional().nullable(),
  // Gestão
  observations: z.string().trim().max(2000).optional().nullable(),
  in_queue: z.boolean().optional(),
  active: z.boolean().optional(),
  departure_date: dateString.optional().nullable(),
  departure_reason: z.string().trim().max(1000).optional().nullable(),
})


export const ExpenseSchema = z.object({
  description: z.string().trim().min(1).max(300),
  amount: z.number().positive().max(9999999),
  category: z.string().trim().max(100),
  date: dateString,
  vehicle_id: z.string().uuid().optional().nullable(),
  observations: z.string().trim().max(2000).optional().nullable(),
  invoice_url: z.string().url().optional().nullable(),
  attachment_url: z.string().url().optional().nullable(),
  // PRD 0002 — despesas podem ser lançadas com vencimento futuro
  payment_status: z.enum(['pending', 'paid']).optional(),
  paid_at: dateString.optional().nullable(),
})

/**
 * FineSchema — PRD 0002 (D3, D6): multa pertence ao veículo. customer_id
 * é opcional (pode ser atribuído depois da identificação do condutor).
 *
 * PRD 0013 — campos oficiais dos dois documentos do processo de multa
 * brasileiro: NA (Notificação de Autuação) e NP (Notificação de Penalidade).
 * RENAINF é opcional (sem obrigatoriedade condicional por órgão) — multa de
 * área privada é possível mas rara pra uma locadora; se aparecer um caso real,
 * revisita a regra então.
 */
export const FineSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  vehicle_id: z.string().uuid(),
  description: z.string().trim().min(1).max(300),
  amount: z.number().positive().max(9999999),
  infraction_date: dateString,
  due_date: dateString.optional().nullable(),
  // `status` e `payment_date` saíram da tabela na ADR 0024: pagamento de multa
  // é fato financeiro e vive em `payables` (empresa) ou na cobrança (cliente).
  // Enquanto continuaram no schema, o INSERT mandava colunas inexistentes e
  // cadastrar multa falhava inteiro — com o erro do banco engolido.
  // Obrigatório — decide se a multa gera cobrança pro cliente (sem default: operador tem que escolher).
  responsible: z.enum(['customer', 'company']),
  observations: z.string().trim().max(2000).optional().nullable(),
  // PRD 0002 — campos do AIT (Auto de Infração de Trânsito)
  ait_number: z.string().trim().max(50).optional().nullable(),
  infraction_location: z.string().trim().max(2000).optional().nullable(),
  points: z.number().int().min(0).max(7).optional().nullable(),
  // PRD 0013 — campos oficiais da NA
  renainf_number: z.string().trim().max(30).optional().nullable(),
  notification_date: dateString.optional().nullable(),
  prior_defense_deadline: dateString.optional().nullable(),
  driver_identification_deadline: dateString.optional().nullable(),
  senatran_infraction_code: z.string().trim().max(20).optional().nullable(),
  senatran_infraction_subcode: z.string().trim().max(10).optional().nullable(),
  issuing_agency_name: z.string().trim().max(200).optional().nullable(),
  issuing_agency_code: z.string().trim().max(20).optional().nullable(),
  competent_agency_code: z.string().trim().max(20).optional().nullable(),
  competent_agency_name: z.string().trim().max(200).optional().nullable(),
  driver_name: z.string().trim().max(200).optional().nullable(),
  driver_cnh: z.string().trim().max(20).optional().nullable(),
  driver_cpf: z.string().trim().max(20).optional().nullable(),
  driver_document: z.string().trim().max(30).optional().nullable(),
  infraction_time: timeString.optional().nullable(),
  measurement_instrument_id: z.string().trim().max(50).optional().nullable(),
  traffic_agent_id: z.string().trim().max(50).optional().nullable(),
  measured_speed: z.number().min(0).max(999).optional().nullable(),
  considered_speed: z.number().min(0).max(999).optional().nullable(),
  speed_limit: z.number().min(0).max(999).optional().nullable(),
  original_renainf_number: z.string().trim().max(30).optional().nullable(),
  infraction_municipality_code: z.string().trim().max(10).optional().nullable(),
  infraction_municipality_name: z.string().trim().max(100).optional().nullable(),
  infraction_state: z.string().trim().max(2).optional().nullable(),
  senatran_message: z.string().trim().max(2000).optional().nullable(),
  // PRD 0013 — campos oficiais da NP
  appeal_deadline: dateString.optional().nullable(),
  discounted_payment_deadline: dateString.optional().nullable(),
})

/**
 * TenantSchema — usado na criação/edição de tenants pela área administrativa
 * da plataforma. Slug obedece kebab-case (mesma convenção dos seeds).
 */
/**
 * CNPJ aceita máscara na entrada, normaliza para 14 dígitos antes de
 * validar. Opcional — a empresa pode entrar sem CNPJ formal (ex.: piloto).
 */
const cnpjDigitsOptional = z
  .string()
  .trim()
  .transform((input) => input.replace(/\D+/g, ''))
  .refine((digits) => digits === '' || /^[0-9]{14}$/.test(digits), {
    message: 'CNPJ inválido: precisa ter 14 dígitos',
  })
  .optional()
  .nullable()

const cepDigits = z
  .string()
  .trim()
  .transform((input) => input.replace(/\D+/g, ''))
  .refine((digits) => /^[0-9]{8}$/.test(digits), { message: 'CEP precisa ter 8 dígitos' })

const ufCode = z
  .string()
  .trim()
  .transform((input) => input.toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), { message: 'UF precisa ter 2 letras' })

export const TenantSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use apenas letras minúsculas, números e hífens (ex.: gomoto-norte)'),
  legal_name: z.string().trim().min(2, 'Razão social é obrigatória').max(200),
  cnpj: cnpjDigitsOptional,
  contact_email: z.string().trim().toLowerCase().email('Email de contato inválido').max(200),
  contact_phone: z.string().trim().min(8, 'Telefone obrigatório').max(30),
  address_zip: cepDigits,
  address_street: z.string().trim().min(2, 'Logradouro obrigatório').max(200),
  address_number: z.string().trim().min(1, 'Número obrigatório').max(20),
  address_complement: z.string().trim().max(100).optional().nullable(),
  address_district: z.string().trim().min(2, 'Bairro obrigatório').max(100),
  address_city: z.string().trim().min(2, 'Cidade obrigatória').max(100),
  address_state: ufCode,
})

/**
 * Cadastro completo de empresa (tenant + owner principal).
 * O owner é criado em auth.users pelo RPC; a senha é definida pelo
 * platform_admin no momento do cadastro (cliente troca depois).
 */
export const CreateTenantWithOwnerSchema = z.object({
  tenant: TenantSchema,
  owner: z.object({
    name: z.string().trim().min(2, 'Nome do responsável é obrigatório').max(200),
    email: z.string().trim().toLowerCase().email('Email do owner inválido').max(200),
    password: z.string().min(8, 'Senha precisa de no mínimo 8 caracteres').max(72),
  }),
})

export * from './rentals'
export * from './vehicles'
export * from './contractTemplates'
export * from './financial'
export * from './inspectionProfile'
export * from './inspection'
export * from './theme'
export * from './access-control'
export * from './tenantContacts'

export const TenantSuspendSchema = z.object({
  reason: z.string().trim().min(1, 'Informe o motivo da suspensão').max(500),
})

export const MaintenanceBootstrapSchema = z.array(z.object({
  standard_item_id: z.string().uuid(),
  last_km: z.number().int().min(0).optional().nullable(),
  last_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  next_km: z.number().int().min(0).optional().nullable(),
  next_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  status: z.enum(['pending', 'done', 'overdue']).optional(),
  observations: z.string().trim().max(2000).optional().nullable(),
}))

/**
 * Plano de manutenção (PRD 0003 §5.1). Cada tenant cria seus próprios planos;
 * um único `is_default=true` ativo por tenant (índice parcial garante).
 */
export const MaintenancePlanSchema = z.object({
  name: z.string().trim().min(1, 'Nome do plano é obrigatório').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  is_default: z.boolean().optional(),
})

/**
 * Item canônico do plano (PRD 0003 §5.2). Toda manutenção do plano é
 * preventiva por contrato — `category`/`type` foram removidos do V1
 * (decisão revisada do ADR 0006: quem paga é decidido pelo operador
 * no momento, sem regra automática por categoria). Pelo menos um de
 * `interval_km` / `interval_days` é exigido — o CHECK no banco também garante.
 */
export const MaintenancePlanItemSchema = z.object({
  plan_id: z.string().uuid(),
  name: z.string().trim().min(1, 'Nome do item é obrigatório').max(200),
  interval_km: z.number().int().positive().optional().nullable(),
  interval_days: z.number().int().positive().optional().nullable(),
  warn_threshold_pct: z.number().int().min(1).max(100).optional().nullable(),
  is_critical: z.boolean().optional(),
  tip: z.string().trim().max(2000).optional().nullable(),
  sort_order: z.number().int().min(0).optional(),
}).refine(
  (data) => data.interval_km != null || data.interval_days != null,
  { message: 'Informe ao menos um intervalo (km ou dias)', path: ['interval_km'] },
)

export * from './ledger'
