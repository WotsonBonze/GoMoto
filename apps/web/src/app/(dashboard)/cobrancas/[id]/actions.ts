'use server'

/**
 * Server Actions do detalhe da cobrança (Spec 0014 / ADR 0024).
 *
 * Aplicação de crédito, consolidação de encargo e geração de Pix. O
 * recebimento e o ciclo de vida do documento ficam em `../actions.ts`.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logAction } from '@/lib/audit'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import {
  applyCredits,
  type ActionResult,
  type ErrorCode,
  type AvailableCredit,
  type ChargeBalance,
} from '@gomoto/core'
import { postTransaction, dimensionsOf, realizeAccruedBefore } from '@/lib/financial'
import { getOrCreateIntent, type PaymentIntentResult } from '@/lib/payment/intents'

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

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado'
}
/**
 * Abate crédito do cliente NESTA cobrança, no valor informado.
 *
 * A versão anterior recebia só o `customerId` e varria todo o saldo para as
 * cobranças mais antigas em aberto. O modal pedia qual crédito e quanto,
 * validava os dois e descartava: abrir a cobrança #7, escolher R$ 50 e ver
 * R$ 200 abatidos na #3 era o comportamento correto do código e o oposto do
 * que a tela prometia.
 *
 * A regra e as guardas moram em `fn_apply_customer_credit`, sob trava do
 * cliente: ler-saldo, decidir e escrever solto aqui deixava dois operadores
 * gastarem o mesmo crédito ao mesmo tempo.
 *
 * Só realiza encargo por atraso quando o crédito avança sobre ele.
 *
 * Abater até o que já é dívida real (`open_amount`) é desconto puro: o
 * encargo, se houver, fica para o registro de pagamento do restante, na data
 * do recebimento — é ele que tem campo de data, e é o que corrige o que o
 * operador digitar. Mas se o valor pedido passa de `open_amount`, só pode ser
 * porque o crédito está cobrindo também o encargo — e aí ele PRECISA ser
 * realizado antes: aplicar R$ 350 numa dívida de R$ 300 sem lançar os R$ 50
 * de juros embutidos apagaria o encargo de graça, exatamente a assimetria que
 * a versão anterior deste comentário corrigiu (`realizeAccruedBefore` sempre
 * com `new Date()`, sem olhar o valor pedido) e que quebrou a reconciliação
 * de pagamento retroativo. Agora as duas coisas são verdade: quitar SÓ com o
 * que já está lançado não toca o encargo; quitar avançando sobre ele, sim — e
 * é o valor pedido, não a intenção, que decide.
 *
 * A tela precisa deixar isso claro ANTES de confirmar — ver `BillingActions`.
 */
export async function applyCustomerCredits(
  input: { customer_id: string; charge_id: string; amount: number },
): Promise<ActionResult<{ total: number }>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  const amount = Math.round(Number(input.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('VALIDATION_ERROR', 'Informe um valor maior que zero.')
  }

  try {
    const { data: balanceRow } = await ctx.supabase
      .from('charge_balances')
      .select('open_amount')
      .eq('charge_id', input.charge_id)
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle()

    const openAmount = round2(Number((balanceRow as { open_amount: number } | null)?.open_amount ?? 0))

    if (amount > openAmount) {
      await realizeAccruedBefore(ctx.supabase, ctx.tenantId, [input.charge_id], new Date())
    }

    const { error } = await ctx.supabase.rpc('fn_apply_customer_credit', {
      p_tenant_id:   ctx.tenantId,
      p_customer_id: input.customer_id,
      p_charge_id:   input.charge_id,
      p_amount:      amount,
      p_created_by:  ctx.userId,
    })

    if (error) {
      const conhecidos: [string, string][] = [
        ['AMOUNT_EXCEEDS_BALANCE', 'O cliente não tem esse saldo de crédito.'],
        ['AMOUNT_EXCEEDS_CHARGE', 'O valor passa do que esta cobrança ainda deve.'],
        ['CHARGE_BELONGS_TO_ANOTHER_CUSTOMER', 'Esta cobrança é de outro cliente.'],
        ['CHARGE_NOT_FOUND', 'Cobrança não encontrada.'],
        ['CUSTOMER_NOT_FOUND', 'Cliente não encontrado.'],
      ]
      const achado = conhecidos.find(([k]) => error.message.includes(k))
      return achado
        ? fail('VALIDATION_ERROR', achado[1])
        : fail('INTERNAL', error.message)
    }

    await logAction({
      action: 'update',
      table: 'customer_credits',
      recordId: input.customer_id,
      newData: { charge_id: input.charge_id, amount },
    })

    revalidatePath('/cobrancas')
    revalidatePath('/clientes')
    return { ok: true, data: { total: amount } }
  } catch (err) {
    return fail('INTERNAL', toMessage(err))
  }
}


