/**
 * Núcleo do webhook de gateway — a parte que não é de nenhum provedor
 * específico (ADR 0030).
 *
 * O padrão INBOX (persiste primeiro, processa depois) e as chamadas de dinheiro
 * viviam dentro de `mercadopago-webhook/index.ts`. Somar um gateway significava
 * copiar ~150 linhas de lógica financeira — confirmação, estorno, idempotência —
 * para outro arquivo, e a segunda cópia divergiria da primeira no primeiro
 * ajuste.
 *
 * Aqui fica o que é igual para todo provedor. O adaptador de cada gateway fica
 * com o que só ele sabe: verificar a assinatura, extrair a referência do evento
 * e traduzir o vocabulário de status dele para `approved | refunded | ignored`.
 *
 * Deno não alcança `packages/core` pelo workspace, então isto mora em `_shared`
 * e não em `@gomoto/core`. É a fronteira real do runtime, não descuido.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export function log(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

/** O que o adaptador do provedor devolve depois de consultar o pagamento. */
export type NormalizedPayment = {
  /**
   * `approved` credita, `refunded` estorna, `ignored` só marca o evento como
   * processado. Não existe estado "provavelmente pago": o que o provedor não
   * afirmar como aprovado não vira dinheiro no razão.
   */
  outcome: 'approved' | 'refunded' | 'ignored'
  /** Identificador da tentativa no provedor — casa com `provider_intent_id`. */
  providerIntentId: string
  amount: number | null
  paidAt: string | null
  /**
   * Meio REAL do pagamento, no vocabulário de `payment_method_type`.
   *
   * `null` para todo provedor cujo intent já declara o meio — o PIX do Mercado
   * Pago e o da Cora nascem sabendo. A RPC deriva do intent nesse caso, e
   * repetir o valor aqui só criaria duas fontes para a mesma verdade.
   *
   * Preenchido por checkout HOSPEDADO, onde quem escolhe o meio é o cliente na
   * página do provedor e só se descobre depois de pago: o intent nasce como
   * `payment_link`, que não é meio de pagamento nenhum, e sem isto o razão
   * registraria `other` para todo mundo.
   *
   * A tradução é do adaptador. Um valor fora do ENUM derruba a transação
   * inteira com erro de tipo, não com falha nomeada.
   */
  method?: string | null
  /**
   * Observação gravada em `payments.notes`.
   *
   * Existe para o caso em que a confirmação NÃO pôde ser verificada contra a
   * API do provedor e foi aceita mesmo assim (ADR 0033): a ressalva viaja
   * junto do dinheiro, no próprio registro que o operador lê, em vez de ficar
   * só num log que ninguém abre.
   */
  notes?: string | null
  /**
   * Encargo que o PROVEDOR somou ao código na hora de pagar (ADR 0037).
   *
   * Só existe para quem embute multa e juros no código (Pix com vencimento do
   * Asaas): o banco do pagador calcula, e o valor pago passa do valor do
   * intent. Sem isto a diferença entraria como pagamento — saldo negativo e
   * receita de encargo fora do DRE.
   */
  extraLateCharge?: number
  /** Vai para o motivo do estorno e para o log. */
  detail: string
}

export type ProviderAccount = { id: string; tenant_id: string }

/**
 * O evento como ele está GRAVADO — a única entrada do processamento.
 *
 * Os processadores de cada provedor leem daqui e de mais nada (ADR 0034, Fase
 * 3b). Na entrega original o payload acabou de ser montado a partir da
 * requisição; no reprocessamento ele vem do banco. Mesmos campos, mesma função,
 * e por isso o dreno da fila não pode divergir do webhook — não existe um
 * segundo caminho para confirmar dinheiro.
 */
export type StoredEvent = {
  id: string
  event_type: string
  provider_event_id: string
  payload: Record<string, unknown>
}

