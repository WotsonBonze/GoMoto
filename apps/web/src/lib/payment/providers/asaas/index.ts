/**
 * Asaas como implementação de `PaymentProvider` (ADR 0037).
 *
 * Quarto gateway e o primeiro por CHAVE DE API. O que o distingue dos outros
 * três é a cobrança: um Pix com vencimento (`cobv`) com a multa e os juros da
 * locadora embutidos, calculados pelo banco do pagador no dia em que ele paga.
 * É o único dos quatro em que um código guardado e pago depois ainda cobra o
 * encargo (ADR 0038).
 */

import { findPaymentProvider } from '@gomoto/core'
import type { PaymentProvider, ProviderCredentials } from '../../types'
import { codedError, ProviderAuthError } from '../../types'
import {
  acceptedEnvironment, AsaasAuthError, AsaasKeyRejectedError, createPixCharge, deleteCharge,
  deleteWebhook, ensureWebhook, environmentOfKey, fetchAccount, findOrCreateCustomer,
  keyCanWithdraw, type AsaasEnvironment,
} from './api'

const descriptor = findPaymentProvider('asaas')!

/** Formato gravado no Vault. */
type AsaasCredentials = {
  api_key: string
  environment: AsaasEnvironment
  /** O webhook que a conexão criou ou reaproveitou. */
  webhook_id: string | null
}

function connOf(credentials: ProviderCredentials): { apiKey: string; environment: AsaasEnvironment } {
  const c = credentials as Partial<AsaasCredentials>
  if (typeof c.api_key !== 'string' || !c.api_key || (c.environment !== 'production' && c.environment !== 'sandbox')) {
    throw new ProviderAuthError('asaas', 'Credencial do Asaas ausente ou malformada')
  }
  return { apiKey: c.api_key, environment: c.environment }
}

/** 401 do Asaas vira o erro que as rotas traduzem para "reconecte a conta". */
async function authed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AsaasAuthError) throw new ProviderAuthError('asaas', err.message)
    throw err
  }
}

export const asaasProvider: PaymentProvider = {
  descriptor,

  apiKey: {
    async connect(rawKey) {
      const apiKey = rawKey.trim()
      const environment = environmentOfKey(apiKey)
      if (!environment) {
        throw new AsaasKeyRejectedError(
          'Isto não parece uma chave de API do Asaas. Ela começa com $aact_prod_ (ou $aact_hmlg_ no sandbox).',
        )
      }
      if (environment !== acceptedEnvironment()) {
        throw new AsaasKeyRejectedError(
          environment === 'sandbox'
            ? 'Esta é uma chave de SANDBOX. Use a chave de produção da sua conta Asaas.'
            : 'Esta é uma chave de PRODUÇÃO, e este ambiente só aceita chave de sandbox.',
        )
      }

      const conn = { apiKey, environment }

      let account
      try {
        account = await fetchAccount(conn)
      } catch (err) {
        if (err instanceof AsaasAuthError) {
          throw new AsaasKeyRejectedError(`O Asaas recusou a chave: ${err.message}`)
        }
        throw err
      }

      // O GoMoto só guarda chave que provadamente NÃO tira dinheiro da conta
      // (ADR 0037, decisão 1). A chave padrão do Asaas já nasce assim.
      if (await keyCanWithdraw(conn)) {
        throw new AsaasKeyRejectedError(
          'Esta chave tem permissão de saque/transferência. Por segurança o GoMoto não a aceita: '
          + 'crie uma chave nova no Asaas sem habilitar "saque via API" e cole aqui.',
        )
      }

      const webhookId = await ensureWebhook(conn, account.email)

      const credentials: AsaasCredentials = { api_key: apiKey, environment, webhook_id: webhookId }
      return { externalAccountId: account.walletId, accountLabel: account.label, credentials }
    },
  },

  async disconnect(credentials) {
    const webhookId = (credentials as Partial<AsaasCredentials>).webhook_id
    if (!webhookId) return
    await authed(() => deleteWebhook(connOf(credentials), webhookId))
  },

  async createIntent({ amount, chargeId, method, credentials, customer, lateCharge }) {
    if (method !== 'pix') throw new Error(`Asaas: método ${method} não implementado`)

    // Sem os termos, o código quitaria a dívida sem encargo para sempre — o
    // defeito que este gateway existe para não ter. Falhar é o certo.
    if (!lateCharge) throw new Error('Asaas: termos de multa e juros ausentes')
    if (lateCharge.value !== amount) {
      throw new Error(`Asaas: valor ${amount} diverge dos termos (${lateCharge.value})`)
    }

    // O Asaas exige pagador com documento.
    if (!customer.document) {
      throw codedError(
        'CONFLICT',
        'O Asaas exige CPF ou CNPJ do cliente. Complete o cadastro do cliente para gerar o Pix.',
      )
    }

    const conn = connOf(credentials)

    // A trava de ambiente da CONEXÃO não basta: uma conta conectada com chave de
    // sandbox continua gravada depois que o deploy vira produção, e geraria Pix
    // que nenhum banco paga — ou, pago no sandbox, "quitaria" uma dívida real.
    if (conn.environment !== acceptedEnvironment()) {
      throw codedError(
        'GATEWAY_UNAUTHORIZED',
        conn.environment === 'sandbox'
          ? 'A conta Asaas conectada é de SANDBOX. Reconecte com a chave de produção em Configurações.'
          : 'A conta Asaas conectada é de PRODUÇÃO, e este ambiente só aceita sandbox. Reconecte em Configurações.',
      )
    }

    return authed(async () => {
      const customerId = await findOrCreateCustomer(conn, {
        name: customer.name?.trim() || 'Cliente',
        document: customer.document!,
        email: customer.email,
      })

      const charge = await createPixCharge(conn, {
        customerId,
        value: lateCharge.value,
        dueDate: lateCharge.dueDate,
        fine: lateCharge.fine,
        monthlyInterestPercent: lateCharge.monthlyInterestPercent,
        // Marca de origem: o webhook recebe TUDO da conta da locadora, e é por
        // aqui que ele separa "cobrança do GoMoto sem intent" (erro, dinheiro
        // sem dono) de "cobrança que a locadora emitiu fora" (ignorar).
        externalReference: `gomoto:${chargeId}`,
        description: `Cobrança ${chargeId.slice(0, 8)}`,
      })

      return {
        providerIntentId: charge.id,
        // O `cobv` vale vencimento + 12 meses e soma o encargo sozinho; não há
        // motivo para o GoMoto trocar o código por passar o dia.
        expiresAt: null,
        payload: {
          emv: charge.emv,
          qr_code: charge.emv,
          ...(charge.qrImageBase64 ? { qr_code_base64: charge.qrImageBase64 } : {}),
          invoice_url: charge.invoiceUrl,
        },
      }
    })
  },

  async cancelIntent({ providerIntentId, credentials }) {
    await authed(() => deleteCharge(connOf(credentials), providerIntentId))
  },
}
