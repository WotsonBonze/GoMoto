/**
 * InfinitePay como implementação de `PaymentProvider` (ADR 0032).
 *
 * Terceiro gateway, e o primeiro que NÃO entrega um código de pagamento. O
 * Mercado Pago e a Cora devolvem um Pix que o GoMoto desenha; a InfinitePay
 * devolve uma URL e quem escolhe Pix, cartão ou carteira é o cliente, na página
 * deles. Por isso o método é `payment_link` e não `pix`: o produto não controla
 * essa superfície e não deve fingir que controla.
 */

import { randomUUID } from 'node:crypto'
import { findPaymentProvider } from '@gomoto/core'
import type { PaymentProvider } from '../../types'
import { codedError } from '../../types'
import { createCheckoutLink } from './api'

const descriptor = findPaymentProvider('infinitepay')!

/**
 * URL do webhook, com o segredo no path.
 *
 * Ao contrário da Cora — cadastrada uma vez no painel deles — a `webhook_url`
 * viaja no corpo de CADA criação de link. Mesmo arranjo que o Mercado Pago já
 * usa (`MERCADOPAGO_WEBHOOK_URL`).
 *
 * Ausente, a criação FALHA em vez de seguir sem webhook. Um link sem retorno é
 * pior que link nenhum: o cliente paga, o dinheiro entra na conta da locadora e
 * a cobrança fica aberta para sempre, porque nada avisa o GoMoto. Falhar aqui é
 * barulhento e reversível; o silêncio não é.
 */
function webhookUrl(): string {
  const url = process.env.INFINITEPAY_WEBHOOK_URL
  if (!url) {
    throw codedError(
      'INTERNAL',
      'INFINITEPAY_WEBHOOK_URL não configurada — sem ela o pagamento nunca seria confirmado.',
    )
  }
  return url
}

export const infinitePayProvider: PaymentProvider = {
  descriptor,

  // Sem `oauth`: a conexão é por handle e acontece na Server Action de
  // configurações, que chama `verifyHandle` direto. O registry cobra coerência
  // entre `connectionMode` e a presença deste bloco.

  async createIntent({ amount, chargeId, method, credentials, customer }) {
    if (method !== 'payment_link') {
      throw new Error(`InfinitePay: método ${method} não implementado`)
    }

    const handle = (credentials as { handle?: unknown }).handle
    if (typeof handle !== 'string' || !handle) {
      throw codedError('GATEWAY_UNAUTHORIZED', 'InfiniteTag ausente — reconecte a conta')
    }

    /**
     * `order_nsu` é a AMARRA entre o link e a nossa tentativa.
     *
     * Gerado aqui porque a resposta da API é `{"url": "..."}` e nada mais — sem
     * slug, sem id de fatura. O `invoice_slug` deles só existe quando o webhook
     * chega, tarde demais para identificar o intent. Então quem nomeia é o
     * GoMoto, e `provider_intent_id` guarda este UUID.
     *
     * Ser um UUID importa: é o que o webhook usa para achar o dono do dinheiro,
     * e um valor adivinhável ali seria um convite a confirmar cobrança alheia.
     */
    const orderNsu = randomUUID()

    const { url } = await createCheckoutLink({
      handle,
      amount,
      orderNsu,
      description: `Cobrança ${chargeId.slice(0, 8)}`,
      webhookUrl: webhookUrl(),
      customer: { name: customer.name, email: customer.email },
    })

    return {
      providerIntentId: orderNsu,
      // O link não declara validade. Sem `expires_at` a tentativa é
      // reaproveitada até ser paga ou cancelada — o comportamento certo para
      // uma URL que continua funcionando.
      expiresAt: null,
      payload: {
        // Nome próprio, deliberadamente FORA do vocabulário do Pix. Gravar isto
        // como `emv` ou `qr_code` faria `ensureQrImage` desenhar o QR de uma
        // URL e o app do cliente exibi-lo como código Pix — um código que o
        // banco não lê e que o cliente tentaria colar no lugar errado.
        checkout_url: url,
        order_nsu: orderNsu,
      },
    }
  },
}