/**
 * Grava o evento ANTES de processar.
 *
 * `UNIQUE (provider, provider_event_id)` faz a idempotência ser propriedade do
 * banco. Antes, ela dependia do efeito colateral `.neq('status','paid')`: uma
 * retentativa do provedor entre a criação do pagamento e a atualização do
 * status criava um segundo recebimento do mesmo dinheiro.
 *
 * Devolve `null` quando é duplicata — o chamador responde 200 e não faz nada.
 */
export async function recordEvent(
  supabase: SupabaseClient,
  input: {
    provider: string
    providerEventId: string
    eventType: string
    payload: unknown
    signatureValid: boolean
  },
): Promise<string | null> {
  const { data, error } = await supabase
    .from('gateway_events')
    .insert({
      provider: input.provider,
      provider_event_id: input.providerEventId,
      event_type: input.eventType,
      payload: input.payload as Record<string, unknown>,
      signature_valid: input.signatureValid,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      log('info', 'webhook.duplicate', { provider: input.provider, provider_event_id: input.providerEventId })
      return null
    }
    throw new Error(`persist: ${error.message}`)
  }

  return (data as { id: string }).id
}

/** Credencial do Vault. Ponto único de leitura, com checagem de tenant dentro. */
export async function accountCredentials(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('fn_provider_credentials', { p_account_id: accountId })
  if (error) throw new Error(`credenciais: ${error.message}`)
  if (!data) throw new Error(`credenciais ausentes para a conta ${accountId}`)
  return data as Record<string, unknown>
}

type IntentRow = { id: string; tenant_id: string; charge_id: string; amount: number; status: string }

async function findIntent(
  supabase: SupabaseClient,
  provider: string,
  providerIntentId: string,
): Promise<IntentRow | null> {
  const { data } = await supabase
    .from('payment_intents')
    .select('id, tenant_id, charge_id, amount, status')
    .eq('provider', provider)
    .eq('provider_intent_id', providerIntentId)
    .maybeSingle()

  return (data ?? null) as IntentRow | null
}

/**
 * Aplica o resultado normalizado ao razão.
 *
 * Confirmação e estorno são RPCs transacionais. O caminho anterior fazia os
 * quatro passos da confirmação como quatro requisições soltas ao PostgREST:
 * falha no meio deixava estado partido, e a retentativa do provedor não era
 * barrada porque o guarda perguntava pelo status do intent — o último passo, o
 * que nunca chegava a acontecer.
 */
