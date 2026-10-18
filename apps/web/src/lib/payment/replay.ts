/**
 * Chamada à Edge Function `gateway-replay` (ADR 0034 Fase 3b/4).
 *
 * Dois chamadores: a Server Action da tela de diagnóstico (um evento, escolhido
 * por gente) e o cron de drenagem (o que sobrou, sem gente). Os dois falam com
 * a mesma função, que por sua vez chama o mesmo processador do webhook — a
 * corrente inteira tem uma implementação só, e é isso que impede o dinheiro de
 * ser confirmado por dois caminhos diferentes.
 *
 * Aqui não há autorização nenhuma: quem chama é que decide se pode. A Server
 * Action confere papel e tenant; o cron confere o `CRON_SECRET`. Este módulo é
 * transporte.
 */

export type ReplayOutcome =
  /** Processado com sucesso — o evento saiu da fila. */
  | { status: 'processed' }
  /** A função rodou e a verificação no provedor falhou. Continua na fila. */
  | { status: 'failed'; error: string }
  /** Nem chegou a processar: já estava processado, não existe, provedor sem dreno. */
  | { status: 'rejected'; reason: string; httpStatus: number }
  /** Não foi possível falar com a função. */
  | { status: 'unreachable'; error: string }

export function replayIsConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function replayEvent(eventId: string): Promise<ReplayOutcome> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return { status: 'unreachable', error: 'SUPABASE_SERVICE_ROLE_KEY ausente' }
  }

  let res: Response
  try {
    res = await fetch(`${url}/functions/v1/gateway-replay`, {
      method: 'POST',
      // `no-store` OBRIGATÓRIO. Sem ele o Next serve a resposta anterior do
      // cache de dados, e o efeito é traiçoeiro: a drenagem relata
      // `ainda_falhando: 2` sem ter chamado a função uma única vez. Foi o que
      // aconteceu ao testar — o contador de tentativas não subia e nenhum
      // `replay.start` aparecia no log da Edge Function, enquanto a rota
      // respondia como se tivesse trabalhado.
      //
      // Reprocessar é um efeito colateral, nunca uma leitura: a mesma chamada
      // com a mesma entrada TEM que ir de novo.
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        // `gateway-replay` tem `verify_jwt = true`: quem chama é backend, e a
        // chave de serviço é o que prova isso. Nunca sai daqui para o cliente.
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({ event_id: eventId }),
    })
  } catch (err) {
    return { status: 'unreachable', error: String(err) }
  }

  const corpo = await res.json().catch(() => ({})) as {
    status?: string; error?: string
  }

  if (corpo.status === 'processed') return { status: 'processed' }

  // `failed` volta como HTTP 200 de propósito: a função fez o seu trabalho, e o
  // que falhou foi a verificação no provedor. Distinguir os dois importa para o
  // cron, que precisa saber se deve continuar tentando ou se a função está fora.
  if (corpo.status === 'failed') {
    return { status: 'failed', error: corpo.error ?? 'erro não informado' }
  }

  return {
    status: 'rejected',
    reason: corpo.error ?? corpo.status ?? `http_${res.status}`,
    httpStatus: res.status,
  }
}
