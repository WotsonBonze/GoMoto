/**
 * Distribuição dirigida de caução e crédito no encerramento (Spec 0017).
 *
 * O operador informa, dívida a dívida, quanto de caução e quanto de crédito
 * aplicar. Esta função só SOMA e COMPARA, para a tela mostrar o que já foi
 * alocado e o que resta sem ir ao servidor a cada dígito — não decide nada e
 * não é a fonte de verdade: quem recusa de fato é `terminate_rental`, que relê
 * saldo e dívida sob trava a cada alocação.
 *
 * Contas em CENTAVOS inteiros: somar reais em ponto flutuante faz
 * `0.1 + 0.2 > 0.3` e a tela recusaria uma distribuição exata.
 */

/** Id da linha virtual da multa: ela só ganha `charge_id` dentro da RPC. */
export const FINE_DEBT_ID = 'fine'

export type DistributionDebt = {
  /** `charge_id` real, ou `FINE_DEBT_ID` para a multa ainda não emitida. */
  id: string
  /** Quanto ainda é devido nesta dívida. */
  amount_due: number
}

export type DistributionInput = {
  debts: DistributionDebt[]
  deposit_balance: number
  credit_balance: number
  /** id da dívida → valor de caução alocado. Ausente = 0. */
  deposit_allocations: Record<string, number>
  /** id da dívida → valor de crédito alocado. Ausente = 0. */
  credit_allocations: Record<string, number>
}

export type DistributionLine = {
  id: string
  amount_due: number
  deposit: number
  credit: number
  /** O que ainda é devido depois das duas alocações (nunca negativo). */
  remaining: number
  /** Teto que ainda cabe de caução NESTA linha, dado tudo o mais que já foi alocado. */
  max_deposit: number
  /** Idem para crédito. */
  max_credit: number
}

export type DistributionViolation =
  /** RN-001: caução + crédito na mesma dívida passam do que ela deve. */
  | { code: 'LINE_EXCEEDS_DEBT'; id: string; excess: number }
  /** RN-002: soma das alocações de caução passa do saldo de caução. */
  | { code: 'DEPOSIT_EXCEEDS_BALANCE'; excess: number }
  /** RN-003: soma das alocações de crédito passa do saldo de crédito. */
  | { code: 'CREDIT_EXCEEDS_BALANCE'; excess: number }

export type DistributionResult = {
  lines: DistributionLine[]
  debt_total: number
  debt_remaining: number
  deposit_allocated: number
  deposit_remaining: number
  credit_allocated: number
  credit_remaining: number
  violations: DistributionViolation[]
  is_valid: boolean
}

const toCents = (n: number): number => Math.round(n * 100)
const fromCents = (c: number): number => c / 100

/** Valor digitado → centavos; negativo, NaN ou infinito viram 0. */
function sanitizeCents(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return 0
  return toCents(n)
}

