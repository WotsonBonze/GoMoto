/**
 * Alocação de pagamento e aplicação de crédito.
 *
 * Spec 0014 / ADR 0024. Substitui `fn_auto_apply_credit`, que aplicava um único
 * crédito (`LIMIT 1`), sobrescrevia o acumulado em vez de somar e engolia
 * qualquer falha com `EXCEPTION WHEN OTHERS` — perdendo dinheiro em silêncio
 * (F-06).
 *
 * Regras de ordenação (R-09): abate-se sempre a cobrança de VENCIMENTO MAIS
 * ANTIGO, não a recém-criada. Crédito expirado é ignorado.
 */

// ============================================================
// Tipos
// ============================================================

export type LateChargePolicy = {
  /** 'fixed': valor em reais. 'percentage': fração (0.02 = 2%). */
  fee_type: 'fixed' | 'percentage'
  fee_value: number
  daily_interest_rate: number
  grace_period_days: number
  min_amount: number
}

export type AccruedCharges = {
  grace_period_active: boolean
  fee: number
  interest: number
  total: number
  days_since_due: number
  days_overdue: number
}

/** Linha de `charge_balances`. */
export type ChargeBalance = {
  charge_id: string
  due_date: string
  total_amount: number
  paid_amount: number
  open_amount: number
  /**
   * Quanto do total já virou encargo por atraso (itens com
   * `source_module = 'late_charge'`), pago ou não. Encargo realizado é PARCELA
   * do encargo corrente, não dívida nova — ver `calculateAmountDue` e a
   * ADR 0028.
   */
  late_charge_amount: number
  /**
   * `charge_status` da ADR 0024. União inline de propósito: o `ChargeStatus`
   * exportado por `types/index` ainda descreve o enum antigo
   * (`pending`/`overdue`/`prejudice`), preso a um tipo que espelha a tabela
   * `billings` já removida — reaproveitá-lo aqui espalharia o engano.
   */
  status?: 'open' | 'paid' | 'cancelled' | 'written_off'
}

/**
 * Estados em que a cobrança saiu de contas a receber e não há o que cobrar.
 *
 * `charge_balances.open_amount` é a aritmética do documento (itens − alocado) e
 * continua devolvendo saldo para uma cobrança baixada — correto para registrar
 * a perda, e perigoso se lido como valor cobrável.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['paid', 'cancelled', 'written_off'])

export type AvailableCredit = {
  id: string
  amount: number
  /** Saldo disponível, vindo de `customer_credit_balances`. */
  available: number
  expires_at?: string | null
}

export type Allocation = {
  charge_id: string
  amount: number
}

export type CreditApplicationPlan = {
  credit_id: string
  charge_id: string
  amount: number
}

// ============================================================
// Encargos
// ============================================================

/**
 * Encargo acumulado até `asOf`. É valor PROJETADO — não vira lançamento nem
 * linha de tabela enquanto não for efetivamente cobrado (R-06). Quando é
 * realizado, vira `charge_item` e emite `late_charge_realized`.
 *
 * @param policy   Política fixada na emissão da cobrança (`late_charge_policy_id`).
 * @param principal Principal em aberto, JÁ LÍQUIDO de encargo realizado — quem
 *                  compõe isso é `calculateAmountDue` (ADR 0028). Passar o
 *                  `open_amount` cru cobra juros sobre juros.
 * @param dueDate  Vencimento no formato YYYY-MM-DD.
 * @param asOf     Data de referência (injetada para teste).
 */
export function calculateAccruedCharges(
  policy: LateChargePolicy | null | undefined,
  principal: number,
  dueDate: string,
  asOf: Date = new Date(),
): AccruedCharges {
  const zero: AccruedCharges = {
    grace_period_active: false,
    fee: 0,
    interest: 0,
    total: 0,
    days_since_due: 0,
    days_overdue: 0,
  }

  if (!policy || principal <= 0) return zero

  const due = parseDateLocal(dueDate)
  const today = toDateOnly(asOf)
  const days_since_due = Math.floor((today.getTime() - due.getTime()) / MS_PER_DAY)

  if (days_since_due <= 0) return zero

  const days_overdue = Math.max(0, days_since_due - policy.grace_period_days)
  if (days_overdue === 0) {
    return { ...zero, grace_period_active: true, days_since_due }
  }

  // Multa: uma única vez. fee_value é FRAÇÃO no modelo novo (0.02 = 2%),
  // diferente do `late_charge_config` legado, que guardava 2 para 2%.
  const fee = policy.fee_type === 'percentage'
    ? round2(principal * policy.fee_value)
    : round2(policy.fee_value)

  // Juros: acumulam por dia.
  const interest = round2(principal * policy.daily_interest_rate * days_overdue)

  let total = round2(fee + interest)
  if (total < policy.min_amount) total = round2(policy.min_amount)

  return { grace_period_active: false, fee, interest, total, days_since_due, days_overdue }
}