export async function applyPayment(
  supabase: SupabaseClient,
  provider: string,
  account: ProviderAccount,
  payment: NormalizedPayment,
  /**
   * O evento que causou isto (ADR 0034).
   *
   * Vai para `payments.gateway_event_id` e para
   * `financial_transactions.source_event_id`. Antes, ir do dinheiro de volta à
   * notificação era uma busca em JSONB montada na hora e diferente por
   * gateway; agora é FK.
   */
  eventId: string,
): Promise<void> {
  // O DESFECHO É GRAVADO ANTES DE QUALQUER DECISÃO.
  //
  // Ele era calculado, usado para decidir, e jogado fora — a forma "validado e
  // descartado" outra vez. Sem ele, a tela de diagnóstico não distingue "o
  // provedor disse que não foi pago" de "produziu dinheiro e não dá para
  // mostrar", e todo Pix que expira vira ruído permanente na tela.
  //
  // Antes do `return` do `ignored` de propósito: é justamente esse caso que
  // precisa ficar registrado.
  await recordOutcome(supabase, eventId, payment.outcome)

  if (payment.outcome === 'ignored') {
    log('info', 'webhook.status_ignored', {
      provider, provider_intent_id: payment.providerIntentId, detail: payment.detail,
    })
    return
  }

  const intent = await findIntent(supabase, provider, payment.providerIntentId)
  if (!intent) {
    // Dinheiro APROVADO sem tentativa correspondente não pode sumir em
    // silêncio. Antes isto era um `warn` e um `return`: o chamador seguia e
    // marcava o evento como processado, então um pagamento real que não
    // achasse a sua tentativa saía da fila sem deixar nada além de uma linha
    // de log. É a mesma forma do defeito que a ADR 0032 corrigiu.
    //
    // Levantar deixa `processed_at IS NULL` com `processing_error`, que é o
    // registro de que existe dinheiro sem dono a investigar.
    if (payment.outcome === 'approved') {
      throw new Error(
        `pagamento aprovado sem tentativa correspondente: `
        + `provider=${provider} provider_intent_id=${payment.providerIntentId}`,
      )
    }

    // Estorno ou evento ignorado sem tentativa: não há o que desfazer, porque
    // sem tentativa também não há pagamento nosso. Seguir é correto.
    log('warn', 'webhook.intent_not_found', { provider, provider_intent_id: payment.providerIntentId })
    return
  }

  if (payment.outcome === 'approved') {
    const { data: paymentId, error } = await supabase.rpc('fn_confirm_gateway_payment', {
      p_tenant_id: intent.tenant_id,
      p_intent_id: intent.id,
      p_amount: payment.amount ?? intent.amount,
      p_paid_at: payment.paidAt ?? new Date().toISOString(),
      // `null` deixa a RPC derivar do `method` do intent — o certo enquanto o
      // intent declara o meio. Passar 'pix' fixo aqui foi como um pagamento de
      // outro meio viraria PIX no razão.
      //
      // O provedor só informa quando SABE mais que o intent: checkout hospedado
      // nasce `payment_link` e descobre `pix` ou `credit_card` na confirmação.
      p_method: payment.method ?? null,
      // Sem `notes`, a RPC usa o default 'Confirmado pelo gateway'.
      ...(payment.notes ? { p_notes: payment.notes } : {}),
      // ADR 0034: o elo causal e quem recebeu. A RPC monta
      // `received_by_system` como `gateway:<provedor>` — o formato mora lá e no
      // CHECK da coluna, não aqui, para não haver três lugares construindo a
      // mesma string.
      p_gateway_event_id: eventId,
      p_provider: provider,
      // Só quando existe: os outros gateways não passam a depender da
      // assinatura nova da RPC (migration 20261010231422).
      ...(payment.extraLateCharge ? { p_extra_late_charge: payment.extraLateCharge } : {}),
    })
    if (error) throw new Error(`confirmação: ${error.message}`)

    log('info', 'webhook.payment_confirmed', {
      provider, payment_id: paymentId, charge_id: intent.charge_id,
      tenant_id: intent.tenant_id, amount: payment.amount ?? intent.amount,
      event_id: eventId,
    })
    return
  }

  // ── refunded / charged_back ─────────────────────────────────────────
  // `fn_reverse_payment` inverte TODAS as pernas de TODAS as transações do
  // pagamento preservando as dimensões, e liga cada estorno à original por
  // `reverses_transaction_id` — o que também a torna idempotente. Refazer isso
  // à mão presumia duas pernas de valor cheio: bastaria o recebimento ganhar
  // uma perna de tarifa para o estorno sair desequilibrado.
  const { data: existing } = await supabase
    .from('payments')
    .select('id, reversed_at')
    .eq('payment_intent_id', intent.id)
    .maybeSingle()

  const p = existing as { id: string; reversed_at: string | null } | null
  if (!p || p.reversed_at) return

  const { error } = await supabase.rpc('fn_reverse_payment', {
    p_tenant_id: intent.tenant_id,
    p_payment_id: p.id,
    p_reason: `Gateway ${provider}: ${payment.detail}`,
    p_reversed_by: null,
  })

  // Corrida com o estorno manual: outro caminho chegou primeiro e o dinheiro já
  // voltou. Nada a fazer, e não é falha — reprocessar não muda nada.
  if (error && !error.message.includes('PAYMENT_ALREADY_REVERSED')) {
    throw new Error(`estorno: ${error.message}`)
  }

  await supabase.from('payment_intents').update({ status: 'refunded' }).eq('id', intent.id)

  log('info', 'webhook.payment_reversed', {
    provider, payment_id: p.id, charge_id: intent.charge_id, detail: payment.detail,
  })
}

