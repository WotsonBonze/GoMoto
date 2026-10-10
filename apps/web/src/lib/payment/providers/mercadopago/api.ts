/**
 * Cliente HTTP do Mercado Pago (ADR 0030).
 *
 * Só fala com a API do MP. Não conhece `payment_intents`, `tenant_id` nem o
 * contrato `PaymentProvider` — quem faz a ponte é `./index.ts`.
 */

/** Credencial recusada pelo provedor. Retentar não resolve; reconectar sim. */
export class MercadoPagoAuthError extends Error {
  constructor(message = 'Credencial do Mercado Pago recusada (401)') {
    super(message)
    this.name = 'MercadoPagoAuthError'
  }
}

const MP_BASE  = 'https://api.mercadopago.com'
const MP_AUTH  = 'https://auth.mercadopago.com.br'
const MP_TOKEN = 'https://api.mercadopago.com'

import { oauthRedirectUri } from '../../oauth-state'
import { endOfTenantDayIso } from '../../business-time'

/** O MP recusa `date_of_expiration` a menos de 30 minutos. */
const MP_MIN_EXPIRATION_MS = 30 * 60 * 1000

const REDIRECT_URI = () => oauthRedirectUri('mercadopago')

function envVar(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

export function buildOAuthUrl(stateJwt: string): string {
  const clientId = envVar('MERCADOPAGO_CLIENT_ID')
  const redirectUri = REDIRECT_URI()
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    platform_id:   'mp',
    redirect_uri:  redirectUri,
    state:         stateJwt,
  })
  return `${MP_AUTH}/authorization?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number | null
  mp_user_id: string
  mp_account_email: string | null
}> {
  const res = await fetch(`${MP_TOKEN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     envVar('MERCADOPAGO_CLIENT_ID'),
      client_secret: envVar('MERCADOPAGO_CLIENT_SECRET'),
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI(),
    }),
  })
  if (res.status === 401) throw new MercadoPagoAuthError('Mercado Pago recusou a troca do código de autorização')
  if (!res.ok) throw new Error(`MP token exchange failed: ${res.status}`)
  const json = await res.json()
  return {
    access_token:     json.access_token,
    refresh_token:    json.refresh_token,
    // ~180 dias no MP. Gravar a validade é o que permite renovar ANTES de
    // falhar, em vez de descobrir pelo 401 (ADR 0031).
    expires_in:       typeof json.expires_in === 'number' ? json.expires_in : null,
    mp_user_id:       String(json.user_id),
    mp_account_email: json.email ?? null,
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number | null
}> {
  const res = await fetch(`${MP_TOKEN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     envVar('MERCADOPAGO_CLIENT_ID'),
      client_secret: envVar('MERCADOPAGO_CLIENT_SECRET'),
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (res.status === 401) throw new MercadoPagoAuthError('Refresh token do Mercado Pago não vale mais')
  if (!res.ok) throw new Error(`MP token refresh failed: ${res.status}`)
  const json = await res.json()
  return {
    access_token:  json.access_token,
    refresh_token: json.refresh_token,
    expires_in:    typeof json.expires_in === 'number' ? json.expires_in : null,
  }
}

export interface PixChargeParams {
  amount: number
  billingId: string
  customerEmail: string
  customerFirstName: string
  customerLastName: string
  /** CPF ou CNPJ — o tipo é deduzido pelo tamanho. */
  customerCpf?: string | null
  accessToken: string
  /** Fuso da locadora: o código vale até o fim do dia DELA. */
  timezone?: string | null
}

export interface PixCharge {
  mp_payment_id: string
  qr_code: string
  qr_code_base64: string
  expires_at: string
}

/** O documento chega como CPF ou CNPJ (cliente PJ); o MP precisa do tipo certo. */
function identificationOf(raw: string): { type: 'CPF' | 'CNPJ'; number: string } {
  const number = raw.replace(/\D/g, '')
  return { type: number.length === 14 ? 'CNPJ' : 'CPF', number }
}

export async function createPixCharge(params: PixChargeParams): Promise<PixCharge> {
  const expiration = endOfTenantDayIso(params.timezone, new Date(), MP_MIN_EXPIRATION_MS)

  const res = await fetch(`${MP_BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${params.accessToken}`,
      // Uma chave por (cobrança, valor, dia). Era só a cobrança: o código novo
      // de um dia seguinte — com o valor atualizado pelos juros — voltava como
      // o pagamento ANTIGO, porque o MP devolve o resultado da primeira
      // requisição para a mesma chave. Dois toques no mesmo minuto continuam
      // caindo na mesma chave, que é o que a idempotência existe para pegar.
      'X-Idempotency-Key': `billing-${params.billingId}-${Math.round(params.amount * 100)}-${expiration.slice(0, 10)}`,
    },
    body: JSON.stringify({
      transaction_amount: params.amount,
      payment_method_id:  'pix',
      external_reference: params.billingId,
      description:      'Cobrança GoMoto',
      notification_url: process.env.MERCADOPAGO_WEBHOOK_URL ?? undefined,
      payer: {
        email:      params.customerEmail,
        first_name: params.customerFirstName,
        last_name:  params.customerLastName,
        ...(params.customerCpf
          ? { identification: identificationOf(params.customerCpf) }
          : {}),
      },
      // Fim do dia da LOCADORA, não 24h corridas: um código gerado às 9h valia
      // até as 9h do dia seguinte, e um código gerado antes do vencimento
      // ainda pagava sem multa no primeiro dia de atraso (ADR 0038, P2).
      date_of_expiration: expiration,
    }),
  })

  if (res.status === 401) throw new MercadoPagoAuthError()
  if (!res.ok) {
    const body = await res.text()
    console.error(`[MP] createPixCharge failed status=${res.status} body=${body}`)
    throw new Error(`MP create pix failed: ${res.status}`)
  }

  const json = await res.json()
  const txInfo = json.point_of_interaction?.transaction_data
  return {
    mp_payment_id:  String(json.id),
    qr_code:        txInfo?.qr_code ?? '',
    qr_code_base64: txInfo?.qr_code_base64 ?? '',
    expires_at:     json.date_of_expiration,
  }
}

/**
 * Cancela o pagamento no Mercado Pago (ADR 0033, Questão 1).
 *
 * `PUT /v1/payments/{id}` com `{"status":"cancelled"}`. Só vale dentro de uma
 * janela de status — `pending`, `in_process`, `authorized`. Fora dela a API
 * recusa, e recusar é o certo: um pagamento aprovado não se cancela, se estorna.
 *
 * Um Pix que já expirou sozinho também sai daqui como erro. Não é problema:
 * quem chama trata qualquer falha como informação, porque o objetivo do
 * cancelamento é reduzir a chance de alguém pagar — e um código expirado já não
 * pode ser pago.
 */
export async function cancelPayment(mpPaymentId: string, accessToken: string): Promise<void> {
  const res = await fetch(`${MP_BASE}/v1/payments/${mpPaymentId}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ status: 'cancelled' }),
  })

  if (res.status === 401 || res.status === 403) {
    throw new MercadoPagoAuthError(`Mercado Pago recusou o token ao cancelar (${res.status})`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MP cancelar pagamento ${mpPaymentId} falhou: ${res.status} ${body.slice(0, 200)}`)
  }
}