/**
 * Valor devido de uma cobrança: saldo em aberto + encargo ainda a acrescentar.
 *
 * O encargo é grandeza CORRENTE sobre o principal (ADR 0028). O que já foi
 * realizado virou item da cobrança e já está em `open_amount`: é parcela do
 * corrente, não dívida nova. Por isso a conta apura o total do atraso sobre o
 * principal e desconta o que já foi documentado.
 *
 * FONTE ÚNICA. Hoje existem três contas diferentes para a mesma cobrança —
 * o gateway usa `original − desconto` (`pix.ts:54`), o hook web soma encargo e
 * abate crédito, e o app mobile repete a conta do gateway. O resultado é
 * cliente com crédito pagando a mais e cobrança vencida quitando a menos (F-05).
 *
 * Esta função deve ser a única consumida pelo cockpit, pelo Route Handler do
 * mobile e pela criação de intent no gateway.
 */
export function calculateAmountDue(
  balance: Pick<ChargeBalance, 'open_amount' | 'paid_amount' | 'late_charge_amount' | 'due_date'>
    & { status?: string },
  policy: LateChargePolicy | null | undefined,
  asOf: Date = new Date(),
): {
  open_amount: number
  /** Saldo em aberto SEM o encargo ainda não pago — a base do encargo. */
  principal: number
  /** Encargo CORRENTE do atraso: o total devido desde o vencimento. */
  accrued: AccruedCharges
  /** Parcela do corrente que já é item da cobrança e está dentro de `open_amount`. */
  late_charge_realized: number
  /** O que ainda falta acrescentar — `accrued.total` menos o já realizado. */
  accrued_pending: number
  amount_due: number
} {
  // Coluna faltando na consulta vira NaN, e NaN atravessa a conta inteira sem
  // reclamar: o valor devido some da tela, ou pior, chega ao gateway. Ninguém
  // escreve `late_charge_amount` à mão — ela vem de `charge_balances` —, então
  // a ausência é sempre um `select` incompleto, e é barato dizer qual.
  for (const [campo, valor] of [
    ['open_amount', balance.open_amount],
    ['paid_amount', balance.paid_amount],
    ['late_charge_amount', balance.late_charge_amount],
  ] as const) {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      throw new Error(
        `calculateAmountDue: \`${campo}\` ausente ou inválido (${String(valor)}). ` +
        'Inclua a coluna no select de `charge_balances`.',
      )
    }
  }

  // Cobrança encerrada não deve nada, e sobre ela não corre encargo. Sem isto,
  // uma baixada de 2020 aparecia devendo o principal mais juros que cresciam
  // todo dia — e, pior, a criação de intent no gateway aceitaria gerar
  // pagamento para uma dívida já reconhecida como perda.
  if (balance.status !== undefined && TERMINAL_STATUSES.has(balance.status)) {
    return {
      open_amount: balance.open_amount,
      // Sem política, a função devolve o acumulado zerado — é o mesmo "nada a
      // acrescer" que vale aqui, sem uma segunda construção do objeto.
      principal: balance.open_amount,
      accrued: calculateAccruedCharges(null, balance.open_amount, balance.due_date, asOf),
      late_charge_realized: balance.late_charge_amount,
      accrued_pending: 0,
      amount_due: 0,
    }
  }

  // O encargo já realizado está DENTRO de `open_amount`, como item da cobrança.
  // Somá-lo ao principal cobraria multa de novo e juros sobre juros a cada nova
  // apuração — o que acontecia por estorno de pagamento ou por pagamento
  // parcial (ADR 0028).
  //
  // Imputação: o pagamento quita o encargo antes do principal (art. 354 do
  // Código Civil). É o que mantém o principal intacto quando o cliente paga só
  // o acessório.
  const realized = balance.late_charge_amount
  const encargoAberto = Math.max(0, round2(realized - balance.paid_amount))
  const principal = Math.max(0, round2(balance.open_amount - encargoAberto))

  // `accrued` é o encargo CORRENTE: quanto o atraso deve valer hoje, ao todo.
  const accrued = calculateAccruedCharges(policy, principal, balance.due_date, asOf)

  // E o que se acrescenta é só a diferença para o que já foi documentado. A
  // subtração é o que faz a multa ser uma vez só — ela está dos dois lados e se
  // cancela —, sem precisar guardar "já multei esta cobrança".
  //
  // Trava em zero quando o principal cai depois da realização (pagamento
  // parcial do principal): subcobra e nunca devolve encargo já lançado.
  const accrued_pending = Math.max(0, round2(accrued.total - realized))
  const amount_due = Math.max(0, round2(balance.open_amount + accrued_pending))

  return {
    open_amount: balance.open_amount,
    principal,
    accrued,
    late_charge_realized: realized,
    accrued_pending,
    amount_due,
  }
}

// ============================================================
// Alocação de pagamento
// ============================================================

/**
 * Distribui um pagamento entre cobranças em aberto, da mais antiga para a mais
 * nova. Sobra é devolvida em `unallocated` — cabe à Server Action transformá-la
 * em crédito do cliente.
 *
 * A soma das alocações nunca excede o pagamento; o banco reforça isso em
 * `fn_assert_allocation_within_payment`.
 */
