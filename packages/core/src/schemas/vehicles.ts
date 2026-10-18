import { z } from 'zod'
import { isVehicleModelYearCoherent } from '../rules/vehicles'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (AAAA-MM-DD)')

export const VehicleStatusEnum = z.enum([
  'available',
  'rented',
  'reserved',
  'maintenance',
  'sinister',
  'sold',
  'inactive',
])
export type VehicleStatus = z.infer<typeof VehicleStatusEnum>

export const VehiclePhotoSlotEnum = z.enum([
  'principal', 'front', 'left_side', 'right_side', 'rear', 'dashboard',
])
export type VehiclePhotoSlot = z.infer<typeof VehiclePhotoSlotEnum>

export const AcquisitionTypeEnum = z.enum([
  'zero_km', 'used', 'settled', 'financed', 'consignment', 'donation', 'other',
])
export type AcquisitionType = z.infer<typeof AcquisitionTypeEnum>

export const VehicleTypeEnum = z.enum(['motorcycle', 'car'], { error: 'Tipo do veículo é obrigatório' })
export type VehicleType = z.infer<typeof VehicleTypeEnum>

/**
 * Campo opcional de texto: string vazia vira `null`. RENAVAM e chassi têm
 * índice único por tenant — `''` gravado em dois veículos colide, `NULL` não.
 */
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional())

const yearString = (label: string) =>
  z.string({ error: `${label} é obrigatório` })
    .trim()
    .regex(/^\d{4}$/, `${label} deve ter 4 dígitos`)

const imeiSchema = z
  .string()
  .regex(/^\d{15}$/, 'IMEI deve ter exatamente 15 dígitos numéricos')
  .optional()
  .nullable()

export const VehicleBaseSchema = z.object({
  license_plate:             z.string().trim().min(1, 'Placa é obrigatória').max(10),
  /** Opcional desde o cadastro simplificado: fica em "Identificação complementar". */
  renavam:                   optionalText(20),
  vehicle_type:              VehicleTypeEnum,
  make:                      z.string().trim().min(1, 'Marca é obrigatória').max(100),
  model:                     z.string().trim().min(1, 'Modelo é obrigatório').max(100),
  year_manufacture:          yearString('Ano de fabricação'),
  year_model:                yearString('Ano modelo'),
  color:                     z.string({ error: 'Cor é obrigatória' }).trim().min(1, 'Cor é obrigatória').max(50),
  fuel:                      z.string().trim().max(50).optional().nullable(),
  chassis:                   optionalText(20),
  engine_capacity:           z.string().trim().max(20).optional().nullable(),
  km_entry:                  z.number().int().min(0).optional().nullable(),
  observations:              z.string().trim().max(2000).optional().nullable(),
  acquisition_type:          AcquisitionTypeEnum.optional().nullable(),
  purchase_date:             dateString.optional().nullable(),
  acquisition_amount:        z.number().positive().max(9_999_999).optional().nullable(),
  fipe_value:                z.number().positive().max(9_999_999).optional().nullable(),
  previous_owner:            z.string().trim().max(200).optional().nullable(),
  previous_owner_cpf:        z.string().trim().max(14).optional().nullable(),
  registered_owner_name:     z.string().trim().max(200).optional().nullable(),
  registered_owner_document: z.string().trim().max(20).optional().nullable(),
  registered_owner_type:     z.enum(['cpf', 'cnpj']).optional().nullable(),
  registration_state:        z.string().trim().max(2).optional().nullable(),
  ownership_transferred:     z.boolean().optional(),
  ownership_transfer_date:   dateString.optional().nullable(),
  /**
   * Qualquer status VÁLIDO é aceito na validação do payload; QUAL transição o
   * operador pode fazer é outra pergunta, e ela já tem dono: `canChangeStatus`
   * e a guarda de `updateVehicle`, que descarta `status` quando a moto está
   * locada (RN-002).
   *
   * Aqui havia uma lista inline com os 4 valores selecionáveis à mão (RF-016).
   * Como ela validava o payload INTEIRO, e o formulário devolve o status atual
   * junto com o resto, nenhum veículo locado podia ser editado: o Zod reprovava
   * em `status` antes de qualquer regra rodar. Salvar não fazia nada — sem
   * mensagem, porque a tela não tem slot de erro para um campo que ela mostra
   * como informativo ("gerenciado automaticamente via contratos"). Neste banco
   * eram 16 motos impossíveis de editar: trocar cor, cadastrar rastreador,
   * lançar IPVA, nada.
   */
  status: VehicleStatusEnum.optional(),
  has_tracker:               z.boolean().optional(),
  tracker_brand:             z.string().trim().max(100).optional().nullable(),
  tracker_model:             z.string().trim().max(100).optional().nullable(),
  tracker_imei:              imeiSchema,
  has_insurance:             z.boolean().optional(),
  insurance_monthly_amount:  z.number().positive().max(9_999_999).optional().nullable(),
  insurance_expiry_date:     dateString.optional().nullable(),
})

