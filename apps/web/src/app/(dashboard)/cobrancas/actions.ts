'use server'

/**
 * Server Actions de cobranças (Spec 0014 / ADR 0024).
 *
 * Toda escrita passa por `lib/financial` — nenhuma action monta lançamento à
 * mão nem escreve em `financial_entries`. Substitui o arquivo anterior, que
 * operava sobre `billings` com um único `original_amount` e marcava pagamento
 * atualizando o status do documento.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logAction } from '@/lib/audit'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import {
  CreateChargeSchema,
  ReceivePaymentSchema,
  CancelChargeSchema,
  WriteOffChargeSchema,
  ApplyDiscountSchema,
  type ActionResult, type ErrorCode,
} from '@gomoto/core'
import {
  createCharge,
  cancelCharge,
  writeOffCharge,
  receivePayment,
  reversePayment,
  applyDiscount,
} from '@/lib/financial'

type Failure = { ok: false; error: { code: ErrorCode; message: string } }

function fail(code: ErrorCode, message: string): Failure {
  return { ok: false, error: { code, message } }
}

type Context =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string; tenantId: string }
  | { ok: false; failure: Failure }

async function getContext(): Promise<Context> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, failure: fail('UNAUTHORIZED', 'Não autorizado') }

  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) return { ok: false, failure: fail('FORBIDDEN', 'Empresa não resolvida') }

  return { ok: true, supabase, userId: user.id, tenantId }
}

function revalidateFinancial() {
  revalidatePath('/cobrancas')
  revalidatePath('/financeiro')
  revalidatePath('/dashboard')
}

/** Mensagem de erro legível, sem vazar detalhe interno do banco. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado'
}

// ============================================================
// Emissão
// ============================================================

/**
 * Cria uma cobrança com um ou mais itens.
 *
 * A cobrança composta — aluguel + multa + encargo num documento só — é o que o
 * modelo anterior não permitia: `billings` tinha um único `original_amount`.
 */
export async function createChargeAction(
  raw: unknown,
): Promise<ActionResult<{ charge_id: string; charge_number: number }>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const parsed = CreateChargeSchema.safeParse(raw)
  if (!parsed.success) {
    return fail('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Dados inválidos')
  }

  try {
    const result = await createCharge(ctx.supabase, ctx.tenantId, {
      customerId: parsed.data.customer_id,
      rentalId: parsed.data.rental_id ?? null,
      dueDate: parsed.data.due_date,
      issueDate: parsed.data.issue_date,
      items: parsed.data.items,
      sourceModule: 'manual',
      createdBy: ctx.userId,
    })

    await logAction({
      action: 'create',
      table: 'charges',
      recordId: result.chargeId,
      newData: { charge_number: result.chargeNumber, total: result.totalAmount },
    })

    revalidateFinancial()
    return { ok: true, data: { charge_id: result.chargeId, charge_number: result.chargeNumber } }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}

// ============================================================
// Recebimento
// ============================================================

/**
 * Registra dinheiro recebido do cliente.
 *
 * Sem alocação explícita, distribui por vencimento mais antigo. Pagamento
 * parcial é natural: a alocação pode ser menor que o total da cobrança.
 *
 * Sobra vira crédito do cliente — antes, um pagamento a maior simplesmente não
 * tinha onde ser registrado.
 */
export async function receivePaymentAction(
  raw: unknown,
): Promise<ActionResult<{ payment_id: string; unallocated: number }>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const parsed = ReceivePaymentSchema.safeParse(raw)
  if (!parsed.success) {
    return fail('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Dados inválidos')
  }

  try {
    const result = await receivePayment(ctx.supabase, ctx.tenantId, {
      customerId: parsed.data.customer_id,
      amount: parsed.data.amount,
      method: parsed.data.method,
      paidAt: new Date(parsed.data.paid_at),
      allocations: parsed.data.allocations?.map((a) => ({
        chargeId: a.charge_id,
        amount: a.amount,
      })),
      notes: parsed.data.notes ?? null,
      receivedBy: ctx.userId,
    })

    // A sobra virava crédito AQUI: inseria a linha em `customer_credits` e não
    // lançava nada no razão. Como o saldo de crédito agrega `creditos_de_clientes`,
    // o crédito nascia visível na ficha do cliente e impossível de aplicar — e o
    // dinheiro do pagamento existia em `payments` e em lugar nenhum do razão.
    // Verificado na tela: R$ 50.000.000,00 numa cobrança de R$ 500,00 deixaram
    // R$ 49.999.500,00 nesse limbo, sem mensagem nenhuma.
    //
    // `receivePayment` passou a recusar valor que não cabe na dívida (decisão do
    // produto: quem quer receber a mais registra o devido e concede o crédito à
    // parte, pela ficha do cliente, onde o lançamento é feito). Este bloco ficou
    // inalcançável, e código morto com defeito dentro é pior que nenhum.

    await logAction({
      action: 'create',
      table: 'payments',
      recordId: result.paymentId,
      newData: { amount: parsed.data.amount, allocations: result.allocations.length },
    })

    revalidateFinancial()
    return { ok: true, data: { payment_id: result.paymentId, unallocated: result.unallocated } }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}

