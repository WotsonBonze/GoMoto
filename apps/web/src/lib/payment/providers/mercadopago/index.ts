/**
 * Mercado Pago como implementação de `PaymentProvider` (ADR 0030).
 *
 * Tudo que é específico do Mercado Pago no cockpit está neste diretório: o
 * cliente HTTP em `api.ts`, o adaptador aqui. Nenhum outro arquivo da aplicação
 * nomeia este provedor — quem cobra é a conta eleita pelo tenant, resolvida
 * pelo registry.
 *
 * O molde para o Cora é este: `api.ts` + `index.ts` + uma entrada no registry.
 */

import { findPaymentProvider } from '@gomoto/core'
import { expiresAtFrom } from '../../credentials'
import type { PaymentProvider, ProviderConnection, ProviderCredentials } from '../../types'
import { ProviderAuthError } from '../../types'
import {
  buildOAuthUrl,
  cancelPayment,
  createPixCharge,
  exchangeCodeForTokens,
  refreshAccessToken,
  MercadoPagoAuthError,
} from './api'

const descriptor = findPaymentProvider('mercadopago')!

/** O access token é o que interessa; o refresh só existe para renovar. */
function accessTokenOf(credentials: ProviderCredentials): string {
  const token = (credentials as { access_token?: unknown }).access_token
  if (typeof token !== 'string' || !token) {
    throw new ProviderAuthError('mercadopago', 'Credencial do Mercado Pago ausente ou malformada')
  }
  return token
}

export const mercadoPagoProvider: PaymentProvider = {
  descriptor,

  oauth: {
    buildAuthUrl: (state) => buildOAuthUrl(state),

    async exchangeCode(code): Promise<ProviderConnection> {
      const tokens = await exchangeCodeForTokens(code)
      return {
        externalAccountId: tokens.mp_user_id,
        accountLabel: tokens.mp_account_email,
        credentials: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAtFrom(tokens.expires_in),
        },
      }
    },

    async refresh(credentials) {
      const refreshToken = (credentials as { refresh_token?: unknown }).refresh_token
      if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new ProviderAuthError('mercadopago', 'Sem refresh token — reconecte a conta')
      }
      const renewed = await refreshAccessToken(refreshToken)
      return {
        access_token: renewed.access_token,
        refresh_token: renewed.refresh_token,
        expires_at: expiresAtFrom(renewed.expires_in),
      }
    },
  },

  async createIntent({ amount, chargeId, method, credentials, customer, timezone }) {
    // O registry já barrou método fora de `descriptor.methods`. A guarda aqui é
    // contra o próximo método suportado entrar no catálogo antes de a
    // implementação existir — que foi exatamente como `boleto` chegou a ser
    // aceito e virar PIX em silêncio.
    if (method !== 'pix') {
      throw new Error(`Mercado Pago: método ${method} não implementado`)
    }

    // O MP quer nome e sobrenome separados; o cadastro tem um campo só.
    const parts = (customer.name ?? '').trim().split(/\s+/).filter(Boolean)
    const firstName = parts[0] || 'Cliente'
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : firstName

    try {
      const charge = await createPixCharge({
        amount,
        billingId: chargeId,
        customerEmail: customer.email ?? 'cliente@gomoto.app',
        customerFirstName: firstName,
        customerLastName: lastName,
        customerCpf: customer.document,
        accessToken: accessTokenOf(credentials),
        timezone: timezone ?? null,
      })

      return {
        providerIntentId: charge.mp_payment_id,
        expiresAt: charge.expires_at,
        payload: {
          // Campo canônico do Pix, comum a todo provedor (ADR 0031 §4): é dele
          // que o app do cliente desenha o QR. `qr_code_base64` continua sendo
          // gravado porque o MP o oferece, mas nada depende dele — a Cora não
          // devolve imagem nenhuma.
          emv: charge.qr_code,
          qr_code: charge.qr_code,
          qr_code_base64: charge.qr_code_base64,
        },
      }
    } catch (err) {
      // Token expirado (o do MP dura 180 dias) vira erro com nome, para a rota
      // poder dizer "reconecte a conta" em vez de "tente novamente".
      if (err instanceof MercadoPagoAuthError) {
        throw new ProviderAuthError('mercadopago', err.message)
      }
      throw err
    }
  },

  async cancelIntent({ providerIntentId, credentials }) {
    try {
      await cancelPayment(providerIntentId, accessTokenOf(credentials))
    } catch (err) {
      if (err instanceof MercadoPagoAuthError) {
        throw new ProviderAuthError('mercadopago', err.message)
      }
      throw err
    }
  },
}
