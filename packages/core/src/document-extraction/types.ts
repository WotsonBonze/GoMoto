import { z } from 'zod'

/**
 * Tipos de documento suportados pela extração por IA (PRD 0012, RN-005).
 * Adicionar um tipo novo é uma entrada nova aqui + no registry — nunca uma
 * mudança nos tipos já entregues.
 *
 * Nomeado `ExtractionDocumentType` (não `DocumentType`) para não colidir com
 * o `DocumentType` já existente em `types/index.ts` (categorias de anexo de
 * cliente/contrato — feature não relacionada).
 */
export const DocumentTypeSchema = z.enum(['cnh', 'fine_notice'])
export type ExtractionDocumentType = z.infer<typeof DocumentTypeSchema>

/** Confiança da IA em um campo extraído — sinalização, nunca trava (RN-002). */
export const ExtractionConfidenceSchema = z.enum(['high', 'low'])
export type ExtractionConfidence = z.infer<typeof ExtractionConfidenceSchema>

/**
 * `description` vai para o JSON Schema enviado ao modelo (AI SDK repassa o
 * `.describe()`) — é onde o formato e o rótulo do documento de cada campo
 * chegam colados ao próprio campo, reforçando o prompt.
 */
export function extractionField<T extends z.ZodTypeAny>(valueSchema: T, description?: string) {
  const field = z.object({
    value: valueSchema.nullable(),
    confidence: ExtractionConfidenceSchema,
  })
  return description ? field.describe(description) : field
}
export type ExtractionField<T> = { value: T | null; confidence: ExtractionConfidence }

export function extractionResultSchema<TFields extends z.ZodRawShape>(
  fields: z.ZodObject<TFields>,
) {
  return z.object({
    documentType: DocumentTypeSchema,
    fields,
    fieldsFound: z.number().int().min(0),
    fieldsTotal: z.number().int().min(0),
  })
}
export type ExtractionResult<TFields> = {
  documentType: ExtractionDocumentType
  fields: TFields
  fieldsFound: number
  fieldsTotal: number
}

/** RNF-003: PDF/JPG/PNG/WEBP até 10MB — validado no client (feedback) e no Server Action (definitivo). */
export const ExtractDocumentFileSchema = z
  .instanceof(File)
  .refine((f) => f.size <= 10 * 1024 * 1024, 'Arquivo excede 10MB (RNF-003)')
  .refine(
    (f) => ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(f.type),
    'Formato não suportado — use PDF, JPG, PNG ou WEBP',
  )
