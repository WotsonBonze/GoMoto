/**
 * Drenagem automática da fila de replay — ADR 0034 Fase 4.
 *
 * A Fase 3b deu à fila um consumidor; ele só rodava quando alguém clicava. Isto
 * é o que faz a fila drenar sozinha, que é o que importa para a maioria das
 * falhas: token vencido, provedor instável, rede caindo — todas passam.
 *
 * CADÊNCIA: diária (`0 10 * * *` = 07:00 em Brasília), porque o plano Hobby da
 * Vercel não aceita cron mais frequente. A hora foi escolhida para o operador
 * encontrar o quadro já drenado ao começar o dia. Para qualquer coisa urgente o
 * caminho é o botão da tela de diagnóstico — com esta cadência ele não é
 * conveniência, é o caminho normal.
 *
 * POR QUE AQUI E NÃO NO `pg_cron`
 *
 * A emissão de cobranças roda no banco porque ela É SQL: `fn_run_billing_emission`
 * não sai do Postgres. Drenar a fila é o contrário — é uma chamada HTTP a uma
 * Edge Function, que por sua vez chama a API do provedor. Fazer isso do banco
 * exigiria `pg_net` (disponível) e, com ele, guardar uma credencial de chamada
 * no banco. Aqui não entra segredo novo: a rota usa o `CRON_SECRET` que a
 * emissão manual já usa, e a chave de serviço já vive no ambiente da aplicação.
 *
 * O QUE ELA NÃO FAZ
 *
 * Não decide nada sobre dinheiro. Ela escolhe QUAIS eventos tentar e chama a
 * mesma função que o botão da tela chama — que chama o mesmo processador do
 * webhook. Uma implementação só, do começo ao fim.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { replayEvent } from '@/lib/payment/replay'
import { resolveCredentials } from '@/lib/payment/credentials'
import { PROVIDER_REGISTRY } from '@/lib/payment/registry'

export const dynamic = 'force-dynamic'
/** A drenagem faz uma ida à API do provedor por evento; o default de 15s não cobre. */
export const maxDuration = 120

/**
 * Quantas vezes insistir antes de exigir gente.
 *
 * Não é backoff exponencial: o intervalo entre tentativas é o do próprio cron.
 * O teto existe porque falha que persiste não é instabilidade — é um caso que
 * precisa de decisão humana, e continuar tentando só gasta chamada na API do
 * provedor e esconde o problema numa contagem que ninguém lê.
 *
 * O plano Hobby da Vercel só aceita cron DIÁRIO, então cinco tentativas são
 * cinco dias. É muito para esperar, e é por isso que o botão "Reprocessar" na
 * tela de diagnóstico não é conveniência: com esta cadência, ele é o caminho
 * normal para qualquer coisa urgente. O cron é a rede que pega o que ninguém
 * viu.
 */
const MAX_TENTATIVAS = 5

/**
 * Idade mínima para tentar.
 *
 * O webhook responde antes de processar e segue trabalhando em segundo plano
 * (`EdgeRuntime.waitUntil`). Um evento recém-chegado pode estar sendo
 * processado AGORA, e drená-lo em paralelo faria duas verificações concorrentes
 * do mesmo pagamento. A confirmação é idempotente, então não duplicaria
 * dinheiro — mas gastaria duas chamadas e poluiria o log com uma corrida que
 * não precisa existir.
 *
 * Com cron diário isto quase nunca morde. A guarda fica porque protege o
 * disparo MANUAL da rota, que acontece perto de uma entrega justamente quando
 * alguém está investigando.
 */
const IDADE_MINIMA_MINUTOS = 2

/**
 * Teto por execução.
 *
 * Dimensionado para a cadência diária: o lote precisa caber um dia inteiro de
 * falhas, senão o excedente espera mais 24 horas. Cinquenta eventos parados num
 * dia já seriam uma catástrofe — e mesmo assim cabem. A `maxDuration` de 120s
 * comporta o lote com folga, porque cada evento é uma ida à API do provedor.
 */
