/**
 * Credencial de gateway: leitura e renovação (ADR 0031).
 *
 * O access_token da Cora vale 24 HORAS. Sem renovação, toda cobrança a partir
 * do segundo dia falha. O do Mercado Pago vale ~180 dias, o que escondeu o
 * problema: `refreshAccessToken` existia sem um único chamador (G-08 da ADR
 * 0030). Este módulo é o chamador que faltava, para os dois.
 *
 * O refresh token da Cora é ROTATIVO — renovar devolve um novo e o anterior
 * sobrevive a no máximo 3 usos. Por isso a renovação é reivindicada no banco
 * antes de acontecer: duas requisições concorrentes renovando gastam a janela
 * de rotação à toa.
 *
 * ADR 0034: este módulo NÃO recebe mais um cliente Supabase do chamador. As
 * quatro RPCs de credencial deixaram de ter grant para `authenticated` — um
 * `viewer` conseguia ler o token da Cora em texto puro pelo navegador —, e
 * receber o cliente por parâmetro era justamente o que fazia chamar isto com a
 * sessão do usuário parecer natural. Agora o papel é do módulo, não da escolha
 * de quem chama.
 */

import type { PaymentProvider, ProviderCredentials } from './types'
import { codedError } from './types'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Renova com folga, não no vencimento.
 *
 * A margem é o que torna a corrida inofensiva: quem perde a reivindicação segue
 * com a credencial atual, que ainda vale por estes 10 minutos. Renovar no
 * vencimento faria o perdedor seguir com um token morto.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000

/** Lease da posse, em segundos. Espelha o default de `fn_claim_credential_refresh`. */
const CLAIM_LEASE_SECONDS = 90

function log(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

/** `expires_at` ISO gravado junto da credencial. Ausente = provedor sem validade conhecida. */
function expiresAt(credentials: ProviderCredentials): number | null {
  const raw = (credentials as { expires_at?: unknown }).expires_at
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

/** Converte `expires_in` (segundos, como todo OAuth devolve) em instante absoluto. */
export function expiresAtFrom(expiresIn: unknown): string | undefined {
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/**
 * Credencial válida da conta, renovando quando estiver perto de vencer.
 *
 * Renovação preguiçosa, na hora de cobrar — não agendada. Um agendador exigiria
 * varrer contas que talvez nunca cobrem, e a Cora encerra a sessão por 60 dias
 * de inatividade de qualquer forma: manter token vivo de conta parada não
 * mantém a conexão viva.
 */
export async function resolveCredentials(
  account: { id: string; provider: string },
  provider: PaymentProvider,
): Promise<ProviderCredentials> {
  // `service_role` porque as RPCs de credencial não atendem mais
  // `authenticated` (ADR 0034 §2.1).
  //
  // Atenção ao que isso move: com `service_role` a checagem de tenant DENTRO
  // das funções não roda — ela existe para barrar o outro tenant quando quem
  // chama é um usuário. Aqui a garantia passa a ser do chamador, e ela é real:
  // `resolveActiveAccount` só devolve conta com `tenant_id = tenantId`, e esse
  // tenant veio de `getCurrentTenantId` no servidor. A conta chega aqui já
  // provada; este módulo não a procura sozinho, de propósito.
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('fn_provider_credentials', { p_account_id: account.id })

  if (error || !data) {
    throw codedError(
      'GATEWAY_UNAUTHORIZED',
      `Credenciais de ${provider.descriptor.label} não configuradas. Reconecte a conta em Configurações.`,
    )
  }

  const current = data as ProviderCredentials
  const refresh = provider.oauth?.refresh
  const deadline = expiresAt(current)

  // Provedor sem renovação, ou credencial sem validade conhecida (o Mercado
  // Pago conectado antes desta mudança): usa o que tem. Um 401 mais adiante
  // vira "reconecte a conta", que é o conselho certo nesse caso.
  if (!refresh || deadline === null) return current
  if (deadline - Date.now() > REFRESH_MARGIN_MS) return current

  const { data: claimed, error: claimError } = await supabase.rpc('fn_claim_credential_refresh', {
    p_account_id: account.id,
    p_lease_seconds: CLAIM_LEASE_SECONDS,
  })

  if (claimError) {
    log('warn', 'credentials.claim_failed', {
      provider: account.provider, account_id: account.id, error: claimError.message,
    })
    return current
  }

  // Outra requisição está renovando. A margem garante que `current` ainda vale.
  if (!claimed) {
    log('info', 'credentials.refresh_in_progress', { provider: account.provider, account_id: account.id })
    return current
  }

  try {
    const renewed = await refresh(claimed as ProviderCredentials)

    const { error: storeError } = await supabase.rpc('fn_store_provider_credentials', {
      p_account_id: account.id,
      p_credentials: renewed,
    })
    if (storeError) throw new Error(storeError.message)

    log('info', 'credentials.refreshed', { provider: account.provider, account_id: account.id })
    return renewed
  } catch (err) {
    // Soltar a posse em vez de esperar o lease vencer: sem isso a próxima
    // tentativa fica bloqueada por até 90s por causa de uma falha de rede.
    await supabase.rpc('fn_release_credential_refresh', { p_account_id: account.id })

    log('error', 'credentials.refresh_failed', {
      provider: account.provider, account_id: account.id, error: String(err),
    })

    // Se o token vigente ainda não venceu, a cobrança pode seguir com ele — a
    // margem existe exatamente para dar esta segunda chance.
    if (deadline > Date.now()) return current

    throw codedError(
      'GATEWAY_UNAUTHORIZED',
      `A conexão com ${provider.descriptor.label} expirou. Reconecte a conta em Configurações.`,
    )
  }
}
