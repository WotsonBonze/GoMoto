/**
 * Criação de tentativa de pagamento no gateway (ADR 0030, sobre ADR 0024).
 *
 * O valor vem de `calculateAmountDue` — a MESMA função do cockpit e do app do
 * cliente. Foi por não ser assim que o cliente com crédito pagava a mais e a
 * cobrança vencida quitava a menos (F-05 da Spec 0014).
 *
 * O provedor vem da conta que o TENANT elegeu, nunca de um `import`. Antes,
 * quem chamava esta função escolhia o gateway e ela ia procurar a conta
 * correspondente; `is_default` existia e não era lido por ninguém. Cadastrar um
 * segundo provedor não mudava o comportamento de cobrança.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateAmountDue, embeddedLateChargeTerms, type LateChargePolicy } from '@gomoto/core'
import { assertMethodSupported, getProvider, PROVIDER_REGISTRY, type ProviderRegistry } from './registry'
import { resolveCredentials } from './credentials'
import { cancelChargeIntents } from './cancel'
import { ensureQrImage } from './qr'
import { fetchTenantTimezone, tenantToday } from './business-time'
import { representsDebt } from './intent-reuse'
import { codedError, ProviderAuthError } from './types'

export type PaymentIntentResult = {
  intent_id: string
  provider: string
  provider_label: string
  method: string
  amount: number
  expires_at: string | null
  payload: Record<string, unknown> | null
  is_reused: boolean
}

type PendingIntentRow = {
  id: string
  provider: string
  method: string
  amount: number
  expires_at: string | null
  payload: Record<string, unknown> | null
}

const PENDING_COLUMNS = 'id, provider, method, amount, expires_at, payload'

/**
 * Devolve a tentativa pendente ainda válida ou cria uma nova.
 *
 * `payment_intents` tem índice único parcial por cobrança enquanto
 * `status = 'pending'`: dois QR ativos para a mesma dívida são impossíveis.
 */
