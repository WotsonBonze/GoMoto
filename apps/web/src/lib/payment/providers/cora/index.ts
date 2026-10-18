/**
 * Cora como implementação de `PaymentProvider` (ADR 0031).
 *
 * Segundo gateway do sistema, e a prova de que a fundação da ADR 0030 aguenta:
 * nenhum arquivo fora deste diretório precisou saber que a Cora existe, exceto
 * uma linha no registry e a virada da flag no catálogo.
 */

import { findPaymentProvider } from '@gomoto/core'
import type { PaymentProvider, ProviderConnection, ProviderCredentials } from '../../types'
import { ProviderAuthError } from '../../types'
import { expiresAtFrom } from '../../credentials'
import {
  buildAuthUrl, cancelInvoice, createPixInvoice, exchangeCode, refreshTokens, CoraAuthError,
} from './api'

const descriptor = findPaymentProvider('cora')!

function accessTokenOf(credentials: ProviderCredentials): string {
  const token = (credentials as { access_token?: unknown }).access_token
  if (typeof token !== 'string' || !token) {
    throw new ProviderAuthError('cora', 'Credencial da Cora ausente ou malformada')
  }
  return token
}

/**
 * A Cora exige `due_date` na emissão.
 *
 * O QR é gerado para o valor devido HOJE — principal mais encargo já apurado
 * (ADR 0024). Mandar o vencimento original faria a Cora aplicar juros e multa
 * DELA por cima do encargo que já calculamos, cobrando o atraso duas vezes.
 * Vencimento de hoje: o valor que mandamos é o valor que se paga.
 */
function dueToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export const coraProvider: PaymentProvider = {
  descriptor,

  oauth: {
    buildAuthUrl: (state) => buildAuthUrl(state),

    async exchangeCode(code): Promise<ProviderConnection> {
      const tokens = await exchangeCode(code)

      // A conta autorizada vem nos claims do access token.
      const conta = accountFromToken(tokens.access_token)

      return {
        externalAccountId: conta.businessId,
        accountLabel: conta.cnpj,
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
        throw new ProviderAuthError('cora', 'Sem refresh token — reconecte a conta')
      }

      const tokens = await refreshTokens(refreshToken)

      // O refresh token da Cora é ROTATIVO: o novo tem que ser gravado, senão a
      // renovação seguinte usa um token que já gastou a janela de 3 usos.
      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAtFrom(tokens.expires_in),
      }
    },
  },

  async createIntent({ amount, chargeId, method, credentials, customer }) {
    if (method !== 'pix') {
      throw new Error(`Cora: método ${method} não implementado`)
    }

    try {
      const invoice = await createPixInvoice({
        amount,
        chargeId,
        dueDate: dueToday(),
        customer,
        accessToken: accessTokenOf(credentials),
      })

      const emv = invoice.pix?.emv
      if (!emv) {
        // Invoice sem EMV é cobrança que o cliente não consegue pagar. Falhar
        // aqui evita gravar uma tentativa pendente inútil que ainda ocuparia o
        // índice de "um QR ativo por dívida".
        throw new Error(`Cora devolveu invoice ${invoice.id} sem código Pix`)
      }

      return {
        providerIntentId: invoice.id,
        // A Cora não devolve validade do QR. Sem `expires_at`, a tentativa é
        // reaproveitada até ser paga ou cancelada — que é o comportamento certo
        // para um Pix sem prazo declarado.
        expiresAt: null,
        payload: {
          // Campo canônico do Pix, comum aos dois provedores (ADR 0031 §4).
          emv,
          // Compatibilidade com o app: `qr_code` era o nome que ele lia.
          qr_code: emv,
        },
      }
    } catch (err) {
      if (err instanceof CoraAuthError) {
        throw new ProviderAuthError('cora', err.message)
      }
      throw err
    }
  },

  async cancelIntent({ providerIntentId, credentials }) {
    try {
      await cancelInvoice(providerIntentId, accessTokenOf(credentials))
    } catch (err) {
      if (err instanceof CoraAuthError) {
        throw new ProviderAuthError('cora', err.message)
      }
      throw err
    }
  },
}

/**
 * Identidade da conta autorizada, lida dos claims do access token.
 *
 * **`sub` NÃO serve.** Verificado contra a homologação: `sub` vale
 * `app-1sZTHkFlwIp774snsVEuGG` — o NOSSO client_id, idêntico para todo tenant
 * que autorizar. Usá-lo faria toda locadora compartilhar o mesmo
 * `external_account_id`, e a linha de uma sobrescreveria a da outra na
 * reconexão. Quem identifica a conta é `business_id`.
 *
 * `person_id` também vem, e é a pessoa que autorizou — não é o que queremos:
 * a cobrança vai para a conta da EMPRESA, e o mesmo sócio pode autorizar por
 * mais de uma.
 *
 * Decodifica sem verificar assinatura, de propósito: o token acabou de chegar
 * pelo canal TLS da própria Cora, em resposta a uma requisição autenticada com
 * o nosso client secret. Verificar a assinatura exigiria buscar e cachear o
 * JWKS só para extrair um identificador — e o que esse valor protege é a
 * resolução do tenant no webhook, que NÃO confia nele sozinho: o webhook casa
 * o `webhook-resource-id` com o nosso `payment_intents`.
 */
function accountFromToken(accessToken: string): { businessId: string; cnpj: string | null } {
  const parts = accessToken.split('.')
  if (parts.length !== 3) throw new ProviderAuthError('cora', 'Token da Cora em formato inesperado')

  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      business_id?: unknown
      cnpj?: unknown
    }
    if (typeof claims.business_id !== 'string' || !claims.business_id) {
      throw new Error('sem business_id')
    }
    return {
      businessId: claims.business_id,
      cnpj: typeof claims.cnpj === 'string' && claims.cnpj ? claims.cnpj : null,
    }
  } catch {
    throw new ProviderAuthError('cora', 'Não foi possível identificar a conta Cora no token')
  }
}
