/**
 * Retorno do OAuth de um gateway de pagamento (ADR 0030).
 *
 * Substitui `/api/auth/mercadopago/callback`, que era uma rota por provedor.
 * O provedor vem do path e é resolvido pelo registry; nada aqui sabe o que é
 * Mercado Pago.
 *
 * Duas correções de fundo em relação à versão anterior:
 *
 * 1. A escrita passa por `fn_connect_provider_account`. O upsert direto rodava
 *    como `authenticated`, que NÃO tem INSERT nesta tabela desde a migration da
 *    Spec 0014 — conectar gateway falhava com `permission denied` e o usuário
 *    via um `?payment=error&reason=db_error` que não dizia nada (G-01).
 * 2. Conta e credencial são gravadas na MESMA transação. Antes eram duas
 *    chamadas: falha entre elas deixava conta ativa sem segredo, e a próxima
 *    cobrança dizia "integração não configurada" apontando para o lugar errado.
 */

import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { getOAuthProvider } from '@/lib/payment/registry'
import { oauthStateSecret } from '@/lib/payment/oauth-state'
import { revalidatePath } from 'next/cache'

const REDIRECT_BASE = '/configuracoes/pagamentos'

type RouteContext = { params: Promise<{ provider: string }> }

function serverLog(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

function back(req: NextRequest, params: Record<string, string>) {
  const url = new URL(REDIRECT_BASE, req.url)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { provider: providerId } = await ctx.params
  const { searchParams } = req.nextUrl

  if (searchParams.get('error') === 'access_denied') {
    serverLog('info', 'gateway_oauth.cancelled', { provider: providerId })
    return back(req, { payment: 'cancelled' })
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    serverLog('warn', 'gateway_oauth.error', {
      provider: providerId, reason: 'missing_params', has_code: !!code, has_state: !!state,
    })
    return back(req, { payment: 'error', reason: 'missing_params' })
  }

  let oauth
  try {
    oauth = getOAuthProvider(providerId).oauth
  } catch {
    serverLog('warn', 'gateway_oauth.error', { provider: providerId, reason: 'unknown_provider' })
    return back(req, { payment: 'error', reason: 'unknown_provider' })
  }

  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) {
    serverLog('warn', 'gateway_oauth.error', { provider: providerId, reason: 'no_tenant' })
    return NextResponse.redirect(new URL('/login', req.url))
  }

  let secret: Uint8Array
  try {
    secret = oauthStateSecret()
  } catch {
    serverLog('error', 'gateway_oauth.error', {
      provider: providerId, reason: 'misconfiguration', tenant_id: tenantId,
    })
    return back(req, { payment: 'error', reason: 'misconfiguration' })
  }

  // O state amarra o retorno ao tenant e ao provedor que INICIARAM o fluxo.
  // Sem a checagem de provedor, um state válido de um gateway serviria para
  // gravar credencial em outro.
  try {
    const { payload } = await jwtVerify(state, secret)
    if (payload.tenant_id !== tenantId) throw new Error('tenant mismatch')
    if (payload.provider !== providerId) throw new Error('provider mismatch')
  } catch (err) {
    serverLog('warn', 'gateway_oauth.error', {
      provider: providerId, reason: 'state_mismatch', tenant_id: tenantId, detail: String(err),
    })
    return back(req, { payment: 'error', reason: 'state_mismatch' })
  }

  let connection
  try {
    connection = await oauth.exchangeCode(code)
  } catch (err) {
    serverLog('error', 'gateway_oauth.error', {
      provider: providerId, reason: 'token_exchange', tenant_id: tenantId, detail: String(err),
    })
    return back(req, { payment: 'error', reason: 'token_exchange' })
  }

  // Conta + segredo numa transação, com checagem de Owner e de tenant dentro do
  // banco. `authenticated` não escreve nesta tabela e não deve escrever: a
  // linha aponta para uma credencial que movimenta dinheiro.
  const { data, error } = await supabase.rpc('fn_connect_provider_account', {
    p_tenant_id: tenantId,
    p_provider: providerId,
    p_external_account_id: connection.externalAccountId,
    p_account_label: connection.accountLabel,
    p_credentials: connection.credentials,
  })

  if (error) {
    // Outra conta do mesmo provedor com uma integração viva: o banco recusa
    // (ADR 0039) e a tela orienta a excluir a atual.
    const reason = error.message.includes('GATEWAY_OWNER_ONLY') ? 'forbidden'
      : error.message.includes('GATEWAY_PROVIDER_ALREADY_CONNECTED') ? 'other_account'
      : 'db_error'
    serverLog('error', 'gateway_oauth.error', {
      provider: providerId, reason, tenant_id: tenantId, db_code: error.code, detail: error.message,
    })
    return back(req, { payment: 'error', reason })
  }

  const result = (Array.isArray(data) ? data[0] : data) as { account_id: string; elected: boolean } | null

  serverLog('info', 'gateway_oauth.connected', {
    provider: providerId, tenant_id: tenantId,
    external_account_id: connection.externalAccountId, elected: result?.elected ?? false,
  })

  // Sem `logAction`: a trilha da integração é escrita pelo banco, por trigger,
  // na mesma transação da conexão (ADR 0039).

  revalidatePath(REDIRECT_BASE)
  // `elected: false` significa que o tenant já tinha outro gateway cobrando.
  // A tela precisa dizer isso — conectar não troca quem recebe o dinheiro.
  return back(req, {
    payment: 'connected',
    provider: providerId,
    elected: String(result?.elected ?? false),
  })
}