const LOTE = 50

function log(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

/**
 * Renova a credencial das contas cujos eventos estão parados.
 *
 * Por CONTA e não por evento: `resolveCredentials` já decide sozinha se precisa
 * renovar (margem de 10 minutos) e serializa concorrentes por reivindicação no
 * banco. Chamar uma vez por par (tenant, provedor) evita gastar a janela de
 * rotação da Cora — 3 usos do token anterior — com dez eventos do mesmo lote.
 *
 * Eventos sem `tenant_id` ficam de fora: eles falharam ANTES de resolver a
 * conta, então não há credencial a renovar e renovar não os ajudaria.
 *
 * Falha aqui NUNCA interrompe a drenagem. Refresh token morto (a Cora encerra a
 * sessão com 60 dias de inatividade) é caso para reconectar a conta, não para
 * impedir que os outros eventos sejam reprocessados — e o replay ainda tem o
 * risco aceito da ADR 0033 como último recurso.
 */
async function renovarCredenciais(
  supabase: SupabaseClient,
  pendentes: { tenant_id: string | null; provider: string }[],
): Promise<{ renovadas: number; falhas: number }> {
  const pares = new Map<string, { tenantId: string; provider: string }>()
  for (const e of pendentes) {
    if (!e.tenant_id) continue
    pares.set(`${e.tenant_id}:${e.provider}`, { tenantId: e.tenant_id, provider: e.provider })
  }

  const resumo = { renovadas: 0, falhas: 0 }

  for (const { tenantId, provider } of pares.values()) {
    const impl = PROVIDER_REGISTRY[provider]
    // Provedor sem implementação nesta versão, ou sem renovação (a InfinitePay
    // usa handle, que não vence): nada a fazer, e não é erro.
    if (!impl?.oauth?.refresh) continue

    // Sem filtro por `active`: conta desconectada ainda pode ter evento parado,
    // e reconhecer o dinheiro que entrou vale mais que o estado da conexão —
    // o processador também usa a conta do intent sem olhar `active`.
    const { data: contas } = await supabase
      .from('payment_provider_accounts')
      .select('id, provider')
      .eq('tenant_id', tenantId)
      .eq('provider', provider)

    for (const conta of (contas ?? []) as { id: string; provider: string }[]) {
      try {
        await resolveCredentials(conta, impl)
        resumo.renovadas++
      } catch (err) {
        resumo.falhas++
        log('warn', 'drain.refresh_failed', {
          provider, account_id: conta.id, tenant_id: tenantId, error: String(err),
        })
      }
    }
  }

  return resumo
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    log('error', 'drain.misconfigured', { reason: 'CRON_SECRET ausente' })
    return NextResponse.json({ ok: false, error: 'Drenagem não configurada' }, { status: 500 })
  }

  if (req.headers.get('Authorization') !== `Bearer ${secret}`) {
    log('warn', 'drain.unauthorized')
    return NextResponse.json({ ok: false, error: 'Não autorizado' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const limite = new Date(Date.now() - IDADE_MINIMA_MINUTOS * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('gateway_events')
    .select('id, tenant_id, provider, event_type, attempts, received_at')
    .is('processed_at', null)
    .lt('attempts', MAX_TENTATIVAS)
    .lt('received_at', limite)
    .order('received_at', { ascending: true })
    .limit(LOTE)

  if (error) {
    log('error', 'drain.query_failed', { error: error.message })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const pendentes = (data ?? []) as {
    id: string; tenant_id: string | null; provider: string
    event_type: string; attempts: number; received_at: string
  }[]

  // RENOVA A CREDENCIAL ANTES DE REPROCESSAR.
  //
  // Fecha a metade 2b da ADR 0033. O token da Cora dura 24h e só era renovado
  // ao gerar cobrança; um evento que chegasse com token vencido caía no risco
  // aceito — confirmar SEM verificar na API do provedor.
  //
  // A renovação nunca foi possível de dentro do webhook: ela vive aqui, em
  // Node, e as Edge Functions são Deno. Copiá-la para lá seria duplicar
  // margem, reivindicação, lease e rotação — decidindo sobre uma janela de 3
  // usos —, que é a duplicação que `_shared/inbox.ts` existe para evitar.
  //
  // Esta rota, porém, JÁ roda em `apps/web`. Renovar aqui, antes de acionar o
  // replay, faz a reconsulta ao provedor voltar a ser possível — e transforma
  // "confirmado sem conferir" em confirmação verificada de verdade.
  const credenciais = await renovarCredenciais(supabase, pendentes)

  const resumo = { drenados: 0, ainda_falhando: 0, recusados: 0, inalcancavel: 0 }

  for (const e of pendentes) {
    const r = await replayEvent(e.id)

    if (r.status === 'processed') {
      resumo.drenados++
      log('info', 'drain.processed', { event_id: e.id, provider: e.provider })
      continue
    }

    if (r.status === 'failed') {
      resumo.ainda_falhando++
      log('warn', 'drain.still_failing', {
        event_id: e.id, provider: e.provider,
        attempts: e.attempts + 1, error: r.error,
      })
      continue
    }

    if (r.status === 'unreachable') {
      // A função está fora: parar o lote. Insistir com o resto só produz o
      // mesmo erro dezenas de vezes e some com o sinal no meio do log.
      resumo.inalcancavel++
      log('error', 'drain.replay_unreachable', { event_id: e.id, error: r.error })
      break
    }

    resumo.recusados++
    log('info', 'drain.rejected', { event_id: e.id, reason: r.reason })
  }

  // ── O que precisa de gente ──────────────────────────────────────────
  // Duas perguntas que ninguém mais faz sozinho. Elas não param a rota: são o
  // alerta, e o lugar dele é o log estruturado, que é o que existe hoje. Um
  // canal de notificação seria infraestrutura nova, e escolher destinatário no
  // lugar do humano seria decidir por ele.

  const { count: esgotados } = await supabase
    .from('gateway_events')
    .select('id', { count: 'exact', head: true })
    .is('processed_at', null)
    .gte('attempts', MAX_TENTATIVAS)

  if ((esgotados ?? 0) > 0) {
    log('error', 'drain.needs_human', {
      eventos: esgotados,
      detalhe: `${esgotados} evento(s) falharam ${MAX_TENTATIVAS}x e não serão mais tentados`,
      onde: '/configuracoes/integracoes',
    })
  }

  const { count: semVerificacao } = await supabase
    .from('gateway_events')
    .select('id', { count: 'exact', head: true })
    .eq('accepted_without_verification', true)
    .gte('received_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

  if ((semVerificacao ?? 0) > 0) {
    log('warn', 'drain.accepted_unverified', {
      eventos: semVerificacao,
      detalhe: 'confirmados sem reconsultar o provedor nas últimas 24h (ADR 0033) — conferir extrato',
    })
  }

  const { count: divergencias } = await supabase
    .from('financial_reconciliation')
    .select('entity_id', { count: 'exact', head: true })

  if ((divergencias ?? 0) > 0) {
    log('error', 'drain.reconciliation', {
      divergencias,
      detalhe: 'documento sem lançamento ou lançamento sem contrapartida — o relatório está mentindo',
      onde: '/configuracoes/integracoes',
    })
  }

  log('info', 'drain.done', {
    candidatos: pendentes.length, ...resumo,
    credenciais_renovadas: credenciais.renovadas,
    credenciais_com_falha: credenciais.falhas,
  })

  return NextResponse.json({
    ok: true,
    candidatos: pendentes.length,
    credenciais_renovadas: credenciais.renovadas,
    credenciais_com_falha: credenciais.falhas,
    ...resumo,
    precisam_de_humano: esgotados ?? 0,
    aceitos_sem_verificacao_24h: semVerificacao ?? 0,
    divergencias_no_razao: divergencias ?? 0,
  })
}
