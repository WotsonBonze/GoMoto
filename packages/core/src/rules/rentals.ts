/**
 * @file rules/rentals.ts
 * @description Regras de negócio puras para locações (rentals).
 * Nada aqui pode importar Supabase, React ou UI.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const CONTRACT_TERMINATION_FINE_BRL = 1000

export const RENTAL_MINIMUM_DURATION = {
  rental:      { months: 3 },
  rent_to_own: { years: 2 },
} as const

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type RentalType    = 'rental' | 'rent_to_own'
export type RentalStatus  = 'active' | 'closed' | 'transferred'
export type RentalCycle   = 'weekly' | 'monthly'
export type BillingType   = 'cycle' | 'one_time' | 'complementary' | 'fine'
export type PaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card' | 'bank_transfer' | 'other'

export type RentalValidityLevel = 'red' | 'orange' | 'green'

export interface RentalValidityInput {
  status:         string
  start_date:     string
  end_date?:      string | null
  contract_type?: RentalType | null
}

// ---------------------------------------------------------------------------
// Exibição — ciclo e dia de vencimento
// ---------------------------------------------------------------------------

export const WEEK_DAY_OPTIONS = [
  { value: '7', label: 'Domingo' },
  { value: '1', label: 'Segunda-feira' },
  { value: '2', label: 'Terça-feira' },
  { value: '3', label: 'Quarta-feira' },
  { value: '4', label: 'Quinta-feira' },
  { value: '5', label: 'Sexta-feira' },
  { value: '6', label: 'Sábado' },
]

/** Rótulo de exibição do dia de vencimento — "Dia N" (mensal) ou nome do dia da semana (semanal). */
export function formatDueDay(cycle: RentalCycle, dueDay: string): string {
  if (cycle === 'monthly') return `Dia ${dueDay}`
  return WEEK_DAY_OPTIONS.find(o => o.value === dueDay)?.label ?? dueDay
}

// ---------------------------------------------------------------------------
// Utilitários de data
// ---------------------------------------------------------------------------

/**
 * Adiciona meses preservando o dia (usa setMonth — pode rolar para o próximo
 * mês quando o dia não existe; comportamento aceito pelo produto).
 */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}

export function addYears(date: Date, years: number): Date {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}