export async function getOrCreateIntent(
  supabase: SupabaseClient,
  params: { tenantId: string; chargeId: string; method?: string | null },
  registry: ProviderRegistry = PROVIDER_REGISTRY,
): Promise<PaymentIntentResult> {
  const { tenantId, chargeId } = params

  // ── 1. Valor devido — fonte única ─────────────────────────────────
  // Calculado ANTES de olhar a tentativa pendente: é ele que diz se o código
  // que o cliente já tem ainda representa a dívida (ADR 0037, decisão 3b).
  const { data: balance, error: balanceError } = await supabase
    .from('charge_balances')
    .select('charge_id, customer_id, due_date, total_amount, paid_amount, open_amount, late_charge_amount, status')
    .eq('charge_id', chargeId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (balanceError) throw codedError('INTERNAL', balanceError.message)
  if (!balance) throw codedError('NOT_FOUND', 'Cobrança não encontrada')

  const b = balance as {
    charge_id: string; customer_id: string; due_date: string
    total_amount: number; paid_amount: number; open_amount: number
    late_charge_amount: number; status: string
  }

  if (b.status !== 'open' || b.open_amount <= 0) {
    throw codedError('CONFLICT', 'Esta cobrança não está em aberto')
  }

  const policy = await resolvePolicy(supabase, tenantId, chargeId)
  // "Hoje" da LOCADORA: o servidor roda em UTC e às 22h de Brasília já estaria
  // no dia seguinte — um dia de encargo a mais aqui, um dia de juros a menos
  // no vencimento mandado ao provedor.
  const timezone = await fetchTenantTimezone(supabase, tenantId)
  const asOf = tenantToday(timezone)
  const due = calculateAmountDue(b, policy, asOf)
  const { amount_due } = due

  if (amount_due <= 0) throw codedError('CONFLICT', 'Nada a cobrar nesta cobrança')

  // ── 2. Tentativa pendente que ainda representa a dívida ───────────
  const { data: existing } = await supabase
    .from('payment_intents')
    .select(PENDING_COLUMNS)
    .eq('charge_id', chargeId)
    .eq('status', 'pending')
    .maybeSingle()

  if (existing) {
    const e = existing as PendingIntentRow
    const stillValid = !e.expires_at || new Date(e.expires_at) > new Date()
    if (stillValid && representsDebt(e, due)) return reuse(e, registry, due.amount_due)

    // Vencida, ou o valor mudou (dia novo de juros, pagamento parcial,
    // desconto). Descarta pelo mesmo caminho do cancelamento da cobrança:
    // cancela no provedor PRIMEIRO, depois expira aqui. Sem isso, o código
    // velho seguiria vivo na mão do cliente quitando a dívida a menor.
    const r = await cancelChargeIntents(supabase, tenantId, chargeId)
    if (r.expiradas === 0) {
      throw codedError('INTERNAL', 'Não foi possível substituir o código de pagamento anterior')
    }
  }

  // ── 3. Qual gateway o tenant elegeu ───────────────────────────────
  // Resolvido antes de ler o cliente e de falar com o provedor: sem gateway
  // eleito nada do resto importa, e a falha sai nomeada.
  const account = await resolveActiveAccount(supabase, tenantId)
  const provider = getProvider(account.provider, registry)

  // Sem método pedido, o meio principal do gateway ELEITO — nunca um literal
  // do chamador. A rota do app e a ação do cockpit escreviam `'pix'` como
  // default, o que só funcionava porque os dois únicos provedores geravam PIX:
  // eleger um gateway de checkout hospedado fazia a cobrança morrer em
  // "InfinitePay não gera cobrança por pix" — a locadora trocou de gateway e o
  // produto respondia acusando ela de pedir a coisa errada.
  const requested = params.method ?? provider.descriptor.methods[0]
  if (!requested) {
    throw codedError('CONFLICT', `${provider.descriptor.label} não declara nenhum meio de cobrança`)
  }
  const method = assertMethodSupported(provider, requested)

  // Gateway que embute multa e juros no código recebe os TERMOS, não um valor
  // congelado: o banco do pagador calcula no dia em que pagar (ADR 0037). Nos
  // demais o valor é o de hoje, e o encargo embutido é só a parte ainda NÃO
  // realizada — realizar o total lançava de novo o encargo que um pagamento
  // parcial ou estorno já tinha documentado (ADR 0028), e a cobrança ficava
  // aberta exatamente nesse valor.
  const terms = provider.descriptor.accruesLateChargesNatively
    ? embeddedLateChargeTerms(b, policy, asOf)
    : null
  const amount = terms ? terms.value : amount_due
  const accruedIncluded = terms ? terms.accruedIncluded : due.accrued_pending

  // Piso do gateway, conferido ANTES de gastar a chamada.
  //
  // A Cora recusa abaixo de R$ 5,00 com um 400 genérico
  // (`services[0].amount must be greater than or equal to 500`), que virava
  // "Não foi possível gerar o Pix. Tente novamente." na tela do operador —
  // conselho inútil, porque o valor da cobrança não muda por tentar de novo.
  //
  // Aqui a mensagem diz o limite e nomeia o gateway, e a decisão sai do
  // provedor específico: qualquer um que declare `minAmount` ganha a guarda.
  if (amount < provider.descriptor.minAmount) {
    throw codedError(
      'CONFLICT',
      `${provider.descriptor.label} não gera cobrança abaixo de `
      + `${provider.descriptor.minAmount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
      + ` — esta cobrança tem ${amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`,
    )
  }

  // ── 4. Credencial ─────────────────────────────────────────────────
  // Não vem na linha da conta: sai do Vault por função que checa o tenant,
  // porque SECURITY DEFINER ignora RLS. E é RENOVADA aqui se estiver perto de
  // vencer — o token da Cora dura 24h, então sem isso a segunda diária de
  // cobranças já falharia (ADR 0031).
  const credentials = await resolveCredentials(account, provider)

  const { data: customer } = await supabase
    .from('customers')
    .select('name, email, cpf, cnpj, company_name, phone, zip_code, street, street_number, complement, neighborhood')
    .eq('id', b.customer_id)
    .maybeSingle()

  const c = (customer ?? null) as {
    name: string | null; email: string | null
    cpf: string | null; cnpj: string | null; company_name: string | null
    phone: string | null; zip_code: string | null; street: string | null
    street_number: string | null; complement: string | null; neighborhood: string | null
  } | null

  // ── 5. Cria no provedor ───────────────────────────────────────────
  let created
  try {
    created = await provider.createIntent({
      amount,
      chargeId,
      method,
      credentials,
      lateCharge: terms,
      timezone,
      // Cliente PJ não tem CPF: o documento é o CNPJ, e o nome que o banco
      // mostra é a razão social. Mandar só `cpf` fazia o provedor que exige
      // documento recusar todo cliente PJ.
      customer: {
        name: c?.company_name || c?.name || null,
        email: c?.email ?? null,
        document: c?.cpf || c?.cnpj || null,
        // Lidos só pela InfinitePay (ver `CreateIntentParams.customer`): o
        // checkout dela pede ao cliente tudo que não chegar aqui.
        phone: c?.phone ?? null,
        address: c ? {
          zip_code: c.zip_code,
          street: c.street,
          street_number: c.street_number,
          complement: c.complement,
          neighborhood: c.neighborhood,
        } : null,
      },
    })
  } catch (err) {
    // Credencial recusada não é "tente novamente": alguém precisa reconectar.
    if (err instanceof ProviderAuthError) {
      throw codedError(
        'GATEWAY_UNAUTHORIZED',
        `A conexão com ${provider.descriptor.label} expirou. Reconecte a conta em Configurações.`,
      )
    }
    throw err
  }

  // O app do cliente desenha o QR a partir de uma imagem. O Mercado Pago a
  // devolve pronta; a Cora devolve só o EMV (o copia-e-cola). Em vez de ensinar
  // o app a desenhar — duas dependências novas no Expo, cujo acoplamento de SDK
  // já quebrou o app antes — a imagem é gerada aqui, uma vez, para qualquer
  // provedor que não a ofereça (ADR 0031 §4).
  const payload = await ensureQrImage(created.payload)

  // Base do código, guardada para o reaproveitamento saber se ele ainda
  // representa a dívida (`representsDebt`).
  if (terms) {
    payload.late_charge_terms = {
      ...terms,
      principal: due.principal,
      realized: due.late_charge_realized,
    }
  }

  // ── 6. Persiste ───────────────────────────────────────────────────
  // Por RPC, não por INSERT: a tabela deixou de aceitar escrita de
  // `authenticated` (ADR 0034 §2.4). A função confere o tenant, e confere
  // também que a cobrança e a conta de gateway pertencem a ele — o que a RLS
  // não fazia, porque ela olhava só a linha sendo inserida.
  const { data: intent, error } = await supabase.rpc('fn_open_payment_intent', {
    p_tenant_id: tenantId,
    p_charge_id: chargeId,
    p_provider: account.provider,
    p_provider_account_id: account.id,
    p_method: method,
    p_provider_intent_id: created.providerIntentId,
    p_amount: amount,
    // Quanto deste QR é encargo AINDA NÃO REALIZADO. A confirmação o realiza
    // antes de alocar — sem isso o cliente paga principal + encargo, a
    // cobrança só deve o principal, e o saldo fica NEGATIVO com o encargo
    // nunca virando receita. Guardar em vez de recalcular na confirmação:
    // entre gerar o código e o cliente pagar passam horas, e um recálculo
    // daria outro número, deixando a conta sem fechar.
    //
    // Era `accrued.total`: com encargo já realizado (pagamento parcial,
    // estorno), a confirmação o lançava de novo e a cobrança ficava aberta
    // exatamente nesse valor — reproduzido no banco, R$ 102,73 + 2,80
    // fechando em 105,53 com 2,73 em aberto.
    p_accrued_amount: accruedIncluded,
    p_expires_at: created.expiresAt,
    p_payload: payload,
  })

  // 23505 = `idx_payment_intents_one_pending_per_charge`. Outra requisição para
  // a MESMA dívida chegou primeiro — dois toques no botão do app, uma
  // reconexão, um retry do cliente HTTP. O índice fez o seu trabalho, mas
  // estourar aqui mostra "Falha ao gerar cobrança" a quem já tem um QR válido
  // esperando. O certo é entregar o QR que venceu a corrida.
  //
  // A tentativa criada no provedor por esta chamada fica órfã e expira sozinha;
  // não há como cancelá-la pela interface de provedor, e criar um QR a mais é
  // preferível a cobrar a mesma dívida duas vezes.
  if (error?.code === '23505') {
    const { data: vencedora } = await supabase
      .from('payment_intents')
      .select(PENDING_COLUMNS)
      .eq('charge_id', chargeId)
      .eq('status', 'pending')
      .maybeSingle()

    if (vencedora) return reuse(vencedora as PendingIntentRow, registry, amount_due)
  }

  if (error) throw codedError('INTERNAL', error.message)

  return {
    // A RPC devolve o UUID cru, não uma linha: `RETURNS UUID`.
    intent_id: intent as unknown as string,
    provider: account.provider,
    provider_label: provider.descriptor.label,
    method,
    amount: amount_due,
    expires_at: created.expiresAt,
    payload,
    is_reused: false,
  }
}

/**
 * A conta que o tenant elegeu para cobrar.
 *
 * `is_default AND active` é o par que define "o gateway que cobra" (ADR 0030).
 * O banco garante no máximo um por tenant, e que o eleito esteja ativo — aqui
 * as duas condições são repetidas porque a consulta não deve depender de o
 * invariante nunca ter sido violado por um caminho antigo.
 */
async function resolveActiveAccount(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ id: string; provider: string }> {
  const { data, error } = await supabase
    .from('payment_provider_accounts')
    .select('id, provider')
    .eq('tenant_id', tenantId)
    .eq('is_default', true)
    .eq('active', true)
    .maybeSingle()

  if (error) throw codedError('INTERNAL', error.message)
  if (!data) {
    // Distinta de "credencial expirada": aqui não há gateway escolhido, e o
    // caminho de correção é a tela de Configurações, não uma retentativa.
    throw codedError(
      'FORBIDDEN',
      'Nenhum gateway de pagamento ativo. Configure a integração em Configurações.',
    )
  }

  return data as { id: string; provider: string }
}

/** Tentativa pendente reaproveitada — o QR que o cliente já tem na mão. */
function reuse(row: PendingIntentRow, registry: ProviderRegistry, amountDue: number): PaymentIntentResult {
  // O provedor pode ter sido removido do registry entre a criação e o reuso.
  // O QR continua válido no gateway, então devolvê-lo é o certo; só o rótulo
  // bonito se perde.
  const label = registry[row.provider]?.descriptor.label ?? row.provider

  return {
    intent_id: row.id,
    provider: row.provider,
    provider_label: label,
    method: row.method,
    // O valor devido HOJE. Igual ao do código para quem congela valor (senão
    // ele não seria reaproveitado); para quem embute encargo, o código vale
    // mais a cada dia e o banco do pagador mostra o mesmo que isto.
    amount: amountDue,
    expires_at: row.expires_at,
    payload: row.payload,
    is_reused: true,
  }
}

/** Política fixada na emissão da cobrança — não a vigente hoje (R-08). */
async function resolvePolicy(
  supabase: SupabaseClient,
  tenantId: string,
  chargeId: string,
): Promise<LateChargePolicy | null> {
  const { data: charge } = await supabase
    .from('charges')
    .select('late_charge_policy_id')
    .eq('id', chargeId)
    .maybeSingle()

  const policyId = (charge as { late_charge_policy_id: string | null } | null)?.late_charge_policy_id
  if (!policyId) return null

  const { data } = await supabase
    .from('late_charge_policies')
    .select('fee_type, fee_value, daily_interest_rate, grace_period_days, min_amount')
    .eq('id', policyId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  return (data ?? null) as LateChargePolicy | null
}
