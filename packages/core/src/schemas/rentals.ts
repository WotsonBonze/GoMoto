/**
 * @file schemas/rentals.ts
 * @description Schemas Zod para o módulo de locação e cobranças (Spec 0004 §5.2).
 * Todos os campos de UI são validados aqui antes de chegarem às Server Actions.
 */

import { z } from 'zod'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (YYYY-MM-DD)')

// ---------------------------------------------------------------------------
// Locação — criação
// ---------------------------------------------------------------------------

export const RentalSchema = z.object({
  vehicle_id:         z.string().uuid({ error: 'Veículo obrigatório' }),
  customer_id:        z.string().uuid({ error: 'Cliente obrigatório' }),
  contract_type:      z.enum(['rental', 'rent_to_own']).default('rental'),
  cycle:              z.enum(['weekly', 'monthly']),
  due_day:            z.number().int().min(1).max(28),
  cycle_amount:       z.number().positive({ error: 'Valor do ciclo deve ser positivo' }),
  start_date:         dateString,
  end_date:           dateString,
  use_pro_rata:       z.boolean().default(true),
  // Km do veículo na entrega (Spec 0014, RN-004) — congelado na criação,
  // fonte do km impresso no contrato (RF-004). Validado contra o km atual do
  // veículo (RN-002) pela RPC, que é quem trava a linha do veículo.
  km_initial:         z.number().int().nonnegative({ error: 'Km inicial inválido' }),
  security_deposit:   z.number().min(0).nullable().optional(),
  // Se a caução já foi paga no momento da criação (default true — cobrança
  // nasce 'paid'). Se false, gera cobrança 'pending' aguardando pagamento.
  deposit_paid:       z.boolean().default(true),
  // Relevante apenas quando deposit_paid = true: quando o pagamento ocorreu.
  deposit_payment_date: dateString.optional(),
  // Relevante apenas quando deposit_paid = false: vencimento da cobrança.
  deposit_due_date:     dateString.optional(),
  // Entrada (Spec 0010) — valor opcional, não reembolsável, informado só na
  // criação (RN-002). Mesmo racional de deposit_paid/_payment_date/_due_date.
  down_payment:              z.number().min(0).nullable().optional(),
  down_payment_paid:         z.boolean().default(true),
  down_payment_payment_date: dateString.optional(),
  down_payment_due_date:     dateString.optional(),
  // Modelo de contrato usado para gerar o PDF na criação (opcional).
  contract_template_id: z.string().uuid().nullable().optional(),
  observations:       z.string().max(2000).nullable().optional(),
  // Vínculos de Perfil de Vistoria (Spec 0009 / ADR 0015) — independentes
  // entre si (RN-004). checkin_checkout e periodic podem coexistir, faltar
  // um, ou faltar os dois.
  checkin_checkout_inspection_profile_id: z.string().uuid().nullable().optional(),
  periodic_inspection_profile_id:         z.string().uuid().nullable().optional(),
  periodic_inspection_frequency_days:     z.number().int().positive().nullable().optional(),
}).refine((d) => d.end_date > d.start_date, {
  message: 'Data de fim deve ser posterior à data de início',
  path: ['end_date'],
}).refine(
  (d) => !!d.periodic_inspection_profile_id === !!d.periodic_inspection_frequency_days,
  {
    message: 'Frequência é obrigatória quando o perfil de vistoria periódica é associado',
    path: ['periodic_inspection_frequency_days'],
  },
) // RN-005 — espelha o CHECK de banco (defesa em profundidade, não substitui)

export type CreateRental = z.infer<typeof RentalSchema>

// ---------------------------------------------------------------------------
// Locação — renovação
// ---------------------------------------------------------------------------

export const RenewRentalSchema = z.object({
  lease_id:         z.string().uuid(),
  new_end_date:     dateString,
  current_end_date: dateString,
}).refine((d) => d.new_end_date > d.current_end_date, {
  message: 'Nova data de fim deve ser posterior à data de fim atual',
  path: ['new_end_date'],
})

export type RenewRental = z.infer<typeof RenewRentalSchema>

// ---------------------------------------------------------------------------
// Locação — ajuste de período e condições (ADR 0035)
// ---------------------------------------------------------------------------

/**
 * Ajuste dos seis parâmetros que definem o cronograma.
 *
 * Substitui `RenewRentalSchema` (só estendia o fim) e `AdjustScheduleSchema`
 * (só mudava o valor). Os dois eram recortes do mesmo ato — mudar as condições
 * do contrato e regerar o plano a partir de uma data de vigência.
 *
 * A validação de VIABILIDADE (cobrança já paga na faixa, nada a cobrar depois
 * do novo fim) não mora aqui: depende do estado do cronograma, e é
 * `planPeriodAdjustment` que a faz — a mesma função que alimenta a prévia.
 */
