/**
 * Segredo e URL de retorno do OAuth de gateways (ADR 0030).
 *
 * O state do OAuth era assinado com `MERCADOPAGO_CLIENT_SECRET`. Funcionava com
 * um provedor só, mas mistura dois papéis: o segredo que autentica o GoMoto
 * PERANTE o Mercado Pago virou também a chave que prova que um retorno de OAuth
 * é nosso. Com N gateways seriam N chaves para a mesma função, e vazar a de um
 * provedor permitiria forjar o retorno de qualquer outro.
 *
 * Aqui a chave é da aplicação, não do provedor.
 */

/**
 * Chave HS256 do state.
 *
 * Reusa `SUPABASE_SERVICE_ROLE_KEY` como fallback deliberado: é um segredo
 * server-side que todo ambiente já tem configurado, o que evita que a
 * integração quebre em produção por uma variável esquecida. `GATEWAY_OAUTH_SECRET`
 * é o caminho preferido quando se quer rotacionar uma sem a outra.
 */
export function oauthStateSecret(): Uint8Array {
  const secret = process.env.GATEWAY_OAUTH_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Missing env var: GATEWAY_OAUTH_SECRET')
  return new TextEncoder().encode(secret)
}

/**
 * URL de retorno registrada no painel do provedor.
 *
 * Derivada de uma base única em vez de uma variável por gateway
 * (`MERCADOPAGO_REDIRECT_URI`): somar um provedor deixa de exigir env nova, e
 * a URL não pode divergir do que a rota realmente atende.
 */
export function oauthRedirectUri(providerId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base) throw new Error('Missing env var: NEXT_PUBLIC_APP_URL')
  return `${base.replace(/\/+$/, '')}/api/auth/gateway/${providerId}/callback`
}
