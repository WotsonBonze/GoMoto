import { validateCpfDigits } from '../identity/index'
import type { CnhFields } from './registry'
import type { ExtractionField } from './types'

/**
 * Categorias que podem aparecer no campo "9 CAT HAB" da CNH brasileira, mais
 * ACC (Autorização para Conduzir Ciclomotor), que a CNH imprime numa caixa
 * própria e que pode ser a única habilitação do condutor.
 *
 * A tabela do verso da CNH modelo 2022 (A1, B1, C1, D1, BE, CE, C1E, DE, D1E)
 * é a equivalência internacional/Mercosul — nunca é a categoria do condutor
 * e por isso não entra aqui.
 */
export const CNH_CATEGORIES = ['ACC', 'A', 'B', 'AB', 'C', 'AC', 'D', 'AD', 'E', 'AE'] as const
export type CnhCategory = (typeof CNH_CATEGORIES)[number]

/**
 * Dígitos verificadores do Nº de Registro da CNH (11 dígitos: 9 base + 2 DV).
 * Algoritmo do DENATRAN, com a normalização do 2º DV usada pelos validadores
 * de mercado (resto negativo volta para a faixa 0–9).
 */
export function validateCnhRegistro(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false
  if (/^(\d)\1{10}$/.test(digits)) return false

  const base = digits.slice(0, 9).split('').map(Number)
  let discount = 0

  let dv1 = base.reduce((acc, d, i) => acc + d * (9 - i), 0) % 11
  if (dv1 >= 10) {
    dv1 = 0
    discount = 2
  }

  const rem = base.reduce((acc, d, i) => acc + d * (i + 1), 0) % 11
  let dv2 = rem >= 10 ? 0 : rem - discount
  if (dv2 < 0) dv2 += 11
  if (dv2 >= 10) dv2 = 0

  return `${dv1}${dv2}` === digits.slice(9)
}

/**
 * Tira o órgão emissor e a UF do campo "DOC. IDENTIDADE / ÓRG. EMISSOR / UF"
 * quando a IA devolve o campo inteiro ("254954811 DETRAN RJ" → "254954811").
 * Corta no primeiro token só de letras que aparece depois de um token com
 * dígito — prefixo de UF colado ao número ("MG-12.345.678") é preservado.
 */
export function stripRgIssuer(raw: string): string {
  const tokens = raw.replace(/[/|]/g, ' ').trim().split(/\s+/)
  const kept: string[] = []
  let sawDigit = false
  for (const token of tokens) {
    if (sawDigit && /^[A-Za-zÀ-ú.\-]+$/.test(token)) break
    kept.push(token)
    if (/\d/.test(token)) sawDigit = true
  }
  return kept.join(' ').replace(/[\s.\-]+$/, '')
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function yearsBetween(fromIso: string, to: Date): number {
  const from = new Date(`${fromIso}T00:00:00Z`)
  return (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
}

function low<T>(field: ExtractionField<T>): ExtractionField<T> {
  return { ...field, confidence: 'low' }
}

/**
 * Pós-processamento determinístico da extração de CNH (Spec 0012 §11.2).
 *
 * O modelo não conta dígitos de forma confiável e confunde números parecidos
 * do documento (Nº Registro × Nº Espelho × código de segurança; CPF × Registro).
 * Aqui o código normaliza o formato e confere o que é verificável — CPF e
 * Registro têm dígito verificador. Um valor que não passa NÃO é descartado:
 * vira confiança "low", e o formulário mostra o selo "Confira" para o operador
 * (RN-002 — sinalização, nunca trava).
 */
export function postProcessCnhFields(fields: CnhFields, today: Date = new Date()): CnhFields {
  const out: CnhFields = { ...fields }

  if (out.name.value !== null) {
    const name = out.name.value.replace(/\s+/g, ' ').trim()
    out.name = { ...out.name, value: name || null }
  }

  if (out.cpf.value !== null) {
    const digits = out.cpf.value.replace(/\D+/g, '')
    out.cpf = { ...out.cpf, value: digits || null }
    if (!validateCpfDigits(digits)) out.cpf = low(out.cpf)
  }

  if (out.rg.value !== null) {
    const rg = stripRgIssuer(out.rg.value)
    out.rg = { ...out.rg, value: rg || null }
  }

  if (out.drivers_license.value !== null) {
    const digits = out.drivers_license.value.replace(/\D+/g, '')
    out.drivers_license = { ...out.drivers_license, value: digits || null }
    if (!validateCnhRegistro(digits)) out.drivers_license = low(out.drivers_license)
  }

  // CPF e Registro têm 11 dígitos e ficam lado a lado na CNH 2022 — o mesmo
  // número nos dois campos é sinal de que um deles foi lido no lugar errado.
  if (out.cpf.value !== null && out.cpf.value === out.drivers_license.value) {
    out.cpf = low(out.cpf)
    out.drivers_license = low(out.drivers_license)
  }

  // O campo do formulário é <input type="date"> — só aceita ISO. A CNH imprime
  // DD/MM/AAAA; se o modelo devolver nesse formato, converte em vez de perder.
  for (const key of ['birth_date', 'drivers_license_validity'] as const) {
    const field = out[key]
    if (field.value === null) continue
    const br = field.value.trim().match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/)
    const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : field.value.trim()
    out[key] = isIsoDate(iso) ? { ...field, value: iso } : { value: null, confidence: 'low' }
  }

  // Data de nascimento de quem tem CNH: entre 18 e 100 anos atrás.
  if (out.birth_date.value !== null) {
    const age = yearsBetween(out.birth_date.value, today)
    if (age < 18 || age > 100) out.birth_date = low(out.birth_date)
  }

  // Validade anterior ao nascimento é troca de campo (ex.: leu a 1ª habilitação).
  if (
    out.birth_date.value !== null &&
    out.drivers_license_validity.value !== null &&
    out.drivers_license_validity.value <= out.birth_date.value
  ) {
    out.birth_date = low(out.birth_date)
    out.drivers_license_validity = low(out.drivers_license_validity)
  }

  return out
}