export const AdjustRentalPeriodSchema = z.object({
  rental_id:      z.string().uuid(),
  start_date:     dateString,
  end_date:       dateString,
  cycle:          z.enum(['weekly', 'monthly']),
  due_day:        z.number().int().min(1).max(28),
  cycle_amount:   z.number().positive({ error: 'Valor do ciclo deve ser positivo' }),
  use_pro_rata:   z.boolean(),
  /** Fronteira entre história e futuro: antes dela, nada muda. */
  effective_from: dateString,
  justification:  z.string().trim().min(3, { error: 'Informe a justificativa do ajuste' }).max(500),
}).refine((d) => d.end_date > d.start_date, {
  message: 'Data de fim deve ser posterior à data de início',
  path: ['end_date'],
})

export type AdjustRentalPeriod = z.infer<typeof AdjustRentalPeriodSchema>

// ---------------------------------------------------------------------------
// Locação — encerramento
// ---------------------------------------------------------------------------

export const TerminateRentalSchema = z.object({
  lease_id:         z.string().uuid(),
  termination_date: dateString,
  new_status:       z.enum(['closed', 'transferred']).default('closed'),
  /**
   * Spec 0014 / F-08: sem `force`, a RPC recusa encerrar locação com cobrança
   * em aberto. A apuração financeira passa a ser pré-requisito do
   * encerramento, não consequência.
   */
  force:            z.boolean().optional().default(false),
  // Km do veículo na devolução (Spec 0014, RN-004) — exigido em TODO
  // encerramento, mesmo de locação criada antes desta feature (km_initial
  // nulo). Validado contra o km atual do veículo e contra km_initial (RN-002
  // + RN-003) pela RPC, que é quem trava a linha do veículo.
  km_final:         z.number().int().nonnegative({ error: 'Km final inválido' }),
})

export type TerminateRental = z.infer<typeof TerminateRentalSchema>

// ---------------------------------------------------------------------------
// Cobrança — baixa manual
// ---------------------------------------------------------------------------

export const RegisterPaymentSchema = z.object({
  billing_id:     z.string().uuid(),
  paid_at:        dateString,
  payment_method: z.enum(['pix', 'cash', 'credit_card', 'debit_card', 'bank_transfer']),
})

export type RegisterPayment = z.infer<typeof RegisterPaymentSchema>

// ---------------------------------------------------------------------------
// Cobrança — desconto
// ---------------------------------------------------------------------------

export const ApplyDiscountSchema = z.object({
  billing_id:      z.string().uuid(),
  discount_amount: z.number().positive({ error: 'Valor do desconto deve ser positivo' }),
  discount_reason: z.string().min(3, { error: 'Motivo deve ter ao menos 3 caracteres' }),
})

export type ApplyDiscount = z.infer<typeof ApplyDiscountSchema>

// ---------------------------------------------------------------------------
// Cobrança — avulsa
// ---------------------------------------------------------------------------

export const OneTimeChargeSchema = z.object({
  lease_id:    z.string().uuid(),
  description: z.string().min(3, { error: 'Descrição deve ter ao menos 3 caracteres' }),
  amount:      z.number().positive({ error: 'Valor deve ser positivo' }),
  due_date:    dateString,
})

export type CreateOneTimeCharge = z.infer<typeof OneTimeChargeSchema>

// ---------------------------------------------------------------------------
// Fila — adicionar cliente
// ---------------------------------------------------------------------------

export const AddToQueueSchema = z.object({
  customer_id: z.string().uuid({ error: 'Cliente obrigatório' }),
})

export type AddToQueue = z.infer<typeof AddToQueueSchema>

// ---------------------------------------------------------------------------
// Fila — converter para locação
// ---------------------------------------------------------------------------

export const CreateRentalFromQueueSchema = RentalSchema.extend({
  queue_entry_id: z.string().uuid(),
})

export type CreateRentalFromQueue = z.infer<typeof CreateRentalFromQueueSchema>

// ---------------------------------------------------------------------------
// Documentos de clientes — upload
// ---------------------------------------------------------------------------

export const UploadClientDocumentSchema = z.object({
  customer_id:   z.string().uuid({ error: 'Cliente obrigatório' }),
  document_type: z.enum([
    'drivers_license_front',
    'drivers_license_back',
    'id_front',
    'id_back',
    'other',
  ]),
  storage_path: z.string().min(1),
  file_name:    z.string().min(1),
})

export type UploadClientDocument = z.infer<typeof UploadClientDocumentSchema>

// ---------------------------------------------------------------------------
// Locação — anexo do contrato assinado
// ---------------------------------------------------------------------------

export const AttachSignedContractSchema = z.object({
  lease_id:     z.string().uuid(),
  storage_path: z.string().min(1),
  file_name:    z.string().min(1),
})

export type AttachSignedContract = z.infer<typeof AttachSignedContractSchema>
