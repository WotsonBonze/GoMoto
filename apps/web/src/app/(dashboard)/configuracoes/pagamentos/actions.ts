'use server'

import { SignJWT } from 'jose'
import { ProviderIdSchema, findPaymentProvider } from '@gomoto/core'
import { requireTenantOwner } from '@/lib/auth/tenant'
import { getApiKeyProvider, getOAuthProvider, PROVIDER_REGISTRY } from '@/lib/payment/registry'
import { AsaasKeyRejectedError } from '@/lib/payment/providers/asaas/api'
import { resolveCredentials } from '@/lib/payment/credentials'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  verifyHandle, normalizeHandle, isValidHandleFormat, InfinitePayHandleError,
} from '@/lib/payment/providers/infinitepay/api'
import { oauthStateSecret } from '@/lib/payment/oauth-state'
import { revalidatePath } from 'next/cache'

type ActionError = { code: string; message: string }
type ActionFail = { ok: false; error: ActionError }
/** Ação sem retorno. */
type ActionResult = { ok: true } | ActionFail
/** Ação com retorno: `data` é obrigatório no sucesso, não opcional — foi por ser
 *  opcional que a tela precisava checar `!result.data` e perdia o narrowing. */
type ActionData<T> = { ok: true; data: T } | ActionFail

/**
 * Gateway de pagamento é restrito a Tenant Owner: conectar, trocar o gateway
 * ativo ou desconectar decide para onde vai o dinheiro de toda a empresa.
 *
 * O guard aqui esconde a seção de quem não pode; a checagem que VALE é a do
 * banco, dentro de `fn_assert_gateway_owner`. Guard de dinheiro que mora só na
 * aplicação é guard que some no primeiro caminho novo.
 */
async function getOwnerTenant() {
  try {
    return await requireTenantOwner()
  } catch (err) {
    const code = err instanceof Error && err.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHORIZED'
    return { error: code as 'FORBIDDEN' | 'UNAUTHORIZED' }
  }
}

function ownerError(code: 'FORBIDDEN' | 'UNAUTHORIZED', acao: string): ActionError {
  return {
    code,
    message: code === 'FORBIDDEN'
      ? `Apenas o Owner da empresa pode ${acao}`
      : 'Não autorizado',
  }
}

/**
 * Traduz o erro que veio do banco.
 *
 * As RPCs de gateway levantam nomes estáveis (`GATEWAY_OWNER_ONLY`,
 * `GATEWAY_ACCOUNT_INACTIVE`) justamente para a tela poder dizer o que houve.
 * Cair no genérico é o último recurso, não o primeiro.
 */
function gatewayError(message: string): ActionError {
  if (message.includes('GATEWAY_OWNER_ONLY') || message.includes('GATEWAY_WRONG_TENANT')) {
    return { code: 'FORBIDDEN', message: 'Apenas o Owner da empresa pode alterar o gateway de pagamento' }
  }
  if (message.includes('GATEWAY_ACCOUNT_NOT_FOUND')) {
    return { code: 'NOT_FOUND', message: 'Conta de gateway não encontrada' }
  }
  if (message.includes('GATEWAY_PROVIDER_ALREADY_CONNECTED')) {
    return {
      code: 'CONFLICT',
      message: 'Já existe uma integração deste gateway com outra conta. Para usar outra conta, exclua a integração atual primeiro.',
    }
  }
  if (message.includes('GATEWAY_DISCONNECT_FIRST')) {
    return { code: 'CONFLICT', message: 'Desconecte a integração antes de excluí-la' }
  }
  if (message.includes('GATEWAY_ACCOUNT_INACTIVE')) {
    return { code: 'CONFLICT', message: 'Reconecte esta conta antes de ativá-la' }
  }
  console.error('[gateway] erro não mapeado:', message)
  return { code: 'INTERNAL', message: 'Não foi possível concluir a operação' }
}

/**
 * Inicia a conexão OAuth de um gateway.
 *
 * O `state` amarra tenant + provedor e é assinado com chave da aplicação
 * (ver `oauth-state.ts`), não com o segredo do provedor.
 */