/** Converte string ISO YYYY-MM-DD em Date local sem deslocamento de fuso. */
export function parseIsoDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00`)
}

/**
 * A string é uma data ISO que o `Date` nativo consegue representar?
 *
 * Existe porque `parseIsoDate` devolve Invalid Date em silêncio, e comparação
 * com NaN é sempre falsa: o `if (end <= start) return []` de
 * `generateCycleCharges` não barrava nada, e o cronograma saía com
 * `due_date: "NaN-NaN-NaN"`.
 *
 * O caminho até lá é trivial. `<input type="date">` aceita ano de cinco dígitos
 * — basta o operador digitar no segmento do ano com algo já preenchido —, e
 * `new Date("82026-12-16T00:00:00")` é inválida porque ISO só admite quatro
 * dígitos (ou a forma estendida com sinal). Digitando a data de início eu
 * produzi esse estado por acidente, que é exatamente como um operador o produz.
 */
export function isParseableIsoDate(isoDate: string | null | undefined): boolean {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false

  const d = parseIsoDate(isoDate)
  if (Number.isNaN(d.getTime())) return false

  // Dia que não existe no calendário é ACEITO pelo `Date` e rolado para o mês
  // seguinte: "2026-02-30" vira 2 de março sem aviso. Conferir os componentes
  // de volta é o que separa "data válida" de "data que o JS transformou em
  // outra". Chega por payload de API, não pelo input nativo.
  const [y, m, day] = isoDate.split('-').map(Number)
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day
}

// ---------------------------------------------------------------------------
// Vigência de locações
// ---------------------------------------------------------------------------

/**
 * Dois períodos de locação se cruzam? (ADR 0036)
 *
 * Mesma semântica do trigger `trg_rentals_vehicle_period`, que é quem vale —
 * esta existe para a prévia avisar antes do clique. Período é `[início, fim)`:
 * devolver e retirar a moto no MESMO dia não é sobreposição. Fim nulo é
 * contrato em aberto, que ocupa tudo dali em diante. Fim anterior ao início
 * (locação encerrada antes de começar) é período vazio, que não ocupa nada.
 */
export function rentalPeriodsOverlap(
  aStart: string, aEnd: string | null,
  bStart: string, bEnd: string | null,
): boolean {
  const aUpper = aEnd === null ? null : (aEnd > aStart ? aEnd : aStart)
  const bUpper = bEnd === null ? null : (bEnd > bStart ? bEnd : bStart)
  if (aUpper === aStart || bUpper === bStart) return false
  return (bUpper === null || aStart < bUpper) && (aUpper === null || bStart < aUpper)
}

/** Data mínima de encerramento sem multa para o tipo de locação. */
export function calculateMinimumEndDate(
  startDate: string,
  rentalType: RentalType = 'rental',
): Date {
  const start = parseIsoDate(startDate)
  if (rentalType === 'rent_to_own') {
    return addYears(start, RENTAL_MINIMUM_DURATION.rent_to_own.years)
  }
  return addMonths(start, RENTAL_MINIMUM_DURATION.rental.months)
}

/** Alias explícito de calculateMinimumEndDate. */
export const calculateMinimumEndDateForRental = calculateMinimumEndDate

/**
 * Data esperada de término:
 * - rent_to_own: sempre start + 2 anos (ignora end_date)
 * - rental:      usa end_date informado, ou null se ausente
 */
export function calculateExpectedEndDate(input: RentalValidityInput): Date | null {
  const type: RentalType = input.contract_type ?? 'rental'
  if (type === 'rent_to_own') {
    return addYears(parseIsoDate(input.start_date), RENTAL_MINIMUM_DURATION.rent_to_own.years)
  }
  return input.end_date ? parseIsoDate(input.end_date) : null
}

/**
 * Classifica a vigência de uma locação ativa em três níveis:
 * - 'red'    → passou da data de encerramento prevista
 * - 'orange' → dentro da vigência mínima (rescisão gera multa)
 * - 'green'  → vigência mínima cumprida
 *
 * Retorna null quando a locação não está ativa.
 */
export function getRentalValidityLevel(
  input: RentalValidityInput,
  today: Date = new Date(),
): RentalValidityLevel | null {
  if (input.status !== 'active') return null

  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)

  const minEnd      = calculateMinimumEndDate(input.start_date, input.contract_type ?? 'rental')
  const contractEnd = input.end_date ? parseIsoDate(input.end_date) : null

  if (contractEnd && todayMidnight > contractEnd) return 'red'
  if (todayMidnight < minEnd) return 'orange'
  return 'green'
}

/** true se o encerramento hoje ocorre dentro da vigência mínima (multa aplicável). */
export function isTerminationWithinMinimum(
  input: Pick<RentalValidityInput, 'start_date' | 'contract_type'>,
  today: Date = new Date(),
): boolean {
  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)
  const minEnd = calculateMinimumEndDate(input.start_date, input.contract_type ?? 'rental')
  return todayMidnight < minEnd
}

/** Versão com nomenclatura de campo explícita (rental_type) usada nas actions. */
export function isRentalTerminationWithinMinimum(
  input: { start_date: string; rental_type?: RentalType },
  today: Date = new Date(),
): boolean {
  return isTerminationWithinMinimum(
    { start_date: input.start_date, contract_type: input.rental_type },
    today,
  )
}

// ---------------------------------------------------------------------------
// CycleCharge: output da geração de cobranças
// ---------------------------------------------------------------------------

export interface CycleCharge {
  due_date:     string
  amount:       number
  billing_type: BillingType
  description:  string
  /**
   * Início e fim do período coberto. Já eram calculados para montar a
   * descrição; expostos para alimentar `rental_billing_schedules`
   * (Spec 0014) sem duplicar a lógica de pro rata.
   */
  period_start: string
  period_end:   string
}

export interface CycleChargeInput {
  start_date:   string       // ISO YYYY-MM-DD
  end_date:     string       // ISO YYYY-MM-DD
  cycle:        RentalCycle
  due_day:      number       // 1-7 para weekly (1=seg); 1-28 para monthly
  cycle_amount: number
  use_pro_rata: boolean
}

// ---------------------------------------------------------------------------
// Helpers internos (não exportados)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'] as const

function fmtDay(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

function makeCycleDescription(
  cycle: RentalCycle,
  periodStart: Date,
  periodEnd: Date,
  amount: number,
  cycleAmount: number,
): string {
  const isProRata = Math.abs(amount - cycleAmount) > 0.01
  if (cycle === 'weekly') {
    const prefix = isProRata ? 'Aluguel proporcional' : 'Aluguel semanal'
    return `${prefix} — ${fmtDay(periodStart)} a ${fmtDay(periodEnd)}`
  }
  const mon    = MONTHS_PT[periodEnd.getMonth()]!
  const year   = periodEnd.getFullYear()
  const prefix = isProRata ? 'Aluguel proporcional' : 'Aluguel mensal'
  return `${prefix} — ${mon}/${year}`
}

function dateDiffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

function formatIsoDate(date: Date): string {
  // O ano também precisa de padding: sem ele, 26 d.C. virava "26-09-10" — que
  // não é ISO e o Postgres interpreta como outro ano.
  const y = String(date.getFullYear()).padStart(4, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Primeira data >= start com o due_day informado. */
function firstDueDate(start: Date, cycle: RentalCycle, dueDay: number): Date {
  if (cycle === 'weekly') {
    const dueDayJS  = dueDay === 7 ? 0 : dueDay
    const startDayJS = start.getDay()
    const daysUntil = (dueDayJS - startDayJS + 7) % 7
    const d = new Date(start)
    d.setDate(d.getDate() + daysUntil)
    return d
  }
  const d = new Date(start)
  if (start.getDate() <= dueDay) {
    d.setDate(dueDay)
  } else {
    d.setMonth(d.getMonth() + 1)
    d.setDate(dueDay)
  }
  return d
}

/** Próximo vencimento regular após current. */
function nextDueDate(current: Date, cycle: RentalCycle, dueDay: number): Date {
  if (cycle === 'weekly') {
    const d = new Date(current)
    d.setDate(d.getDate() + 7)
    return d
  }
  const d = new Date(current)
  d.setMonth(d.getMonth() + 1)
  d.setDate(dueDay)
  return d
}

/** Duração do ciclo em dias a partir de fromDate. */
function cycleLengthDays(cycle: RentalCycle, fromDate: Date, dueDay: number): number {
  if (cycle === 'weekly') return 7
  return dateDiffDays(fromDate, nextDueDate(fromDate, 'monthly', dueDay))
}

// ---------------------------------------------------------------------------
// calculateProRataValue
// ---------------------------------------------------------------------------

/** Calcula o valor pro rata com arredondamento de 2 casas decimais (RN-012). */
export function calculateProRataValue(
  amount: number,
  days: number,
  cycleDays: number,
): number {
  return Math.round((days / cycleDays) * amount * 100) / 100
}

// ---------------------------------------------------------------------------
// generateCycleCharges
// ---------------------------------------------------------------------------

/**
 * Gera o array de cobranças de ciclo a partir dos parâmetros da locação.
 *
 * Regras:
 * - Se use_pro_rata = false: todas pelo valor integral (RN-011)
 * - Primeira cobrança: pro rata se início != vencimento (RN-008)
 * - Última cobrança: pro rata se fim != vencimento (RN-009)
 * - Intermediárias: sempre valor integral (RN-010)
 */
export function generateCycleCharges(input: CycleChargeInput): CycleCharge[] {
  const charges: CycleCharge[] = []

  // Data impossível não gera cronograma. Sem esta guarda a função devolvia
  // linhas com `due_date: "NaN-NaN-NaN"` — e como ela RETORNA lixo em vez de
  // lançar, o `try/catch` de quem chama não protegia. Na tela isso derrubava a
  // página inteira ao formatar a data; na gravação iria como data inválida para
  // uma coluna `date`.
  if (!isParseableIsoDate(input.start_date) || !isParseableIsoDate(input.end_date)) {
    return charges
  }

  const start = parseIsoDate(input.start_date)
  const end   = parseIsoDate(input.end_date)

  if (end <= start) return charges

  const first = firstDueDate(start, input.cycle, input.due_day)

  const dueDates: Date[] = []
  let cur = first
  while (cur.getTime() <= end.getTime()) {
    dueDates.push(new Date(cur))
    cur = nextDueDate(cur, input.cycle, input.due_day)
  }

  if (dueDates.length === 0) {
    const cycleDays = cycleLengthDays(input.cycle, first, input.due_day)
    const days      = dateDiffDays(start, end)
    const amount    = input.use_pro_rata
      ? calculateProRataValue(input.cycle_amount, days, cycleDays)
      : input.cycle_amount
    charges.push({
      due_date:     formatIsoDate(first),
      amount,
      billing_type: 'cycle',
      description:  makeCycleDescription(input.cycle, start, end, amount, input.cycle_amount),
      period_start: formatIsoDate(start),
      period_end:   formatIsoDate(end),
    })
    return charges
  }

  // Sem pro rata, cobra-se um ciclo cheio por vencimento e as pontas são
  // ignoradas (RN-011) — é a semântica de "mensalidade", não de diária.
  if (!input.use_pro_rata) {
    for (let i = 0; i < dueDates.length; i++) {
      const due = dueDates[i]!
      const periodStart = i === 0 ? start : dueDates[i - 1]!

      // Período de duração zero não é ciclo, é artefato.
      //
      // Quando o contrato começa NO próprio dia de vencimento, `firstDueDate`
      // devolve a data de início, e a primeira volta do laço montava
      // `periodStart === periodEnd` cobrando o ciclo cheio. Um contrato mensal
      // de 10/10 a 10/03 com vencimento dia 10 saía com 6 cobranças de R$ 600
      // em vez de 5 — R$ 600 a mais, num arranjo trivial ("vence todo dia 10,
      // começou dia 10"). O ramo com pro rata nunca teve o defeito: lá as
      // fronteiras já descartam o vencimento que coincide com o início.
      if (due.getTime() <= periodStart.getTime()) continue

      charges.push({
        due_date:     formatIsoDate(due),
        amount:       input.cycle_amount,
        billing_type: 'cycle',
        description:  makeCycleDescription(input.cycle, periodStart, due, input.cycle_amount, input.cycle_amount),
        period_start: formatIsoDate(periodStart),
        period_end:   formatIsoDate(due),
      })
    }
    return charges
  }

  /**
   * Com pro rata, a unidade é o PERÍODO, não o vencimento.
   *
   * Antes o laço emitia uma cobrança por vencimento e, quando havia ponta no
   * início E no fim, os períodos eram um a mais que os vencimentos: a última
   * cobrança recebia o valor da ponta final e o ciclo cheio que ela deveria
   * representar sumia. Uma locação de 01/09 a 01/12 a R$600 (vencimento dia 10)
   * saía com 3 cobranças somando R$1.200 em vez de 4 somando R$1.800 — um mês
   * inteiro não faturado, sempre que o contrato começa fora do dia de
   * vencimento.
   *
   * As fronteiras são início, vencimentos internos e fim; cada intervalo entre
   * duas fronteiras é uma cobrança, vencendo no fim do próprio período.
   */
  const boundaries: Date[] = [start]
  for (const due of dueDates) {
    if (due.getTime() > start.getTime()) boundaries.push(due)
  }
  const lastBoundary = boundaries[boundaries.length - 1]!
  if (end.getTime() > lastBoundary.getTime()) boundaries.push(end)

  const isDueDate = (d: Date) => dueDates.some((due) => due.getTime() === d.getTime())

  for (let i = 0; i < boundaries.length - 1; i++) {
    const periodStart = boundaries[i]!
    const periodEnd   = boundaries[i + 1]!

    // Período delimitado por dois vencimentos é ciclo cheio (RN-010). Qualquer
    // outro é ponta, e a fração usa como referência o ciclo que a contém.
    const isFullCycle = isDueDate(periodStart) && isDueDate(periodEnd)

    const amount = isFullCycle
      ? input.cycle_amount
      : calculateProRataValue(
          input.cycle_amount,
          dateDiffDays(periodStart, periodEnd),
          isDueDate(periodStart)
            // Ponta final: o ciclo de referência é o que começaria no último
            // vencimento e seguiria até o próximo.
            ? cycleLengthDays(input.cycle, periodStart, input.due_day)
            // Ponta inicial: o ciclo de referência é o que termina no primeiro
            // vencimento (RN-008).
            : cycleLengthDays(input.cycle, periodEnd, input.due_day),
        )

    charges.push({
      due_date:     formatIsoDate(periodEnd),
      amount,
      billing_type: 'cycle',
      description:  makeCycleDescription(input.cycle, periodStart, periodEnd, amount, input.cycle_amount),
      period_start: formatIsoDate(periodStart),
      period_end:   formatIsoDate(periodEnd),
    })
  }

  return charges
}

// ---------------------------------------------------------------------------
// isRentalTerminationWithinMinimum (versão rent_to_own-aware)
// ---------------------------------------------------------------------------
// (já definida acima junto com as outras funções de vigência)

// ---------------------------------------------------------------------------
// EarlyTerminationImpact
// ---------------------------------------------------------------------------

export interface EarlyTerminationImpact {
  /** Cobranças pendentes com due_date < today (permanecerão abertas). */
  overdue_count: number
  /** Cobranças pendentes com due_date >= today (serão canceladas). */
  future_count: number
  /** Encerramento dentro da vigência mínima (multa aplicável). */
  within_minimum: boolean
  /** Valor da multa (R$ 1.000 se within_minimum, 0 caso contrário). */
  fine_amount: number
}

/**
 * Calcula o impacto do encerramento antecipado de uma locação.
 * Usado pelo UI antes da confirmação (RF-037, RF-039).
 */
export function getEarlyTerminationImpact(
  charges: Array<{ due_date: string; status: string }>,
  today: Date,
  startDate: string,
  rentalType: RentalType = 'rental',
): EarlyTerminationImpact {
  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)

  const pendingCharges = charges.filter(c => c.status === 'pending' || c.status === 'overdue')

  const overdue_count = pendingCharges.filter(
    c => parseIsoDate(c.due_date).getTime() < todayMidnight.getTime(),
  ).length

  const future_count = pendingCharges.filter(
    c => parseIsoDate(c.due_date).getTime() >= todayMidnight.getTime(),
  ).length

  const within_minimum = isRentalTerminationWithinMinimum(
    { start_date: startDate, rental_type: rentalType },
    today,
  )

  return {
    overdue_count,
    future_count,
    within_minimum,
    fine_amount: within_minimum ? CONTRACT_TERMINATION_FINE_BRL : 0,
  }
}

// ---------------------------------------------------------------------------
// Reajuste de locação (RF-027–031, PRD 0008 F11)
// ---------------------------------------------------------------------------

/**
 * @deprecated Desde a ADR 0024 o reajuste não reescreve documento emitido: ele
 * altera linhas `scheduled` do cronograma, que já carregam o valor do ciclo.
 * Sem chamadores desde a Spec 0014.
 *
 * Recalcula o valor de uma cobrança pendente ao reajustar o ciclo (RN-027).
 * Cobranças de valor cheio escalam 1:1; cobranças pro rata mantêm a mesma
 * fração do novo valor (ex.: 60% do ciclo antigo vira 60% do ciclo novo).
 */
export function calculateAdjustedBillingAmount(
  currentAmount: number,
  previousCycleAmount: number,
  newCycleAmount: number,
): number {
  if (previousCycleAmount <= 0) return newCycleAmount
  const ratio = currentAmount / previousCycleAmount
  return Math.round(ratio * newCycleAmount * 100) / 100
}

export interface RentalAdjustmentPreview {
  affected_count: number
  total_previous: number
  total_new: number
}

/**
 * Prévia de impacto de um reajuste antes da confirmação (RF-029).
 * Recebe apenas as cobranças de ciclo com status pendente — pagas e
 * vencidas nunca são afetadas (RN-026) e não entram nesta prévia.
 */
export function previewRentalAdjustment(
  pendingCycleBillings: ReadonlyArray<{ original_amount: number }>,
  previousCycleAmount: number,
  newCycleAmount: number,
): RentalAdjustmentPreview {
  let total_previous = 0
  let total_new = 0
  for (const b of pendingCycleBillings) {
    total_previous += b.original_amount
    total_new += calculateAdjustedBillingAmount(b.original_amount, previousCycleAmount, newCycleAmount)
  }
  return { affected_count: pendingCycleBillings.length, total_previous, total_new }
}

// ---------------------------------------------------------------------------
// Mudança de ciclo/dia de vencimento/pro rata — cancela pendentes + regera
// ---------------------------------------------------------------------------

/**
 * @deprecated Desde a ADR 0035, quem decide o corte é `planPeriodAdjustment`
 * (`rules/schedule.ts`), que trabalha sobre `rental_billing_schedules` e sobre
 * as cobranças emitidas. Esta versão fala a linguagem de `billings`, tabela que
 * a Spec 0014 derrubou — nenhum chamador restou.
 *
 * Ponto de corte para regenerar o cronograma: a due_date mais recente entre
 * as cobranças "travadas" (pagas, canceladas, prejuízo, ou pendentes cuja
 * due_date já passou — vencida na prática, mesmo com status='pending' no
 * banco, já que overdue nunca é persistido). Cobranças pendentes com
 * due_date >= hoje ficam livres para cancelar e regerar.
 *
 * Diferente do pivot usado por renewRental (sempre a última cobrança de
 * todas, pensado só pra estender o fim): aqui pode haver cobranças
 * pendentes futuras além do corte, que serão canceladas — não apenas
 * extensão para frente.
 *
 * Retorna null se não houver nenhuma cobrança travada (regera o
 * cronograma inteiro a partir do início do contrato).
 */
export function computeScheduleRegenerationCutoff(
  billings: ReadonlyArray<{ due_date: string; status: string }>,
  today: Date,
): string | null {
  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)

  let cutoff: string | null = null
  for (const b of billings) {
    const isLocked = b.status !== 'pending' || parseIsoDate(b.due_date).getTime() < todayMidnight.getTime()
    if (!isLocked) continue
    if (!cutoff || b.due_date > cutoff) cutoff = b.due_date
  }
  return cutoff
}

export interface ScheduleRegenerationPreview {
  cancelled_count: number
  discount_lost_total: number
  credit_to_restore_total: number
  new_charges_count: number
  new_charges_total: number
}

/**
 * Prévia de impacto antes de confirmar uma mudança de ciclo/dia/pro-rata:
 * quantas cobranças serão canceladas, quanto de desconto se perde (some
 * junto com a cobrança cancelada) e quanto de crédito volta a ficar
 * disponível para o cliente (estornado, nunca perdido).
 */
export function previewScheduleRegeneration(
  cancelledBillings: ReadonlyArray<{ discount_amount?: number | null; credit_applied?: number | null }>,
  newCharges: ReadonlyArray<{ amount: number }>,
): ScheduleRegenerationPreview {
  const discount_lost_total = cancelledBillings.reduce((s, b) => s + (b.discount_amount ?? 0), 0)
  const credit_to_restore_total = cancelledBillings.reduce((s, b) => s + (b.credit_applied ?? 0), 0)
  const new_charges_total = newCharges.reduce((s, c) => s + c.amount, 0)
  return {
    cancelled_count: cancelledBillings.length,
    discount_lost_total,
    credit_to_restore_total,
    new_charges_count: newCharges.length,
    new_charges_total,
  }
}
