/**
 * Termos de multa e juros para um gateway que os embute no próprio código de
 * pagamento (ADR 0037, decisão 3).
 *
 * Num Pix com vencimento (`cobv`), quem calcula o valor na hora de pagar é o
 * banco do PAGADOR, a partir do vencimento e das regras que viajam no QR. É o
 * que garante o encargo mesmo quando o cliente guarda o código e paga dias
 * depois sem abrir o app — coisa que nenhum valor congelado consegue
 * (ADR 0038, P2).
 *
 * A política continua sendo a da locadora (`late_charge_policies`, fixada na
 * cobrança): o provedor só a executa. Esta função é a tradução, e as perdas de
 * fidelidade dela estão listadas aqui, não escondidas:
 *
 * - `min_amount` (piso do encargo) não tem equivalente — o provedor cobra
 *   MENOS que o GoMoto enquanto multa + juros não alcançam o piso;
 * - o juro mensal viaja com 2 casas (o Asaas arredonda 0,987 para 0,99) e o
 *   valor é truncado por ele — diferença de centavos;
 * - cobrança já vencida: o juro do provedor incide sobre o `value`, que já
 *   contém o encargo apurado até hoje — um pouco de juro sobre juro.
 *
 * Em todas, o provedor cobra igual ou menos, nunca mais. O razão registra o
 * que foi cobrado de fato (`interestValue`), não esta estimativa.
 */

import { calculateAmountDue, type ChargeBalance, type LateChargePolicy } from '../rules/allocation'

export type EmbeddedLateChargeTerms = {
  /** Valor nominal do código. */
  value: number
  /** Vencimento a declarar no provedor, `YYYY-MM-DD`. Nunca no passado. */
  dueDate: string
  /** Multa, uma vez. `percent` em pontos percentuais (2 = 2%). */
  fine: { kind: 'percent' | 'fixed'; value: number } | null
  /** Juros simples ao mês, em pontos percentuais, pro rata dia. */
  monthlyInterestPercent: number | null
  /**
   * Encargo JÁ embutido em `value` — vai para `payment_intents.accrued_amount`
   * e é realizado na confirmação. O que o provedor somar depois chega como
   * `interestValue` e é realizado à parte.
   */
  accruedIncluded: number
  /**
   * `before_overdue`: ainda dentro do prazo (vencimento + carência); o
   * provedor aplica multa e juros a partir do mesmo dia que o GoMoto aplicaria.
   *
   * `already_overdue`: o provedor recusa vencimento no passado, então o valor
   * de hoje vai no `value` (com multa e piso, pelo GoMoto) e o provedor só
   * soma os juros dos dias seguintes.
   */
  path: 'before_overdue' | 'already_overdue'
}

export function embeddedLateChargeTerms(
  balance: Pick<ChargeBalance, 'open_amount' | 'paid_amount' | 'late_charge_amount' | 'due_date'>
    & { status?: string },
  policy: LateChargePolicy | null | undefined,
  asOf: Date = new Date(),
): EmbeddedLateChargeTerms {
  const due = calculateAmountDue(balance, policy, asOf)
  const today = formatDate(toDateOnly(asOf))

  // Sem política não há encargo a embutir: o código vale o saldo, e o
  // vencimento só não pode ficar no passado.
  if (!policy) {
    return {
      value: due.amount_due,
      dueDate: maxDate(balance.due_date, today),
      fine: null,
      monthlyInterestPercent: null,
      accruedIncluded: due.accrued_pending,
      path: 'before_overdue',
    }
  }

  const interest = toMonthlyPercent(policy.daily_interest_rate)

  // Encargo já realizado em algum momento (pagamento parcial, estorno) quer
  // dizer que a multa já foi documentada: ela não pode viajar de novo no
  // código. Por isso esse caso segue o caminho do atraso mesmo se `accrued`
  // disser que hoje não há atraso a apurar.
  const overdue = due.accrued.days_overdue > 0 || due.late_charge_realized > 0

  if (!overdue) {
    return {
      value: due.amount_due,
      // A carência vira vencimento: o provedor começa a multar e a contar
      // juros no dia seguinte — o mesmo em que `days_overdue` passa de 0 a 1.
      dueDate: maxDate(addDays(balance.due_date, policy.grace_period_days), today),
      fine: toFine(policy),
      monthlyInterestPercent: interest,
      accruedIncluded: 0,
      path: 'before_overdue',
    }
  }

  return {
    value: due.amount_due,
    dueDate: today,
    // A multa já está dentro de `value` — é uma vez só (ADR 0028).
    fine: null,
    monthlyInterestPercent: interest,
    accruedIncluded: due.accrued_pending,
    path: 'already_overdue',
  }
}

function toFine(policy: LateChargePolicy): EmbeddedLateChargeTerms['fine'] {
  if (!(policy.fee_value > 0)) return null
  // `fee_value` é FRAÇÃO no modelo novo (0.02 = 2%); o provedor fala pontos
  // percentuais. Fixa é em reais e passa direto.
  return policy.fee_type === 'percentage'
    ? { kind: 'percent', value: round2(policy.fee_value * 100) }
    : { kind: 'fixed', value: round2(policy.fee_value) }
}

/**
 * Juro diário (fração) → mensal (pontos percentuais), pro rata de 30 dias.
 *
 * Verificado no Asaas: 1%/mês sobre R$ 100 cobra R$ 0,03 em um dia — a mesma
 * conta de `principal × diário × dias` com diário = 1%/30.
 */
function toMonthlyPercent(dailyRate: number): number | null {
  if (!(dailyRate > 0)) return null
  const monthly = round2(dailyRate * 30 * 100)
  return monthly > 0 ? monthly : null
}

function toDateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(yyyymmdd: string, days: number): string {
  const parts = yyyymmdd.split('-')
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + days)
  return formatDate(date)
}

/** Datas `YYYY-MM-DD` comparam como texto. */
function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
