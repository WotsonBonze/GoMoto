import type { VehicleStatus } from '../schemas/vehicles'

export type { VehicleStatus }

/**
 * @type DocumentType
 * @description Especifica as categorias de documentos que podem ser anexados a clientes ou contratos.
 */
export type DocumentType =
  | 'drivers_license'
  | 'proof_of_residence'
  | 'contract'
  | 'identification'
  | 'deposit'
  | 'other';

/**
 * @interface Document
 * @description Estrutura que representa um arquivo de documento digitalizado no sistema.
 */
export interface Document {
  id: string;
  type: DocumentType;
  name: string;
  url?: string;
  uploaded_at: string;
}

/**
 * @type ChargeStatus
 * @description Estado de uma cobrança emitida (`charge_status`, ADR 0024).
 *
 * `overdue` não está aqui de propósito: atraso é derivado de `due_date`
 * (Princípio 4) e chega pelas telas via `charge_balances.is_overdue`, nunca
 * como valor armazenado. A união anterior — pending/overdue/prejudice —
 * descrevia a tabela `billings`, removida no redesenho.
 */
export type ChargeStatus = 'open' | 'paid' | 'cancelled' | 'written_off';


/**
 * @interface Vehicle
 * @description Entidade principal que representa um veículo da frota do sistema GoMoto.
 * Contém todas as informações técnicas, legais e administrativas do veículo.
 */
