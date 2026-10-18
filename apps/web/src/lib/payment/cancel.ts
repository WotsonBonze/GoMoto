/**
 * Encerra as tentativas de pagamento de uma cobrança (ADR 0033, Questão 1).
 *
 * Cancelar uma cobrança sempre reverteu a emissão no razão e **nunca tocou no
 * `payment_intent`**. O código de pagamento seguia vivo no provedor: o link
 * abria, o QR escaneava. É a metade mecânica que a ADR registrou como "sem
 * decisão pendente" e que ficou sem conserto até aqui.
 *
 * Duas coisas acontecem, com pesos diferentes:
 *
 *   1. **Expirar a tentativa aqui.** Determinístico. Tira o QR da tela do
 *      cliente e libera o índice de "um pendente por dívida".
 *   2. **Cancelar no provedor.** Melhor esforço, e nada mais que isso.
 *
 * POR QUE O CANCELAMENTO REMOTO NUNCA PODE BLOQUEAR
 *
 * Ele reduz a probabilidade de o dinheiro chegar; não a elimina. A InfinitePay
 * não oferece cancelamento; a chamada pode falhar por rede ou credencial; o
 * Mercado Pago só cancela dentro de uma janela de status; e existe corrida — o
 * cliente pode estar com o código aberto e pagar no mesmo segundo.
 *
 * Por isso a pergunta "o que o razão faz quando esse dinheiro chega mesmo
 * assim" continua tendo resposta própria, no banco: vira crédito do cliente.
 * Este módulo é a redução de probabilidade, não a garantia — e falhar aqui
 * jamais pode impedir o cancelamento da cobrança, que é o que o operador pediu.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveCredentials } from './credentials'
import { PROVIDER_REGISTRY } from './registry'

function log(level: 'info' | 'warn', action: string, fields: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields }))
}

export type CancelIntentsResult = {
  /** Tentativas que deixaram de ser oferecidas ao cliente. */
  expiradas: number
  /** Cancelamentos aceitos pelo provedor. */
  canceladasNoProvedor: number
  /** Provedor não oferece cancelamento, ou a chamada falhou. */
  naoCanceladasNoProvedor: number
}

/**
 * `supabase` é o cliente de quem está cancelando — as leituras passam por RLS.
 * A credencial NÃO passa por ele: `resolveCredentials` monta o próprio cliente
 * de serviço, porque as RPCs de credencial não atendem `authenticated`
 * (ADR 0034, Fase 2).
 */
export async function cancelChargeIntents(
  supabase: SupabaseClient,
  tenantId: string,
  chargeId: string,
): Promise<CancelIntentsResult> {
  const resultado: CancelIntentsResult = {
    expiradas: 0, canceladasNoProvedor: 0, naoCanceladasNoProvedor: 0,
  }

  const { data } = await supabase
    .from('payment_intents')
    .select('id, provider, provider_account_id, provider_intent_id')
    .eq('charge_id', chargeId)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')

  const pendentes = (data ?? []) as {
    id: string; provider: string
    provider_account_id: string; provider_intent_id: string | null
  }[]

  for (const intent of pendentes) {
    // O provedor PRIMEIRO, enquanto a tentativa ainda existe como pendente.
    // Se a ordem fosse inversa e o processo morresse no meio, ficaria uma
    // tentativa expirada aqui e um código vivo lá — o pior dos dois mundos,
    // porque some da nossa tela sem sumir da mão do cliente.
    const impl = PROVIDER_REGISTRY[intent.provider]

    if (!impl?.cancelIntent || !intent.provider_intent_id) {
      resultado.naoCanceladasNoProvedor++
      log('info', 'charge.cancel.provider_sem_suporte', {
        provider: intent.provider, intent_id: intent.id,
      })
    } else {
      try {
        const credentials = await resolveCredentials(
          { id: intent.provider_account_id, provider: intent.provider }, impl,
        )
        await impl.cancelIntent({
          providerIntentId: intent.provider_intent_id, credentials,
        })
        resultado.canceladasNoProvedor++
      } catch (err) {
        // Nunca propaga. Cancelar a cobrança é decisão do operador e já
        // aconteceu; o provedor não pode desfazê-la, e a proteção real contra
        // o dinheiro chegar mesmo assim está no banco.
        resultado.naoCanceladasNoProvedor++
        log('warn', 'charge.cancel.provider_falhou', {
          provider: intent.provider, intent_id: intent.id,
          provider_intent_id: intent.provider_intent_id, error: String(err),
        })
      }
    }

    // Expirar é por RPC: `payment_intents` deixou de aceitar escrita de
    // `authenticated` (ADR 0034, Fase 2).
    const { error } = await supabase.rpc('fn_expire_payment_intent', { p_intent_id: intent.id })
    if (error) {
      log('warn', 'charge.cancel.expirar_falhou', { intent_id: intent.id, error: error.message })
    } else {
      resultado.expiradas++
    }
  }

  return resultado
}
