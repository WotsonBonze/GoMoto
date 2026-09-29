/**
 * Recebíveis e rateio de despesa de UM veículo, para a tela financeira do veículo.
 *
 * Entrada: linhas já lidas do banco (`charge_balances`, `rental_billing_schedules`,
 * `payables`). Nada aqui faz I/O nem recalcula saldo — saldo e atraso já vêm
 * derivados da view (ADR 0024, Princípios 2 e 4); estas funções só somam.
 */

export type ReceivableCharge = {
  status: 'open' | 'paid' | 'cancelled' | 'written_off'
  due_date: string
  total_amount: number
  paid_amount: number
  open_amount: number
  is_overdue: boolean
  days_overdue: number
}

/** Linha de cronograma ainda não emitida (`status = 'scheduled'`). */
export type ScheduledLine = {
  due_date: string
  amount: number
}

export type VehicleReceivables = {
  /** Dinheiro que entrou: alocações de pagamentos não estornados. */
  received: number
  /** recebido + em atraso + a vencer + a emitir: tudo que o contrato ainda espera ou já trouxe. */
  expected_total: number
  /** received / expected_total, em %. null quando não há nada previsto. */
  received_pct: number | null
  overdue: { amount: number; count: number; oldest_days: number }
  /** Emitido, em aberto e ainda dentro do prazo. */
  upcoming: { amount: number; count: number; next_due_date: string | null }
  /** Cronograma da locação ativa que ainda não virou cobrança. */
  to_issue: { amount: number; count: number; first_due_date: string | null; last_due_date: string | null }
  /** upcoming + to_issue. */
  future_total: number
}

export function summarizeVehicleReceivables(
  charges: ReceivableCharge[],
  scheduledLines: ScheduledLine[],
): VehicleReceivables {
  let received = 0
  const overdue = { amount: 0, count: 0, oldest_days: 0 }
  const upcoming = { amount: 0, count: 0, next_due_date: null as string | null }

  for (const c of charges) {
    // Cancelada nunca foi dívida do cliente: fora de tudo.
    if (c.status === 'cancelled') continue

    received += c.paid_amount

    // Só cobrança aberta é recebível. Baixa como prejuízo (`written_off`) já
    // saiu do que se espera receber, mesmo com saldo.
    if (c.status !== 'open' || !(c.open_amount > 0)) continue

    if (c.is_overdue) {
      overdue.amount += c.open_amount
      overdue.count += 1
      overdue.oldest_days = Math.max(overdue.oldest_days, c.days_overdue)
    } else {
      upcoming.amount += c.open_amount
      upcoming.count += 1
      if (!upcoming.next_due_date || c.due_date < upcoming.next_due_date) {
        upcoming.next_due_date = c.due_date
      }
    }
  }

  const toIssue = { amount: 0, count: 0, first_due_date: null as string | null, last_due_date: null as string | null }
  for (const l of scheduledLines) {
    toIssue.amount += l.amount
    toIssue.count += 1
    if (!toIssue.first_due_date || l.due_date < toIssue.first_due_date) toIssue.first_due_date = l.due_date
    if (!toIssue.last_due_date || l.due_date > toIssue.last_due_date) toIssue.last_due_date = l.due_date
  }

  const expected = received + overdue.amount + upcoming.amount + toIssue.amount

  return {
    received: round2(received),
    expected_total: round2(expected),
    received_pct: expected > 0 ? round2((received / expected) * 100) : null,
    overdue: { ...overdue, amount: round2(overdue.amount) },
    upcoming: { ...upcoming, amount: round2(upcoming.amount) },
    to_issue: { ...toIssue, amount: round2(toIssue.amount) },
    future_total: round2(upcoming.amount + toIssue.amount),
  }
}

export type PayableShare = {
  status: 'open' | 'paid' | 'cancelled'
  /** Valor bruto da despesa (parte da empresa + parte do cliente). */
  amount: number
}

export type ExpenseResponsibilitySummary = {
  /** Despesas consideradas (não canceladas). */
  count: number
  /** Custo bruto: parte da empresa + parte do cliente. */
  total: number
  /** Quem arca no fim: total menos o que é do cliente. */
  company: number
  /** Quem arca no fim: o que foi repassado ao cliente (multa, rateio, custo dele). */
  customer: number
  /** Parte do cliente sobre o total, em %. null sem despesa. */
  customer_pct: number | null
}

/**
 * Quem arca com as despesas do veículo.
 *
 * `customerBears` vem do razão (contas de repasse do veículo), não de
 * `payables.customer_amount`: a multa do cliente é lançada como despesa 100%
 * da empresa — o auto é lavrado contra o veículo e é a proprietária quem
 * responde ao órgão — e a responsabilidade dele só existe na cobrança de
 * repasse. Somar `customer_amount` deixava a multa repassada na coluna da empresa.
 *
 * Conta a pagar cancelada não foi custo de ninguém.
 */
export function summarizeExpenseResponsibility(
  payables: PayableShare[],
  customerBears: number,
): ExpenseResponsibilitySummary {
  let count = 0
  let total = 0

  for (const p of payables) {
    if (p.status === 'cancelled') continue
    count += 1
    total += p.amount
  }

  // O repasse nunca pode passar do custo: dado incoerente não pode virar
  // "empresa" negativa na tela.
  const customer = Math.min(Math.max(customerBears, 0), total)

  return {
    count,
    total: round2(total),
    company: round2(total - customer),
    customer: round2(customer),
    customer_pct: total > 0 ? round2((customer / total) * 100) : null,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