export async function connectGatewayAction(providerId: unknown): Promise<ActionData<{ authUrl: string }>> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'conectar um gateway de pagamento') }

  const parsed = ProviderIdSchema.safeParse(providerId)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: 'Provedor inválido' } }

  let oauth
  try {
    oauth = getOAuthProvider(parsed.data).oauth
  } catch (err) {
    return { ok: false, error: { code: 'CONFLICT', message: (err as Error).message } }
  }

  let stateJwt: string
  try {
    stateJwt = await new SignJWT({ tenant_id: ctx.tenantId, provider: parsed.data, nonce: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(oauthStateSecret())
  } catch {
    return { ok: false, error: { code: 'INTERNAL', message: 'Integração não configurada' } }
  }

  try {
    return { ok: true, data: { authUrl: oauth.buildAuthUrl(stateJwt) } }
  } catch (err) {
    // `buildAuthUrl` lê env do provedor. Faltando, a mensagem tem que dizer que
    // é configuração do servidor — não "tente novamente".
    console.error('[gateway] buildAuthUrl falhou:', err)
    return { ok: false, error: { code: 'INTERNAL', message: 'Integração não configurada. Contate o suporte.' } }
  }
}

/**
 * Conecta um gateway cuja credencial é um HANDLE (ADR 0032).
 *
 * Não é o caminho OAuth com outro nome. Lá o provedor autentica o tenant e nos
 * devolve a identidade da conta; aqui o operador DIGITA um nome de usuário
 * público e nada na API prova que ele é o dono. O risco não é vazamento, é
 * digitação: um handle errado manda o aluguel para a conta de um estranho, em
 * silêncio e para sempre.
 *
 * Por isso o handle é SONDADO contra a API antes de virar linha no banco. A
 * sonda não prova posse — nada prova — mas mata os dois erros que de fato
 * acontecem (handle inexistente e Checkout Externo desligado) enquanto o
 * operador ainda está olhando para o campo, em vez de na primeira cobrança de
 * um cliente real.
 */
export async function connectGatewayWithHandleAction(
  providerId: unknown,
  rawHandle: unknown,
): Promise<ActionData<{ accountId: string; handle: string; checkoutUrl: string }>> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'conectar um gateway de pagamento') }

  const parsed = ProviderIdSchema.safeParse(providerId)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: 'Provedor inválido' } }

  const descriptor = findPaymentProvider(parsed.data)
  if (!descriptor || descriptor.connectionMode !== 'handle') {
    return { ok: false, error: { code: 'CONFLICT', message: 'Este gateway não se conecta por InfiniteTag' } }
  }

  if (typeof rawHandle !== 'string') {
    return { ok: false, error: { code: 'VALIDATION', message: 'Informe a sua InfiniteTag' } }
  }

  const handle = normalizeHandle(rawHandle)
  if (!isValidHandleFormat(handle)) {
    return { ok: false, error: { code: 'VALIDATION', message: 'InfiniteTag em formato inválido' } }
  }

  // A sonda vem ANTES da escrita. Gravar primeiro e validar depois deixaria o
  // tenant com um gateway conectado que não cobra — o estado que a ADR 0030 foi
  // escrita para acabar.
  let checkoutUrl: string
  try {
    const probe = await verifyHandle(handle)
    checkoutUrl = probe.checkoutUrl
  } catch (err) {
    if (err instanceof InfinitePayHandleError) {
      return { ok: false, error: { code: 'VALIDATION', message: err.message } }
    }
    console.error('[gateway] sonda de handle falhou:', err)
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'Não foi possível falar com a InfinitePay agora. Tente de novo.' },
    }
  }

  // O Vault guarda o handle mesmo ele não sendo segredo. É deliberado: manter
  // um único caminho de credencial (`fn_provider_credentials`) vale mais que
  // economizar uma ida ao Vault, e a coluna `external_account_id` continua
  // sendo a identidade que o webhook procura.
  const { data, error } = await ctx.supabase.rpc('fn_connect_provider_account', {
    p_tenant_id: ctx.tenantId,
    p_provider: parsed.data,
    p_external_account_id: handle,
    p_account_label: `$${handle}`,
    p_credentials: { handle },
  })

  if (error) return { ok: false, error: gatewayError(error.message) }

  const conta = (Array.isArray(data) ? data[0] : data) as { account_id: string } | null
  if (!conta?.account_id) {
    return { ok: false, error: { code: 'INTERNAL', message: 'Não foi possível concluir a operação' } }
  }

  revalidatePath('/configuracoes/pagamentos')
  // `accountId` volta para a tela poder oferecer o desfazer imediato: se o link
  // de conferência não abrir a loja do operador, desconectar é um clique, não
  // uma caçada na lista.
  return { ok: true, data: { accountId: conta.account_id, handle, checkoutUrl } }
}

