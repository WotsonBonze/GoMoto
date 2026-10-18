import { z } from 'zod'
import { extractionField, extractionResultSchema, type ExtractionDocumentType } from './types'
import { buildCnhPrompt, buildFineNoticePrompt } from './prompts'
import { CNH_CATEGORIES, postProcessCnhFields } from './cnh'

export const CnhFieldsSchema = z.object({
  name: extractionField(z.string(), 'Campo "NOME" / "2 e 1 NOME E SOBRENOME". Nunca os nomes da FILIAÇÃO.'),
  cpf: extractionField(z.string(), 'Campo "CPF" / "4d CPF". Exatamente 11 dígitos, só números.'),
  rg: extractionField(z.string(), 'Campo "DOC. IDENTIDADE / ÓRG. EMISSOR / UF" / "4c". Só o número, sem órgão emissor e UF.'),
  birth_date: extractionField(z.string(), 'Campo "DATA DE NASCIMENTO" / "3 DATA, LOCAL E UF DE NASCIMENTO". AAAA-MM-DD.'),
  drivers_license: extractionField(z.string(), 'Campo "Nº REGISTRO" / "5 Nº REGISTRO". Exatamente 11 dígitos. Não é o Nº do espelho (vertical, na lateral).'),
  // Enum, não texto livre: o select do formulário só aceita estes valores, e
  // o enum no JSON Schema impede o modelo de devolver outra coisa.
  drivers_license_category: extractionField(z.enum(CNH_CATEGORIES), 'Campo "CAT. HAB." / "9 CAT HAB". Não é a letra solta ao lado da caixa ACC nem a tabela do verso.'),
  drivers_license_validity: extractionField(z.string(), 'Campo "VALIDADE" / "4b VALIDADE". AAAA-MM-DD. Não é 1ª HABILITAÇÃO nem DATA EMISSÃO.'),
})
export type CnhFields = z.infer<typeof CnhFieldsSchema>
export const CnhExtractionResultSchema = extractionResultSchema(CnhFieldsSchema)
export type CnhExtractionResult = z.infer<typeof CnhExtractionResultSchema>

export const FineNoticeFieldsSchema = z.object({
  license_plate: extractionField(z.string()),
  description: extractionField(z.string()),
  infraction_date: extractionField(z.string()),
  amount: extractionField(z.number()),
  ait_number: extractionField(z.string()),
  infraction_location: extractionField(z.string()),
  // PRD 0013 — campos específicos da NA (Notificação de Autuação). Extração
  // não cobre a NP (RF-005) — devolve `null` se o documento não for uma NA.
  renainf_number: extractionField(z.string()),
  notification_date: extractionField(z.string()),
  prior_defense_deadline: extractionField(z.string()),
  driver_identification_deadline: extractionField(z.string()),
  senatran_infraction_code: extractionField(z.string()),
  senatran_infraction_subcode: extractionField(z.string()),
  issuing_agency_name: extractionField(z.string()),
  issuing_agency_code: extractionField(z.string()),
  competent_agency_code: extractionField(z.string()),
  competent_agency_name: extractionField(z.string()),
  driver_name: extractionField(z.string()),
  driver_cnh: extractionField(z.string()),
  driver_cpf: extractionField(z.string()),
  driver_document: extractionField(z.string()),
  infraction_time: extractionField(z.string()),
  measurement_instrument_id: extractionField(z.string()),
  traffic_agent_id: extractionField(z.string()),
  measured_speed: extractionField(z.number()),
  considered_speed: extractionField(z.number()),
  speed_limit: extractionField(z.number()),
  original_renainf_number: extractionField(z.string()),
  infraction_municipality_code: extractionField(z.string()),
  infraction_municipality_name: extractionField(z.string()),
  infraction_state: extractionField(z.string()),
  senatran_message: extractionField(z.string()),
})
export type FineNoticeFields = z.infer<typeof FineNoticeFieldsSchema>
export const FineNoticeExtractionResultSchema = extractionResultSchema(FineNoticeFieldsSchema)
export type FineNoticeExtractionResult = z.infer<typeof FineNoticeExtractionResultSchema>

interface DocumentExtractionEntry<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  fieldsSchema: TSchema
  promptBuilder: () => string
  targetEntity: 'customer' | 'fine'
  /** Normalização + checagens determinísticas após a resposta do modelo (opcional). */
  // Sintaxe de método de propósito: bivariante, aceita a função tipada de cada entrada.
  postProcess?(fields: z.infer<TSchema>): z.infer<TSchema>
}

// RN-005: novo tipo de documento = nova entrada aqui, sem tocar nas existentes.
export const documentExtractionRegistry = {
  cnh: {
    fieldsSchema: CnhFieldsSchema,
    promptBuilder: buildCnhPrompt,
    targetEntity: 'customer',
    postProcess: (fields: CnhFields): CnhFields => postProcessCnhFields(fields),
  },
  fine_notice: {
    fieldsSchema: FineNoticeFieldsSchema,
    promptBuilder: buildFineNoticePrompt,
    targetEntity: 'fine',
  },
} satisfies Record<ExtractionDocumentType, DocumentExtractionEntry>

export type DocumentExtractionRegistry = typeof documentExtractionRegistry