export const VehicleSchema = VehicleBaseSchema.refine(
  (d) => isVehicleModelYearCoherent(d.year_manufacture, d.year_model),
  { message: 'Ano modelo deve ser igual ao ano de fabricação ou o seguinte', path: ['year_model'] },
).refine(
  (d) => !d.has_tracker || (d.tracker_brand && d.tracker_model && d.tracker_imei),
  { message: 'Preencha marca, modelo e IMEI do rastreador', path: ['tracker_brand'] },
).refine(
  (d) => !d.has_insurance || (d.insurance_monthly_amount && d.insurance_expiry_date),
  { message: 'Preencha valor mensal e vencimento do seguro', path: ['insurance_monthly_amount'] },
)

export const VehicleStatusTransitionSchema = z.object({
  vehicle_id: z.string().uuid(),
  new_status: VehicleStatusEnum,
})

export const AssignMaintenancePlanSchema = z.object({
  vehicle_id: z.string().uuid(),
  plan_id: z.string().uuid().nullable(),
  // último KM/data informado por item do plano, só usado quando o veículo
  // não tinha plano nenhum antes (bootstrap) — chave é o id do item.
  bootstrap_items: z.record(z.string(), z.string()).optional(),
})

export const VehiclePhotoUpsertSchema = z.object({
  vehicle_id: z.string().uuid(),
  slot:       VehiclePhotoSlotEnum,
  url:        z.string().url(),
})

export interface VehicleStatusHistoryEntry {
  id:              string
  tenant_id:       string
  vehicle_id:      string
  previous_status: VehicleStatus | null
  new_status:      VehicleStatus
  changed_by:      string | null
  created_at:      string
}

export interface VehiclePhoto {
  id:         string
  tenant_id:  string
  vehicle_id: string
  slot:       VehiclePhotoSlot
  url:        string
  created_at: string
  updated_at: string
}

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  motorcycle: 'Moto',
  car:        'Carro',
}

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  available:   'Disponível',
  rented:      'Locado',
  reserved:    'Reservado',
  maintenance: 'Em manutenção',
  sinister:    'Sinistrado',
  sold:        'Vendido',
  inactive:    'Desativado',
}

export const VEHICLE_PHOTO_SLOT_LABELS: Record<VehiclePhotoSlot, string> = {
  principal:  'Principal',
  front:      'Frontal',
  left_side:  'Lateral esquerda',
  right_side: 'Lateral direita',
  rear:       'Traseira',
  dashboard:  'Painel',
}

export const ACQUISITION_TYPE_LABELS: Record<AcquisitionType, string> = {
  zero_km:     'Zero KM',
  used:        'Compra (usada)',
  settled:     'Quitada',
  financed:    'Financiada',
  consignment: 'Consignação',
  donation:    'Doação',
  other:       'Outro',
}
