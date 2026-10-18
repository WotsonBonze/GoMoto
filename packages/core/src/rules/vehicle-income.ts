/**
 * Renda do veículo, separada pelo que ela É:
 *
 *  - **receita** (aluguel, encargo de atraso) — desempenho da moto.
 *  - **repasse** (multa do cliente, rateio de manutenção) — a empresa adianta e
 *    cobra de volta; é um ADIANTAMENTO, não desempenho. Contá-lo como retorno
 *    fazia a multa devolvida aumentar "investido" e "recuperado" ao mesmo
 *    tempo, e o percentual recuperado subia sem a moto ter rendido nada.
 *  - **outro** (caução) — passivo, dinheiro de terceiro. Nunca é receita nem
 *    repasse; uma cobrança 100% caução (ADR 0024: origem única por cobrança)
 *    fica inteiramente de fora de qualquer um dos dois.
 *
 * `summarizeVehicleIncome`  → recebido próprio, por categoria, e o saldo do repasse
 * `deductPassThrough`       → despesa que fica com a empresa (bruto − repasse)
 *
 * Puras: recebem linhas já lidas, sem I/O.
 */

import type { DatedAmount } from './vehicle-payback'

export type ChargeItemKind = 'revenue' | 'reimbursement' | 'other'

export type IncomeChargeItem = {
  amount: number
  kind: ChargeItemKind
  /** Nome legível da conta — vira categoria na composição das entradas. */
  account_label: string
  /** `${source_module}:${source_id}` da despesa de origem; só repasse tem. */
  source_key: string | null
}

export type IncomeCharge = {
  id: string
  status: 'open' | 'paid' | 'cancelled' | 'written_off'
  items: IncomeChargeItem[]
}

export type IncomeAllocation = {
  charge_id: string
  /** Data do pagamento (ISO). */
  date: string
  amount: number
  /**
   * Falso quando o pagamento é `method = 'credit'` — a empresa usou um crédito
   * que já devia ao cliente (concedido noutro evento, já fora de
   * "despesas da empresa" quando concedido) para abater esta cobrança. Não é
   * dinheiro novo: contar entraria a mesma quantia duas vezes — uma quando o
   * crédito foi concedido, outra aqui.
   *
   * Retenção de caução (`deposit_retention`) É dinheiro real de recuperação —
   * é a diferença entre devolver a caução inteira e reter parte dela para
   * quitar um débito — e por isso conta como pago.
   */
  is_cash: boolean
}

export type VehicleIncomeSummary = {
  /** Recebido da moto (só receita), com data — alimenta o payback. */
  own_receipts: DatedAmount[]
  /** Recebido da moto + repasse devolvido, por categoria — composição das entradas. */
  received_by_source: Map<string, number>
  /** Repasse emitido em cobranças não canceladas. */
  passthrough_billed: number
  /** Quanto do repasse já foi devolvido. */
  passthrough_received: number
  /** Repasse ainda a devolver: emitido − devolvido. */
  passthrough_pending: number
  /** Repasse emitido por despesa de origem — insumo de `deductPassThrough`. */
  billed_by_source: Map<string, number>
}

/**
 * Cobrança de repasse puro tem só itens de repasse; cobrança mista (aluguel +
 * encargo) tem vários itens de receita. O pagamento é alocado à cobrança, não
 * ao item, então cada categoria recebe a fração proporcional ao seu peso no
 * total DA COBRANÇA — caução (kind='other') nunca entra nesse total: uma
 * cobrança só dela fica com total=0 e é inteiramente ignorada, tanto no
 * recebido próprio quanto no repasse.
 */
export function summarizeVehicleIncome(
  charges: IncomeCharge[],
  allocations: IncomeAllocation[],
): VehicleIncomeSummary {
  type Distribution = { kind: ChargeItemKind; label: string; sourceKey: string | null; weight: number }
  const distributionByCharge = new Map<string, Distribution[]>()
  const billedBySource = new Map<string, number>()
  let passthroughBilled = 0

  for (const c of charges) {
    if (c.status === 'cancelled') continue

    const relevant = c.items.filter((i) => i.kind !== 'other')
    const total = relevant.reduce((sum, i) => sum + i.amount, 0)
    if (total <= 0) continue // caução (ou qualquer cobrança sem receita/repasse): fora de tudo

    distributionByCharge.set(c.id, relevant.map((i) => ({
      kind: i.kind,
      label: i.account_label,
      sourceKey: i.source_key,
      weight: i.amount / total,
    })))

    for (const i of relevant) {
      if (i.kind !== 'reimbursement') continue
      passthroughBilled += i.amount
      if (i.source_key) billedBySource.set(i.source_key, (billedBySource.get(i.source_key) ?? 0) + i.amount)
    }
  }

  let passthroughReceived = 0
  const ownReceipts: DatedAmount[] = []
  const receivedBySource = new Map<string, number>()

  for (const a of allocations) {
    if (!a.is_cash) continue // crédito consumido: já contado quando foi concedido

    const distribution = distributionByCharge.get(a.charge_id)
    if (!distribution) continue // cancelada ou só caução: não é recebido próprio nem repasse

    for (const d of distribution) {
      const portion = round2(a.amount * d.weight)
      if (portion === 0) continue

      receivedBySource.set(d.label, (receivedBySource.get(d.label) ?? 0) + portion)
      if (d.kind === 'reimbursement') {
        passthroughReceived += portion
      } else {
        ownReceipts.push({ date: a.date, amount: portion })
      }
    }
  }

  const billedRounded = round2(passthroughBilled)
  const receivedRounded = round2(passthroughReceived)

  return {
    own_receipts: ownReceipts,
    received_by_source: receivedBySource,
    passthrough_billed: billedRounded,
    passthrough_received: receivedRounded,
    passthrough_pending: round2(Math.max(0, billedRounded - receivedRounded)),
    billed_by_source: billedBySource,
  }
}

export type PayableForDeduction = {
  date: string
  amount: number
  /** `${source_module}:${source_id ?? id}` — mesma chave dos itens de repasse. */
  source_key: string
}

/**
 * Despesa que fica com a empresa: valor bruto menos o que foi repassado ao
 * cliente em cobrança. Um repasse nunca abate mais do que a despesa que o gerou
 * (o excedente de uma chave não passa para outra despesa).
 */
export function deductPassThrough(
  payables: PayableForDeduction[],
  billedBySource: Map<string, number>,
): DatedAmount[] {
  const remaining = new Map(billedBySource)

  return payables.map((p) => {
    const available = remaining.get(p.source_key) ?? 0
    const deducted = Math.min(p.amount, available)
    remaining.set(p.source_key, available - deducted)
    return { date: p.date, amount: round2(p.amount - deducted) }
  })
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