function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Gera (ou reaproveita) a cobrança Pix desta cobrança no gateway ativo.
 *
 * O cockpit **perdeu** esta ação. O commit `930a50b` (27/06) tinha um botão
 * "Gerar Pix" na listagem; a reescrita da tela sobre o ledger (`eac1e7f`,
 * 12/08, 877 → 600 linhas) o removeu junto com a Server Action e nada foi
 * reposto. Desde então o operador conecta o gateway em Configurações e não tem
 * por onde cobrar — o único caminho vivo era `/api/charges/[id]/payment-intent`,
 * que exige token de CLIENTE (`customers.user_id = auth.uid()`) e portanto só
 * serve ao app. Um operador não é `customer` e não passa naquela checagem.
 *
 * Roda com o cliente do USUÁRIO, não com service role: tudo que
 * `getOrCreateIntent` toca é alcançável por `authenticated` sob RLS —
 * `charge_balances`, `payment_intents` (GRANT ALL), as colunas públicas de
 * `payment_provider_accounts` e `fn_provider_credentials`, que checa o tenant
 * por dentro. Contornar a RLS aqui seria trocar uma garantia do banco por uma
 * comparação escrita à mão.
 */
export async function generateChargePixAction(rawChargeId: unknown): Promise<ActionResult<PaymentIntentResult>> {
  const ctx = await getContext()
  if (!ctx.ok) return ctx.failure

  if (typeof rawChargeId !== 'string' || !rawChargeId) {
    return fail('VALIDATION_ERROR', 'Cobrança inválida')
  }

  // Titularidade antes de qualquer coisa. A RLS já filtraria, mas uma cobrança
  // de outro tenant deve responder "não encontrada" e não seguir adiante até
  // estourar em algum ponto interno com mensagem de banco.
  const { data: charge } = await ctx.supabase
    .from('charges')
    .select('id')
    .eq('id', rawChargeId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (!charge) return fail('NOT_FOUND', 'Cobrança não encontrada')

  try {
    const intent = await getOrCreateIntent(ctx.supabase, {
      tenantId: ctx.tenantId,
      chargeId: rawChargeId,
      // Método omitido de propósito: quem decide é o gateway eleito. Esta ação
      // dizia `'pix'` e por isso não servia a um provedor de link de pagamento.
    })

    await logAction({
      action: 'generate_pix',
      table: 'payment_intents',
      recordId: intent.intent_id,
      newData: {
        charge_id: rawChargeId,
        provider: intent.provider,
        amount: intent.amount,
        reused: intent.is_reused,
      },
    })

    revalidatePath(`/cobrancas/${rawChargeId}`)
    return { ok: true, data: intent }
  } catch (err) {
    const e = err as Error & { code?: string }

    // Os códigos vêm de `getOrCreateIntent`, que fala o vocabulário do gateway.
    // Traduzir aqui mantém a tela sem precisar conhecê-lo — e preserva a
    // distinção que importa: "não há gateway" pede configuração, "credencial
    // expirada" pede reconexão, e nenhuma das duas pede nova tentativa.
    if (e.code === 'FORBIDDEN') {
      return fail('FORBIDDEN', e.message)
    }
    if (e.code === 'GATEWAY_UNAUTHORIZED') {
      return fail('FORBIDDEN', e.message)
    }
    if (e.code === 'NOT_FOUND')  return fail('NOT_FOUND', e.message)
    if (e.code === 'CONFLICT')   return fail('CONFLICT', e.message)

    console.error('[generateChargePixAction]', e)
    return fail('INTERNAL', 'Não foi possível gerar o Pix. Tente novamente.')
  }
}