export interface Vehicle {
  id: string;
  tenant_id: string;
  license_plate: string;
  model: string;
  make: string;
  year_manufacture: string;
  year_model?: string;
  color: string;
  renavam: string;
  chassis: string;
  fuel?: string;
  engine_capacity?: string;
  previous_owner?: string;
  previous_owner_cpf?: string;
  purchase_date?: string;
  fipe_value?: number;
  maintenance_up_to_date?: boolean;
  status: VehicleStatus;
  photo_url?: string;
  km_current?: number;
  observations?: string;
  registered_owner_name?: string | null;
  registered_owner_document?: string | null;
  registered_owner_type?: 'cpf' | 'cnpj' | null;
  registration_state?: string | null;
  ownership_transferred?: boolean;
  ownership_transfer_date?: string | null;
  acquisition_type?: 'zero_km' | 'used' | 'settled' | 'financed' | 'consignment' | 'donation' | 'other' | null;
  acquisition_amount?: number | null;
  maintenance_plan_id?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * @type VehicleDocumentType
 * @description Categoria do documento físico/digital do veículo (PRD 0002).
 */
export type VehicleDocumentType = 'crv' | 'crlv' | 'transfer_receipt' | 'other';

/**
 * @interface VehicleDocument
 * @description Histórico do dossiê documental por veículo (PRD 0002).
 * Apenas um documento por (vehicle_id, type) pode ter is_current=true
 * — restrição garantida por índice parcial no banco.
 */
export interface VehicleDocument {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  type: VehicleDocumentType;
  exercise_year?: number | null;
  document_number?: string | null;
  issued_at?: string | null;
  registered_owner_name?: string | null;
  registered_owner_document?: string | null;
  registered_owner_type?: 'cpf' | 'cnpj' | null;
  file_url?: string | null;
  is_current: boolean;
  observations?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * @type VehicleObligationType
 * @description Tipos de pagamento obrigatório (recorrente) ou opcional do veículo.
 */
export type VehicleObligationType =
  | 'ipva'
  | 'licensing'
  | 'dpvat'
  | 'insurance'
  | 'crv_issuance'
  | 'detran_fee'
  | 'other';

/**
 * @type VehicleObligationStatus
 * @description Estado de uma obrigação. `overdue` é derivado em runtime — só será
 * gravado quando o PRD de alertas vier.
 */
export type VehicleObligationStatus = 'pending' | 'paid' | 'overdue' | 'exempt' | 'cancelled';

/**
 * @interface VehicleObligation
 * @description Pagamento anual obrigatório (IPVA, licenciamento, DPVAT) ou
 * opcional (seguro, taxa de emissão de CRV) por veículo (PRD 0002).
 */
export interface VehicleObligation {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  type: VehicleObligationType;
  reference_year: number;
  description?: string | null;
  amount: number;
  due_date: string;
  status: VehicleObligationStatus;
  paid_at?: string | null;
  payment_method?: string | null;
  payment_reference?: string | null;
  receipt_url?: string | null;
  observations?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * @interface VehicleCostSummary
 * @description Linha da view `vehicle_cost_summary` (PRD 0002 F1).
 * Agregado de TCO por veículo, sem duplicar lançamentos.
 */
export interface VehicleCostSummary {
  vehicle_id: string;
  tenant_id: string;
  obligations_paid: number;
  obligations_due: number;
  maintenance_cost: number;
  fines_company_paid: number;
  fines_customer_paid: number;
  expenses_paid: number;
}

/**
 * @type VehicleFinancialEventSource
 * @description Origem do evento na view `vehicle_financial_events`.
 */
export type VehicleFinancialEventSource = 'obligation' | 'maintenance' | 'fine' | 'expense';

/**
 * @interface VehicleFinancialEvent
 * @description Linha da view `vehicle_financial_events` (PRD 0002 F1).
 * Schema uniforme cross-tipo para a aba "Custo total" e relatórios.
 */
export interface VehicleFinancialEvent {
  event_id: string;
  tenant_id: string;
  vehicle_id: string;
  source: VehicleFinancialEventSource;
  subtype: string;
  description: string | null;
  amount: number | null;
  event_date: string | null;
  paid_at: string | null;
  status: string;
  attachment_url: string | null;
}

/**
 * @interface CustomerRentalHistory
 * @description Resumo de uma locação anterior realizada por um cliente específico.
 */
export interface CustomerRentalHistory {
  start_date: string;
  end_date?: string;
  vehicle_license_plate?: string;
  vehicle_model?: string;
  departure_reason: string;
  amount_due?: number;
}

/**
 * @interface Customer
 * @description Entidade que representa um cliente ou locatário no sistema.
 * Suporta pessoa física (CPF) e pessoa jurídica (CNPJ).
 */
export interface Customer {
  id: string;
  tenant_id: string;
  user_id?: string | null;
  person_type: 'individual' | 'company';
  name: string;
  // Pessoa física
  cpf?: string | null;
  rg?: string | null;
  birth_date?: string | null;
  drivers_license?: string | null;
  drivers_license_validity?: string | null;
  drivers_license_category?: string | null;
  drivers_license_photo_url?: string | null;
  // Pessoa jurídica
  cnpj?: string | null;
  company_name?: string | null;
  trade_name?: string | null;
  // Contato
  phone?: string | null;
  phone2?: string | null;
  email?: string | null;
  emergency_contact?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  // Endereço estruturado (novos campos)
  street?: string | null;
  street_number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  // Endereço legado (campo livre — mantido para compat)
  address?: string | null;
  // Documentos
  residency_proof_url?: string | null;
  document_photo_url?: string | null;
  // Gestão
  // `payment_status` e `delinquency_status` saíram na ADR 0024: eram colunas de
  // estado, uma escrita à mão e outra por trigger inerte. Inadimplência é
  // derivada da view `customer_delinquency`; bloqueio é a última ação em
  // `delinquency_blocks`.
  observations?: string | null;
  documents?: Document[];
  in_queue: boolean;
  active?: boolean;
  departure_date?: string | null;
  departure_reason?: string | null;
  rental_history?: CustomerRentalHistory[];
  created_at: string;
  updated_at: string;
}

/**
 * @interface Expense
 * @description Registro de saídas financeiras e custos operacionais da empresa.
 * Pode estar vinculada a um veículo específico ou ser uma despesa geral.
 */
export interface Expense {
  id: string;
  tenant_id: string;
  description: string;
  amount: number;
  category: string;
  date: string;
  vehicle_id?: string;
  observations?: string;
  invoice_url?: string | null;
  attachment_url?: string | null;
  payment_status?: 'pending' | 'paid' | null;
  paid_at?: string | null;
  created_at: string;
  updated_at?: string;
  vehicle?: Vehicle;
}

/**
 * @interface Maintenance
 * @description Registro de uma intervenção técnica realizada ou planejada em um veículo.
 */
export interface Maintenance {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  standard_item_id: string | null;
  type: 'preventive' | 'corrective' | 'inspection';
  description: string;
  predicted_km: number | null;
  actual_km: number | null;
  scheduled_date: string | null;
  completed_date: string | null;
  cost: number | null;
  effective_executor: 'company' | 'customer' | null;
  effective_customer_payer_pct: number | null;
  completed: boolean;
  workshop: string | null;
  odometer_photo_url: string | null;
  invoice_photo_url: string | null;
  observations: string | null;
  created_at: string;
  updated_at: string;
  vehicle?: Vehicle;
}

/**
 * @interface MaintenancePlan
 * @description Plano nomeado de manutenção criado pelo tenant (PRD 0003 §5.1).
 */
export interface MaintenancePlan {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  items?: MaintenancePlanItem[];
}

/**
 * @interface MaintenancePlanItem
 * @description Item canônico de um plano de manutenção (PRD 0003 §5.2).
 */
export interface MaintenancePlanItem {
  id: string;
  tenant_id: string;
  plan_id: string;
  name: string;
  interval_km: number | null;
  interval_days: number | null;
  warn_threshold_pct: number | null;
  is_critical: boolean;
  tip: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * @type MaintenanceRecordStatus
 */
export type MaintenanceRecordStatus = 'pending' | 'approved' | 'rejected';

/**
 * @interface MaintenanceRecord
 * @description Registro de execução de manutenção feito pelo cliente no mobile (PRD 0003 §F5).
 */
export interface MaintenanceRecord {
  id: string;
  tenant_id: string;
  customer_id: string;
  maintenance_id: string | null;
  vehicle_id: string;
  actual_km: number;
  cost: number | null;
  workshop: string | null;
  odometer_photo_url: string | null;
  invoice_photo_url: string | null;
  notes: string | null;
  status: MaintenanceRecordStatus;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * @interface Process
 */
export interface Process {
  id: string;
  tenant_id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
  created_at: string;
  updated_at: string;
}

/**
 * @interface Rental
 * @description Entidade de locação (antigo contracts, renomeado na Spec 0004).
 */
export interface Rental {
  id: string;
  tenant_id: string;
  customer_id: string;
  vehicle_id: string;
  contract_type: 'rental' | 'rent_to_own';
  cycle?: 'weekly' | 'monthly' | null;
  due_day?: number | null;
  cycle_amount?: number | null;
  use_pro_rata: boolean;
  start_date?: string | null;
  end_date?: string | null;
  /** @deprecated Use cycle_amount. */
  monthly_amount?: number | null;
  /** Km do veículo na entrega, congelado na criação (Spec 0014, RF-004). `null` em locação anterior a esta feature. */
  km_initial?: number | null;
  /** Km do veículo na devolução, gravado no encerramento (Spec 0014). */
  km_final?: number | null;
  /** Multa por rescisão antecipada configurada para esta locação (Spec 0015). `null` = sem multa configurada (RN-003). */
  early_termination_fine_amount?: number | null;
  /** Prazo mínimo de vigência, em dias corridos a partir de start_date (Spec 0015, RN-001). `null` = sem prazo mínimo configurado. */
  minimum_term_days?: number | null;
  status: 'active' | 'closed' | 'transferred';
  observations?: string | null;
  contract_template_id?: string | null;
  signed_contract_path?: string | null;
  signed_contract_file_name?: string | null;
  signed_contract_uploaded_at?: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  vehicle?: Vehicle;
  contract_template?: Pick<ContractTemplate, 'id' | 'name'>;
}

/** Resultado tipado de Server Actions (envelope padrão). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_ENTRY'
  | 'VEHICLE_ALREADY_RENTED'
  | 'VEHICLE_LOCKED'
  | 'RENTAL_NOT_ACTIVE'
  | 'BILLING_ALREADY_PAID'
  | 'BILLING_CANCELLED'
  | 'DOWN_PAYMENT_ALREADY_PAID'
  | 'DISCOUNT_EXCEEDS_AMOUNT'
  | 'TERMINATION_FINE_APPLICABLE'
  | 'NO_ACTIVE_RENTAL'
  | 'EXTRACTION_FAILED'
  | 'INTERNAL'
  | 'INTERNAL_ERROR'

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; field?: string } }

/**
 * @interface Fine
 * @description Multa de trânsito (PRD 0002): pertence ao veículo.
 */
export interface Fine {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  vehicle_id: string;
  description: string;
  amount: number;
  infraction_date: string;
  due_date: string | null;
  status: 'pending' | 'paid';
  payment_date: string | null;
  responsible: 'customer' | 'company';
  observations: string | null;
  ait_number?: string | null;
  infraction_location?: string | null;
  points?: number | null;
  // PRD 0013 — campos oficiais da NA (Notificação de Autuação) e da NP (Notificação de Penalidade)
  renainf_number?: string | null;
  notification_date?: string | null;
  prior_defense_deadline?: string | null;
  driver_identification_deadline?: string | null;
  appeal_deadline?: string | null;
  discounted_payment_deadline?: string | null;
  senatran_infraction_code?: string | null;
  issuing_agency_name?: string | null;
  driver_name?: string | null;
  driver_cnh?: string | null;
  driver_cpf?: string | null;
  driver_document?: string | null;
  infraction_time?: string | null;
  senatran_infraction_subcode?: string | null;
  issuing_agency_code?: string | null;
  competent_agency_code?: string | null;
  competent_agency_name?: string | null;
  measurement_instrument_id?: string | null;
  traffic_agent_id?: string | null;
  measured_speed?: number | null;
  considered_speed?: number | null;
  speed_limit?: number | null;
  original_renainf_number?: string | null;
  infraction_municipality_code?: string | null;
  infraction_municipality_name?: string | null;
  infraction_state?: string | null;
  senatran_message?: string | null;
  created_at: string;
  updated_at: string;
  customers?: { name: string; phone: string } | null;
  vehicles?: { license_plate: string; model: string; make: string } | null;
  fine_attachments?: { type: string }[];
}

/**
 * @interface ContractTemplate
 * @description Template de contrato editado no Tiptap. O campo `content` armazena
 * o documento ProseMirror em JSON; variáveis são marcadas como `{{chave}}` no texto.
 */
export interface ContractTemplate {
  id: string
  tenant_id: string
  name: string
  description: string | null
  content: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * @interface QueueEntry
 * @description Entrada na fila de espera de clientes por um veículo disponível.
 */
export interface QueueEntry {
  id: string;
  tenant_id: string;
  customer_id: string;
  position: number;
  status: 'waiting' | 'converted' | 'cancelled';
  notes: string | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
  customers?: {
    name: string;
    phone: string;
    drivers_license: string;
    drivers_license_validity: string | null;
  } | null;
}

export * from './financial'
export * from './inspection'