/** Estorna um pagamento. As cobranças quitadas por ele voltam a ficar em aberto. */
export async function reversePaymentAction(
  paymentId: string,
  reason: string,
): Promise<ActionResult<void>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  if (!reason || reason.trim().length < 3) {
    return fail('VALIDATION_ERROR', 'Informe o motivo do estorno')
  }

  try {
    await reversePayment(ctx.supabase, ctx.tenantId, paymentId, reason.trim(), ctx.userId)

    await logAction({
      action: 'update',
      table: 'payments',
      recordId: paymentId,
      newData: { reversed: true, reason },
    })

    revalidateFinancial()
    return { ok: true, data: undefined }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}

// ============================================================
// Desconto
// ============================================================

/**
 * Concede desconto a uma cobrança em aberto.
 *
 * Nunca edita o valor emitido — insere item negativo e estorna a receita na
 * proporção (ADR 0024, Princípio 5). Ver `applyDiscount` em `lib/financial`.
 */
export async function applyDiscountAction(raw: unknown): Promise<ActionResult<void>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const parsed = ApplyDiscountSchema.safeParse(raw)
  if (!parsed.success) {
    return fail('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Dados inválidos')
  }

  try {
    await applyDiscount(ctx.supabase, ctx.tenantId, {
      chargeId: parsed.data.charge_id,
      discountAmount: parsed.data.discount_amount,
      reason: parsed.data.discount_reason,
      createdBy: ctx.userId,
    })

    await logAction({
      action: 'update',
      table: 'charges',
      recordId: parsed.data.charge_id,
      newData: { discount: parsed.data.discount_amount, reason: parsed.data.discount_reason },
    })

    revalidateFinancial()
    return { ok: true, data: undefined }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}

// ============================================================
// Ciclo de vida
// ============================================================

/** Cancela a cobrança e estorna a emissão. Recusa se já houver recebimento. */
export async function cancelChargeAction(raw: unknown): Promise<ActionResult<void>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const parsed = CancelChargeSchema.safeParse(raw)
  if (!parsed.success) {
    return fail('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Dados inválidos')
  }

  try {
    await cancelCharge(
      ctx.supabase, ctx.tenantId, parsed.data.charge_id, parsed.data.reason, ctx.userId,
    )

    await logAction({
      action: 'update',
      table: 'charges',
      recordId: parsed.data.charge_id,
      newData: { status: 'cancelled', reason: parsed.data.reason },
    })

    revalidateFinancial()
    return { ok: true, data: undefined }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}

/**
 * Baixa por inadimplência.
 *
 * Substitui `markBillingAsLoss`, que só trocava o status para 'prejudice' —
 * sem reconhecer a perda em lugar nenhum.
 */
export async function writeOffChargeAction(raw: unknown): Promise<ActionResult<void>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const parsed = WriteOffChargeSchema.safeParse(raw)
  if (!parsed.success) {
    return fail('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Dados inválidos')
  }

  try {
    await writeOffCharge(
      ctx.supabase, ctx.tenantId, parsed.data.charge_id, parsed.data.reason, ctx.userId,
    )

    await logAction({
      action: 'update',
      table: 'charges',
      recordId: parsed.data.charge_id,
      newData: { status: 'written_off', reason: parsed.data.reason },
    })

    revalidateFinancial()
    return { ok: true, data: undefined }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}
