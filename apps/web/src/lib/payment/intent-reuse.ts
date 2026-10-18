import { findPaymentProvider } from '@gomoto/core'

/**
 * O código pendente ainda cobra a dívida de hoje?
 *
 * Antes só `expires_at` era conferido. A Cora e a InfinitePay gravam `null`, e
 * o Pix de uma cobrança vencida gerado no dia 10 era devolvido no dia 15 com o
 * valor do dia 10 — os juros dos dias seguintes sumiam (ADR 0038, P1).
 *
 * - Valor congelado: só serve se for exatamente o devido hoje.
 * - Encargo embutido (Asaas): o código soma os dias sozinho; serve enquanto a
 *   BASE não mudar — o principal e o encargo já realizado de quando foi
 *   emitido. Pagamento parcial, desconto ou estorno mudam a base.
 */
export function representsDebt(
  row: { provider: string; amount: number; payload: Record<string, unknown> | null },
  due: { amount_due: number; principal: number; late_charge_realized: number },
): boolean {
  if (findPaymentProvider(row.provider)?.accruesLateChargesNatively) {
    const t = row.payload?.late_charge_terms as { principal?: unknown; realized?: unknown } | undefined
    return Number(t?.principal) === due.principal && Number(t?.realized) === due.late_charge_realized
  }
  return Number(row.amount) === due.amount_due
}