/**
 * Conecta um gateway cuja credencial é uma CHAVE DE API (ADR 0037).
 *
 * A chave é um segredo de verdade — ao contrário do handle da InfinitePay —, e
 * a sonda do provedor vem antes de qualquer escrita: identidade da conta,
 * recusa de chave com permissão de saque e criação do webhook. Se a gravação
 * falhar depois disso, o que foi criado no provedor é desfeito.
 *
 * A chave não volta para a tela, não vai para o `logAction` e não aparece em
 * mensagem de erro.
 */
export async function connectGatewayWithApiKeyAction(
  providerId: unknown,
  rawKey: unknown,
): Promise<ActionData<{ accountId: string; label: string | null }>> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'conectar um gateway de pagamento') }

  const parsed = ProviderIdSchema.safeParse(providerId)
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: 'Provedor inválido' } }

  let impl
  try {
    impl = getApiKeyProvider(parsed.data)
  } catch {
    return { ok: false, error: { code: 'CONFLICT', message: 'Este gateway não se conecta por chave de API' } }
  }

  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Informe a chave de API' } }
  }

  let connection
  try {
    connection = await impl.apiKey.connect(rawKey)
  } catch (err) {
    if (err instanceof AsaasKeyRejectedError) {
      return { ok: false, error: { code: 'VALIDATION', message: err.message } }
    }
    console.error(`[gateway] conexão por chave falhou (${parsed.data}):`, err instanceof Error ? err.message : err)
    return {
      ok: false,
      error: { code: 'INTERNAL', message: `Não foi possível falar com ${impl.descriptor.label} agora. Tente de novo.` },
    }
  }

  const { data, error } = await ctx.supabase.rpc('fn_connect_provider_account', {
    p_tenant_id: ctx.tenantId,
    p_provider: parsed.data,
    p_external_account_id: connection.externalAccountId,
    p_account_label: connection.accountLabel,
    p_credentials: connection.credentials,
  })

  const conta = (Array.isArray(data) ? data[0] : data) as { account_id: string } | null

  if (error || !conta?.account_id) {
    // Nada ficou do nosso lado; o webhook criado lá não pode ficar apontando
    // para uma conexão que não existe — a não ser que outra conta ativa use a
    // mesma carteira (reconexão, ou a mesma conta em outro tenant).
    if (!(await walletInUseElsewhere(parsed.data, connection.externalAccountId, null))) {
      await impl.provider.disconnect?.(connection.credentials).catch((e: unknown) => {
        console.error('[gateway] desfazer conexão no provedor falhou:', e instanceof Error ? e.message : e)
      })
    }
    return { ok: false, error: error ? gatewayError(error.message) : { code: 'INTERNAL', message: 'Não foi possível concluir a operação' } }
  }

  revalidatePath('/configuracoes/pagamentos')
  return { ok: true, data: { accountId: conta.account_id, label: connection.accountLabel } }
}

/**
 * Outra integração NÃO EXCLUÍDA, de qualquer tenant, usa a mesma conta no provedor?
 *
 * Com `service_role` de propósito: a RLS esconderia os outros tenants, e é
 * justamente deles que se precisa saber. O Asaas guarda um webhook por URL e
 * a reconexão o reaproveita — apagá-lo porque UM tenant desconectou cortaria
 * a confirmação de pagamento do outro.
 */
async function walletInUseElsewhere(
  provider: string,
  externalAccountId: string,
  exceptAccountId: string | null,
): Promise<boolean> {
  let q = createAdminClient()
    .from('payment_provider_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('provider', provider)
    .eq('external_account_id', externalAccountId)
    // Não excluída, e não "ativa": uma conta DESCONECTADA ainda depende do
    // webhook para baixar o pagamento de um código já enviado (ADR 0039).
    .is('deleted_at', null)
  if (exceptAccountId) q = q.neq('id', exceptAccountId)
  const { count, error } = await q
  // Na dúvida, NÃO apaga: webhook sobrando é inofensivo; faltando, perde dinheiro.
  if (error) return true
  return (count ?? 0) > 0
}

/**
 * Elege qual gateway gera as cobranças.
 *
 * O tenant pode ter vários conectados; exatamente um cobra. A troca é ato
 * explícito — conectar um gateway novo nunca redireciona o dinheiro sozinho.
 */
export async function setDefaultGatewayAction(accountId: unknown): Promise<ActionResult> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'trocar o gateway de pagamento') }

  if (typeof accountId !== 'string' || !accountId) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Conta inválida' } }
  }

  const { error } = await ctx.supabase.rpc('fn_set_default_provider_account', { p_account_id: accountId })
  if (error) return { ok: false, error: gatewayError(error.message) }

  revalidatePath('/configuracoes/pagamentos')
  return { ok: true }
}