/**
 * Carimba o dono do evento assim que ele é conhecido (ADR 0034).
 *
 * `gateway_events.tenant_id` só era preenchido em `markProcessed` — no FIM. A
 * RLS da tabela é `tenant_id IN (SELECT get_user_tenants())`, então um evento
 * que falhava ficava com `tenant_id` NULL e era invisível para todo mundo
 * exceto `service_role`.
 *
 * Ou seja: as linhas que representam "dinheiro sem dono a investigar" — as que
 * a ADR 0033 passou a produzir de propósito, trocando o silêncio por exceção —
 * eram justamente as que ninguém conseguia ver. Chamar isto ANTES do trabalho
 * arriscado é o que faz a fila de replay existir para quem agiria sobre ela.
 */
export async function markEventTenant(
  supabase: SupabaseClient,
  eventId: string,
  tenantId: string,
): Promise<void> {
  await supabase.from('gateway_events').update({ tenant_id: tenantId }).eq('id', eventId)
}

/**
 * O que o PROVEDOR respondeu sobre este evento (ADR 0034).
 *
 * `approved` credita, `refunded` estorna, `ignored` é resposta afirmativa de
 * "não foi pago" — Pix expirado, cartão recusado, pagamento ainda pendente.
 *
 * Distinto de "não consegui verificar", que nunca chega aqui: aquilo vira
 * exceção e deixa o evento na fila, sem desfecho. A diferença entre os dois é a
 * lição que custou o primeiro pagamento real da InfinitePay.
 */
async function recordOutcome(
  supabase: SupabaseClient,
  eventId: string,
  outcome: NormalizedPayment['outcome'],
): Promise<void> {
  await supabase.from('gateway_events').update({ outcome }).eq('id', eventId)
}

export async function markProcessed(
  supabase: SupabaseClient,
  eventId: string,
  tenantId: string | null,
): Promise<void> {
  await supabase
    .from('gateway_events')
    .update({
      processed_at: new Date().toISOString(),
      // `tenant_id` só é escrito quando há um. Passar `null` aqui apagaria o
      // dono que `markEventTenant` já tinha carimbado, e a linha voltaria a
      // ser invisível para o tenant no exato momento em que vira histórico.
      ...(tenantId ? { tenant_id: tenantId } : {}),
    })
    .eq('id', eventId)
}

/**
 * Registra a falha no inbox em vez de perdê-la no log.
 *
 * Um evento com `processing_error` e sem `processed_at` é a fila de replay:
 * `idx_gateway_events_unprocessed` existe exatamente para isso.
 */
export async function markFailed(
  supabase: SupabaseClient,
  eventId: string,
  err: unknown,
): Promise<void> {
  // `attempts` CONTA, não carimba.
  //
  // Antes isto gravava `attempts: 1` fixo. Com uma entrega só ninguém notava —
  // a primeira falha é mesmo a primeira. Com o dreno da fila (ADR 0034 Fase 3b)
  // virou defeito visível: reprocessar dez vezes deixava o contador em 1, e um
  // evento que falha sempre seria retentado para sempre sem deixar sinal de
  // quantas vezes já se tentou.
  //
  // Ler-e-escrever em vez de `attempts + 1` no banco porque o PostgREST não
  // expressa incremento. A corrida é inofensiva: dois reprocessamentos
  // simultâneos do mesmo evento perderiam uma contagem, e o contador é
  // diagnóstico — não decide nada sobre dinheiro.
  const { data: atual } = await supabase
    .from('gateway_events')
    .select('attempts')
    .eq('id', eventId)
    .maybeSingle()

  const tentativas = ((atual as { attempts: number } | null)?.attempts ?? 0) + 1

  await supabase
    .from('gateway_events')
    .update({ processing_error: String(err), attempts: tentativas })
    .eq('id', eventId)

  log('error', 'webhook.process_failed', {
    event_id: eventId, attempts: tentativas, error: String(err),
  })
}