export function computeDebtDistribution(input: DistributionInput): DistributionResult {
  const depositBalance = Math.max(0, toCents(input.deposit_balance))
  const creditBalance = Math.max(0, toCents(input.credit_balance))

  // Só entram no cálculo as dívidas da lista — alocação para id desconhecido
  // (ex.: linha que sumiu quando a data de encerramento mudou) é ignorada em
  // vez de inflar o total.
  const rows = input.debts.map((d) => ({
    id: d.id,
    due: Math.max(0, toCents(d.amount_due)),
    deposit: sanitizeCents(input.deposit_allocations[d.id]),
    credit: sanitizeCents(input.credit_allocations[d.id]),
  }))

  const depositTotal = rows.reduce((s, r) => s + r.deposit, 0)
  const creditTotal = rows.reduce((s, r) => s + r.credit, 0)

  const violations: DistributionViolation[] = []

  const lines: DistributionLine[] = rows.map((r) => {
    const used = r.deposit + r.credit
    if (used > r.due) {
      violations.push({ code: 'LINE_EXCEEDS_DEBT', id: r.id, excess: fromCents(used - r.due) })
    }

    // O teto de uma linha desconta o que as OUTRAS já consumiram do saldo e o
    // que a outra fonte já cobriu nesta mesma dívida — o input da tela usa isso
    // como `max`, e recalcula a cada dígito.
    const depositLeftInBalance = depositBalance - (depositTotal - r.deposit)
    const creditLeftInBalance = creditBalance - (creditTotal - r.credit)

    return {
      id: r.id,
      amount_due: fromCents(r.due),
      deposit: fromCents(r.deposit),
      credit: fromCents(r.credit),
      remaining: fromCents(Math.max(0, r.due - used)),
      max_deposit: fromCents(Math.max(0, Math.min(r.due - r.credit, depositLeftInBalance))),
      max_credit: fromCents(Math.max(0, Math.min(r.due - r.deposit, creditLeftInBalance))),
    }
  })

  if (depositTotal > depositBalance) {
    violations.push({ code: 'DEPOSIT_EXCEEDS_BALANCE', excess: fromCents(depositTotal - depositBalance) })
  }
  if (creditTotal > creditBalance) {
    violations.push({ code: 'CREDIT_EXCEEDS_BALANCE', excess: fromCents(creditTotal - creditBalance) })
  }

  const debtTotal = rows.reduce((s, r) => s + r.due, 0)

  return {
    lines,
    debt_total: fromCents(debtTotal),
    debt_remaining: fromCents(lines.reduce((s, l) => s + toCents(l.remaining), 0)),
    deposit_allocated: fromCents(depositTotal),
    deposit_remaining: fromCents(Math.max(0, depositBalance - depositTotal)),
    credit_allocated: fromCents(creditTotal),
    credit_remaining: fromCents(Math.max(0, creditBalance - creditTotal)),
    violations,
    is_valid: violations.length === 0,
  }
}

/** Valor de dinheiro → texto que um `<input type="number">` aceita ("300.00"). */
export function formatAllocationInput(n: number): string {
  return n.toFixed(2)
}

/**
 * Impede que o operador digite mais do que cabe.
 *
 * Recebe o texto do input e o teto da linha (`max_credit` de
 * `computeDebtDistribution`, que já desconta o saldo que as OUTRAS linhas
 * consumiram e o que a caução cobriu nesta dívida). Passou do teto → volta o
 * próprio teto; sem teto nenhum (≤ 0) → o campo fica vazio, porque não há o que
 * aplicar.
 *
 * Só corta o que é NÚMERO e passa do teto. Digitação em andamento ("", "12,",
 * "-") volta intacta: o `max` do input não trava o teclado, e cortar no meio da
 * digitação faria o campo brigar com quem digita. Comparação em centavos, para
 * `0.1 + 0.2` não parecer maior que `0.3`.
 */
export function clampAllocationInput(raw: string, max: number): string {
  if (raw.trim() === '') return raw

  const n = Number(raw.replace(',', '.'))
  if (!Number.isFinite(n)) return raw

  if (toCents(n) <= toCents(max)) return raw
  return max > 0 ? formatAllocationInput(max) : ''
}

export type TerminationAllocations = {
  deposit_allocations: { charge_id: string; amount: number }[]
  credit_allocations: { charge_id: string; amount: number }[]
  fine_deposit_amount: number
  fine_credit_amount: number
}

/**
 * Traduz a distribuição da tela para o payload de `terminateRental`.
 *
 * A multa é uma linha como as outras na tela, mas o `charge_id` dela só existe
 * depois que a RPC a cria — por isso os valores dela seguem nos dois campos
 * escalares da Spec 0015, e só as dívidas REAIS vão nos arrays. Só vai quem tem
 * valor > 0: a RPC recusa alocação de zero.
 */
export function buildTerminationAllocations(result: DistributionResult): TerminationAllocations {
  const real = result.lines.filter((l) => l.id !== FINE_DEBT_ID)
  const fine = result.lines.find((l) => l.id === FINE_DEBT_ID)

  return {
    deposit_allocations: real
      .filter((l) => l.deposit > 0)
      .map((l) => ({ charge_id: l.id, amount: l.deposit })),
    credit_allocations: real
      .filter((l) => l.credit > 0)
      .map((l) => ({ charge_id: l.id, amount: l.credit })),
    fine_deposit_amount: fine?.deposit ?? 0,
    fine_credit_amount: fine?.credit ?? 0,
  }
}