/**
 * Desconecta: o gateway deixa de gerar cobranças (ADR 0039).
 *
 * REVERSÍVEL, e por isso nada é desfeito no provedor: a credencial e o webhook
 * ficam, para que um código já enviado ao cliente e pago depois ainda seja
 * conferido e baixe a cobrança. Remover o webhook aqui — como a primeira versão
 * do Asaas fazia — deixava esse pagamento sem aviso nenhum.
 *
 * Sem `logAction`: a trilha é do banco, por trigger (ADR 0039).
 */
export async function disconnectGatewayAction(accountId: unknown): Promise<ActionResult> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'desconectar um gateway de pagamento') }

  if (typeof accountId !== 'string' || !accountId) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Conta inválida' } }
  }

  const { error } = await ctx.supabase.rpc('fn_disconnect_provider_account', { p_account_id: accountId })
  if (error) return { ok: false, error: gatewayError(error.message) }

  revalidatePath('/configuracoes/pagamentos')
  return { ok: true }
}

/**
 * Exclui uma integração DESCONECTADA — irreversível (ADR 0039).
 *
 * A metade no provedor vem PRIMEIRO, enquanto a credencial existe: cancelar os
 * códigos ainda não pagos (best-effort; a InfinitePay não oferece) e desfazer o
 * que a conexão criou lá (o webhook do Asaas). Depois a RPC apaga a credencial
 * do Vault e marca a linha como excluída, numa transação.
 *
 * A tela avisou: um código pago depois disto não baixa sozinho.
 */
export async function deleteGatewayAction(
  accountId: unknown,
): Promise<ActionData<{ canceledAtProvider: number; notCanceled: number }>> {
  const ctx = await getOwnerTenant()
  if ('error' in ctx) return { ok: false, error: ownerError(ctx.error, 'excluir um gateway de pagamento') }

  if (typeof accountId !== 'string' || !accountId) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Conta inválida' } }
  }

  const { data: row } = await ctx.supabase
    .from('payment_provider_accounts')
    .select('id, provider, external_account_id, active')
    .eq('id', accountId)
    .eq('tenant_id', ctx.tenantId)
    .is('deleted_at', null)
    .maybeSingle()
  const account = row as { id: string; provider: string; external_account_id: string; active: boolean } | null

  if (!account) return { ok: false, error: { code: 'NOT_FOUND', message: 'Integração não encontrada' } }
  // A RPC também recusa; conferir antes evita cancelar códigos no provedor de
  // uma integração que não vai ser excluída.
  if (account.active) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Desconecte a integração antes de excluí-la' } }
  }

  const impl = PROVIDER_REGISTRY[account.provider]
  const credentials = impl ? await resolveCredentials(account, impl).catch(() => null) : null

  let canceledAtProvider = 0
  let notCanceled = 0

  if (impl && credentials) {
    const { data: intents } = await ctx.supabase
      .from('payment_intents')
      .select('id, provider_intent_id')
      .eq('provider_account_id', account.id)
      .in('status', ['pending', 'expired'])
      .not('provider_intent_id', 'is', null)
      .limit(500)

    for (const it of (intents ?? []) as { id: string; provider_intent_id: string }[]) {
      if (!impl.cancelIntent) { notCanceled++; continue }
      try {
        await impl.cancelIntent({ providerIntentId: it.provider_intent_id, credentials })
        canceledAtProvider++
      } catch (e) {
        // Já pago, já cancelado, provedor fora: nunca bloqueia a exclusão.
        notCanceled++
        console.warn('[gateway] cancelar código na exclusão falhou:', it.id, e instanceof Error ? e.message : e)
      }
    }

    if (impl.disconnect && !(await walletInUseElsewhere(account.provider, account.external_account_id, account.id))) {
      await impl.disconnect(credentials).catch((e: unknown) => {
        console.error('[gateway] limpeza no provedor falhou:', e instanceof Error ? e.message : e)
      })
    }
  }

  const { error } = await ctx.supabase.rpc('fn_delete_provider_account', { p_account_id: account.id })
  if (error) return { ok: false, error: gatewayError(error.message) }

  revalidatePath('/configuracoes/pagamentos')
  return { ok: true, data: { canceledAtProvider, notCanceled } }
}