export function allocatePayment(
  paymentAmount: number,
  openCharges: ChargeBalance[],
): { allocations: Allocation[]; unallocated: number } {
  if (!(paymentAmount > 0)) {
    throw new Error(`Pagamento deve ser positivo, recebido ${paymentAmount}`)
  }

  const allocations: Allocation[] = []
  let remaining = round2(paymentAmount)

  for (const charge of sortByDueDate(openCharges)) {
    if (remaining <= 0) break
    if (charge.open_amount <= 0) continue

    const amount = round2(Math.min(remaining, charge.open_amount))
    allocations.push({ charge_id: charge.charge_id, amount })
    remaining = round2(remaining - amount)
  }

  return { allocations, unallocated: remaining }
}

// ============================================================
// Aplicação de crédito
// ============================================================

/**
 * Aplica créditos disponíveis às cobranças em aberto.
 *
 * Diferenças em relação a `fn_auto_apply_credit` (F-06, R-09):
 * - percorre TODOS os créditos, não só o mais antigo
 * - abate a cobrança de vencimento mais antigo, não a recém-inserida
 * - ignora crédito expirado
 * - não engole erro: entrada inválida lança
 *
 * Elegibilidade de cobrança (caução não recebe crédito) é responsabilidade de
 * quem monta `openCharges` — a caução tem conta de passivo própria e não entra
 * na lista de recebíveis operacionais.
 */
export function applyCredits(
  credits: AvailableCredit[],
  openCharges: ChargeBalance[],
  asOf: Date = new Date(),
): { applications: CreditApplicationPlan[]; remainingCredit: number } {
  const today = toDateOnly(asOf)

  const usable = credits
    .filter((c) => c.available > 0)
    .filter((c) => !c.expires_at || parseDateLocal(c.expires_at) >= today)
    .sort((a, b) => (a.expires_at ?? '9999-12-31').localeCompare(b.expires_at ?? '9999-12-31'))

  const applications: CreditApplicationPlan[] = []
  const balances = new Map(usable.map((c) => [c.id, round2(c.available)]))

  for (const charge of sortByDueDate(openCharges)) {
    let owed = round2(charge.open_amount)
    if (owed <= 0) continue

    for (const credit of usable) {
      if (owed <= 0) break
      const available = balances.get(credit.id) ?? 0
      if (available <= 0) continue

      const amount = round2(Math.min(available, owed))
      applications.push({ credit_id: credit.id, charge_id: charge.charge_id, amount })
      balances.set(credit.id, round2(available - amount))
      owed = round2(owed - amount)
    }
  }

  const remainingCredit = round2([...balances.values()].reduce((s, v) => s + v, 0))
  return { applications, remainingCredit }
}

// ============================================================
// Desconto
// ============================================================

export type WeightedBucket = { key: string; weight: number }

/**
 * Distribui um valor entre buckets, proporcional ao peso de cada um.
 *
 * Usada para ratear um desconto entre as contas de origem dos itens da
 * cobrança (aluguel, repasse de multa, encargo por atraso…): a cobrança pode
 * misturar naturezas econômicas diferentes, e o estorno no razão precisa
 * debitar cada uma na sua proporção — nunca uma conta fixa, que classificaria
 * errado a receita de quem não é aluguel.
 *
 * O último bucket (por peso decrescente) absorve o resíduo de arredondamento:
 * sem isso, um desconto rateado entre três contas podia sobrar ou faltar um
 * centavo, e a transação não fecha em zero (Princípio 1).
 */
export function distributeProportionally(
  amount: number,
  buckets: WeightedBucket[],
): { key: string; amount: number }[] {
  const positivos = buckets.filter((b) => b.weight > 0)
  const totalPeso = round2(positivos.reduce((s, b) => s + b.weight, 0))
  if (totalPeso <= 0 || amount <= 0) return []

  const ordenados = [...positivos].sort((a, b) => b.weight - a.weight)

  let alocado = 0
  return ordenados.map((b, i) => {
    if (i === ordenados.length - 1) {
      return { key: b.key, amount: round2(amount - alocado) }
    }
    const parte = round2(amount * b.weight / totalPeso)
    alocado = round2(alocado + parte)
    return { key: b.key, amount: parte }
  })
}

// ============================================================
// Helpers
// ============================================================

/** Vencimento mais antigo primeiro; empate desempatado pelo id, para ser determinístico. */
function sortByDueDate(charges: ChargeBalance[]): ChargeBalance[] {
  return [...charges].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || a.charge_id.localeCompare(b.charge_id),
  )
}

const MS_PER_DAY = 86_400_000

function parseDateLocal(yyyymmdd: string): Date {
  // Índices explícitos em vez de desestruturar: sob `noUncheckedIndexedAccess`,
  // o destructuring produz `number | undefined`.
  const parts = yyyymmdd.split('-')
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
}

function toDateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
