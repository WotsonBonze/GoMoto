import { generateText, Output } from 'ai'
import type { ZodType } from 'zod'
import { documentExtractionRegistry, type ExtractionDocumentType, type ExtractionResult } from '@gomoto/core'
import { buildMockResult, isMockEnabled } from './mock'
import { summarize, type RegistryFieldsOf } from './shared'

// RNF-001. AI SDK aplica isso como timeout total da chamada (aborta e rejeita
// se exceder) — não precisamos de Promise.race manual.
// Subiu de 15s pra 30s em 2026-08-11: o schema de fine_notice praticamente
// dobrou (PRD 0013, ~32 campos) e passou a estourar os 15s originais em
// chamada real ("Delay was aborted").
export const EXTRACTION_TIMEOUT_MS = 30_000

// Questão aberta na Spec 0012 §11.2: validar gemini-2.5-flash vs gemini-2.5-pro
// com documentos reais antes de produção — string de config, troca não muda
// arquitetura.
const MODEL = 'google/gemini-2.5-flash'

/**
 * Único ponto que chama o Gemini de fato (Spec 0012 §2.2/ADR 0023). Genérico
 * por `documentType` via registry — não conhece Cliente/Multa. Nunca lança:
 * timeout e erro de provedor viram `null`, o caller (Server Action) decide
 * como traduzir isso em `ActionResult` (EXTRACTION_FAILED) e como logar.
 */
export async function extractFields<T extends ExtractionDocumentType>(
  documentType: T,
  file: File,
): Promise<ExtractionResult<RegistryFieldsOf<T>> | null> {
  if (isMockEnabled()) {
    return buildMockResult(documentType, file)
  }

  try {
    const entry = documentExtractionRegistry[documentType]
    const buffer = Buffer.from(await file.arrayBuffer())

    const { output } = await generateText({
      model: MODEL,
      timeout: EXTRACTION_TIMEOUT_MS,
      // Extração, não criação: mesma imagem deve dar a mesma leitura.
      temperature: 0,
      providerOptions: {
        gateway: {
          // RNF-005 — só vale com credenciais gerenciadas do AI Gateway (ADR 0023 §2).
          disallowPromptTraining: true,
          // Só Google AI Studio. O gateway roteava `google/gemini-*` entre
          // `google` e `vertex`, e a Vertex rasteriza PDF com menos detalhe
          // (2841 tokens × 1369 na mesma CNH Digital): em teste real
          // (2026-10-15) a Vertex leu a categoria errada em 100% das chamadas
          // e trocou CPF por Nº Registro em ~1/3; o AI Studio acertou todas.
          // Era a causa das falhas INTERMITENTES — a rota mudava por sessão.
          // `order: ['google', 'vertex']` não resolve: a afinidade de sessão
          // do gateway promove a Vertex por cima da ordem pedida. Sem fallback
          // de provedor: se o AI Studio cair, a extração falha e o operador
          // preenche à mão (RNF-002) — melhor que preencher errado com "high".
          only: ['google'],
        },
      },
      // Registry guarda o schema por documentType como união (RN-005); TS não
      // correlaciona isso com o T genérico aqui — narrow explícito, seguro
      // porque `entry` vem de indexar pelo próprio `documentType: T`.
      output: Output.object({ schema: entry.fieldsSchema as unknown as ZodType<RegistryFieldsOf<T>> }),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: entry.promptBuilder() },
            { type: 'file', mediaType: file.type, data: buffer, filename: file.name },
          ],
        },
      ],
    })

    // Normalização + dígito verificador no código (o modelo não conta dígitos
    // de forma confiável) — valor que não confere vira confiança "low".
    const fields = output as RegistryFieldsOf<T>
    // Mesmo narrow do schema acima: a entrada foi indexada pelo próprio `documentType`.
    const postProcess = 'postProcess' in entry
      ? (entry.postProcess as unknown as (f: RegistryFieldsOf<T>) => RegistryFieldsOf<T>)
      : null
    return summarize(documentType, postProcess ? postProcess(fields) : fields)
  } catch (err) {
    // Metadado operacional, nunca conteúdo do documento/valores extraídos (§7.1).
    console.error('[extractFields] provider_call_failed', {
      documentType,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
