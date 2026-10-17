'use client'

import React, { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Loader2, RotateCw,
  ShieldAlert, ShieldCheck,
} from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { replayGatewayEventAction } from './actions'
import { SettingsHeader } from '../_components/SettingsHeader'

/** Espelha `gateway_event_audit` (ADR 0034). */
export interface GatewayEventRow {
  event_id: string
  provider: string
  provider_event_id: string
  event_type: string
  received_at: string
  processed_at: string | null
  attempts: number
  processing_error: string | null
  signature_valid: boolean
  accepted_without_verification: boolean
  situation: 'failed' | 'pending' | 'accepted_unverified' | 'confirmed' | 'refunded'
    | 'processed_ignored' | 'processed_no_money' | 'processed_unlinked'
  processing_seconds: number | null
  payment_amount: number | string | null
  payment_method: string | null
  charge_id: string | null
  charge_number: number | null
}

/** Espelha `financial_reconciliation` (ADR 0034). */
export interface ReconciliationRow {
  issue: string
  entity: string
  entity_id: string
  detail: string
  occurred_at: string | null
}

const PROVEDORES: Record<string, string> = {
  cora: 'Cora',
  mercadopago: 'Mercado Pago',
  infinitepay: 'InfinitePay',
}

/**
 * Situação → como aparece.
 *
 * `accepted_unverified` é âmbar e não verde de propósito: o dinheiro entrou,
 * mas ninguém conferiu com o provedor (ADR 0033). Pintá-lo de "confirmado"
 * esconderia a única coisa que a tela precisa deixar visível.
 */
const SITUACOES: Record<GatewayEventRow['situation'], {
  rotulo: string
  variante: 'success' | 'warning' | 'danger' | 'muted'
  explicacao: string
}> = {
  confirmed: {
    rotulo: 'Confirmado',
    variante: 'success',
    explicacao: 'Verificado com o provedor e lançado no razão.',
  },
  accepted_unverified: {
    rotulo: 'Aceito sem conferir',
    variante: 'warning',
    explicacao: 'Confirmado sem reconsultar o provedor porque a credencial estava vencida. Vale conferir o extrato.',
  },
  refunded: {
    rotulo: 'Estornado',
    variante: 'warning',
    explicacao: 'O provedor devolveu o dinheiro. O razão recebeu o lançamento inverso.',
  },
  processed_ignored: {
    rotulo: 'Não pago',
    variante: 'muted',
    explicacao: 'O provedor respondeu que não foi pago — Pix expirado, cartão recusado ou '
      + 'pagamento ainda pendente. Não é problema e não pede ação.',
  },
  processed_no_money: {
    rotulo: 'Sem efeito',
    variante: 'muted',
    explicacao: 'Evento de ciclo de vida — criação, rascunho. Nunca vira dinheiro.',
  },
  processed_unlinked: {
    rotulo: 'Processado, sem elo',
    variante: 'muted',
    explicacao: 'Passou pelo caminho do dinheiro, sem desfecho gravado e sem pagamento ligado. '
      + 'Na prática é evento anterior a estas colunas — daqui para a frente todo evento diz '
      + 'o que o provedor respondeu.',
  },
  pending: {
    rotulo: 'Não processado',
    variante: 'warning',
    explicacao: 'Recebido e ainda não processado.',
  },
  failed: {
    rotulo: 'Falhou',
    variante: 'danger',
    explicacao: 'O processamento falhou. O provedor não reenvia — precisa de ação.',
  },
}

const PROBLEMAS: Record<string, string> = {
  unbalanced_transaction: 'Lançamento que não fecha em zero',
  charge_without_entry: 'Cobrança emitida sem lançamento no razão',
  payable_without_entry: 'Conta a pagar sem lançamento no razão',
  credit_without_entry: 'Crédito concedido sem lançamento — nasce sem saldo utilizável',
  payment_without_allocation: 'Dinheiro recebido que não quitou nenhuma cobrança',
  paid_intent_without_payment: 'Tentativa marcada como paga sem pagamento correspondente',
}

function dataHora(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function dinheiro(v: number | string | null): string {
  if (v === null) return '—'
  // PostgREST devolve NUMERIC como STRING. Sem o Number() o toLocaleString
  // silenciosamente não formata.
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function duracao(segundos: number | null): string {
  if (segundos === null) return '—'
  const s = Number(segundos)
  if (s < 1) return `${Math.round(s * 1000)} ms`
  return `${s.toFixed(1)} s`
}

/**
 * Concordância com o número que aparece logo acima.
 *
 * "1 eventos falharam" é o tipo de detalhe que passa em teste e salta aos olhos
 * de quem usa. Zero fica no plural, que é o certo em português: "0 eventos
 * falharam".
 */
function plural(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural
}

type Filtro = 'todos' | 'atencao'

export function IntegracoesClient({
  eventos, reconciliacao, loadError,
}: {
  eventos: GatewayEventRow[]
  reconciliacao: ReconciliationRow[]
  loadError: string | null
}) {
  const [filtro, setFiltro] = useState<Filtro>('todos')
  const [reprocessando, setReprocessando] = useState<string | null>(null)
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  /**
   * Reprocessar é a resposta à Questão 2 da ADR 0033: o provedor não reenvia,
   * porque já recebeu `200`. Sem este botão, um evento que falhou fica visível
   * e ninguém volta para pegá-lo.
   */
  async function reprocessar(eventId: string) {
    setReprocessando(eventId)
    setAviso(null)
    const r = await replayGatewayEventAction(eventId)
    setReprocessando(null)
    setAviso(r.ok
      ? { tipo: 'ok', texto: 'Evento reprocessado.' }
      : { tipo: 'erro', texto: r.message })
    // `revalidatePath` na action invalida o cache; o refresh é o que faz esta
    // árvore de Server Component ser buscada de novo.
    startTransition(() => router.refresh())
  }

  const contagem = useMemo(() => ({
    falhos: eventos.filter((e) => e.situation === 'failed').length,
    pendentes: eventos.filter((e) => e.situation === 'pending').length,
    semConferir: eventos.filter((e) => e.situation === 'accepted_unverified').length,
  }), [eventos])

  const precisaAtencao = contagem.falhos + contagem.pendentes + contagem.semConferir

  const visiveis = useMemo(() => (
    filtro === 'todos'
      ? eventos
      : eventos.filter((e) => e.situation === 'failed'
          || e.situation === 'pending'
          || e.situation === 'accepted_unverified')
  ), [eventos, filtro])

  return (
    <div className="space-y-8">
      <SettingsHeader
        icon={Activity}
        title="Diagnóstico das integrações"
        description="O que os gateways enviaram, o que virou dinheiro e o que ficou pelo caminho."
      />

      {loadError ? (
        <Card className="border-critical">
          <p className="text-[13px] text-critical">Não foi possível carregar: {loadError}</p>
        </Card>
      ) : null}

      {/* ── Resumo ─────────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Resumo
          icone={<AlertTriangle className="w-5 h-5" />}
          valor={contagem.falhos}
          rotulo={plural(contagem.falhos, 'evento falhou', 'eventos falharam')}
          detalhe="O provedor não reenvia — precisam de ação"
          tom={contagem.falhos > 0 ? 'danger' : 'ok'}
        />
        <Resumo
          icone={<Clock className="w-5 h-5" />}
          valor={contagem.pendentes}
          rotulo={plural(contagem.pendentes, 'não processado', 'não processados')}
          detalhe="Recebidos e ainda na fila"
          tom={contagem.pendentes > 0 ? 'warning' : 'ok'}
        />
        <Resumo
          icone={<ShieldAlert className="w-5 h-5" />}
          valor={contagem.semConferir}
          rotulo={plural(contagem.semConferir, 'aceito sem conferir', 'aceitos sem conferir')}
          detalhe="Credencial vencida na hora da confirmação"
          tom={contagem.semConferir > 0 ? 'warning' : 'ok'}
        />
      </section>

      {/* ── Eventos ────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-full bg-info-bg border border-info">
              <Activity className="w-5 h-5 text-info" />
            </div>
            <div>
              <h2 className="text-[28px] font-semibold text-fg">Eventos recebidos</h2>
              <p className="text-[13px] text-fg-mute">
                Cada notificação que os gateways enviaram, e o que ela produziu.
              </p>
            </div>
          </div>

          <div className="flex gap-1 p-1 rounded-lg bg-surface-2">
            {([['todos', 'Todos'], ['atencao', 'Precisam de atenção']] as [Filtro, string][]).map(([v, r]) => (
              <button
                key={v}
                onClick={() => setFiltro(v)}
                className={cn(
                  'px-3 h-8 rounded-md text-[13px] transition-colors',
                  filtro === v ? 'bg-surface text-fg shadow-sm' : 'text-fg-mute hover:text-fg',
                )}
              >
                {r}
                {v === 'atencao' && precisaAtencao > 0 ? ` (${precisaAtencao})` : ''}
              </button>
            ))}
          </div>
        </div>

        {aviso ? (
          <Card className={cn('mb-3', aviso.tipo === 'ok' ? 'border-success' : 'border-critical')}>
            <p className={cn('text-[13px]', aviso.tipo === 'ok' ? 'text-success' : 'text-critical')}>
              {aviso.texto}
            </p>
          </Card>
        ) : null}

        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="h-9 text-[13px] border-b border-divider text-fg-mute">
                  <th className="px-4 text-left font-medium">Situação</th>
                  <th className="px-4 text-left font-medium">Gateway</th>
                  <th className="px-4 text-left font-medium">Evento</th>
                  <th className="px-4 text-left font-medium">Recebido</th>
                  <th className="px-4 text-right font-medium">Valor</th>
                  <th className="px-4 text-left font-medium">Cobrança</th>
                  <th className="px-4 text-right font-medium">Processou em</th>
                  <th className="px-4 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visiveis.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <div className="w-12 h-12 bg-surface-2 rounded-full flex items-center justify-center">
                          <CheckCircle2 className="w-6 h-6 text-fg-mute" />
                        </div>
                        <p className="text-[13px] text-fg-mute">
                          {filtro === 'atencao'
                            ? 'Nenhum evento precisa de atenção.'
                            : 'Nenhum evento recebido ainda.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : visiveis.map((e) => {
                  const s = SITUACOES[e.situation]
                  return (
                    <tr
                      key={e.event_id}
                      className="h-9 text-[13px] border-b border-divider last:border-0 hover:bg-surface-2 transition-colors"
                    >
                      <td className="px-4">
                        <span title={s.explicacao}>
                          <Badge variant={s.variante}>{s.rotulo}</Badge>
                        </span>
                      </td>
                      <td className="px-4 text-fg">{PROVEDORES[e.provider] ?? e.provider}</td>
                      <td className="px-4 text-fg-mute">
                        <span title={`id no provedor: ${e.provider_event_id}`}>{e.event_type}</span>
                      </td>
                      <td className="px-4 text-fg-mute whitespace-nowrap">{dataHora(e.received_at)}</td>
                      <td className="px-4 text-right text-fg whitespace-nowrap">{dinheiro(e.payment_amount)}</td>
                      <td className="px-4">
                        {e.charge_id ? (
                          <Link href={`/cobrancas/${e.charge_id}`} className="text-primary hover:underline">
                            #{e.charge_number}
                          </Link>
                        ) : <span className="text-fg-mute">—</span>}
                      </td>
                      <td className="px-4 text-right text-fg-mute whitespace-nowrap">
                        {duracao(e.processing_seconds)}
                      </td>
                      <td className="px-4 text-right">
                        {e.situation === 'failed' || e.situation === 'pending' ? (
                          <button
                            onClick={() => reprocessar(e.event_id)}
                            disabled={reprocessando !== null}
                            className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                          >
                            {reprocessando === e.event_id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <RotateCw className="w-3.5 h-3.5" />}
                            Reprocessar
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {/* O erro cru do provedor fica fora da tabela: é longo, e espremê-lo numa
            célula obrigaria a truncar justamente o que explica a falha. */}
        {visiveis.some((e) => e.processing_error) ? (
          <div className="mt-4 space-y-2">
            <p className="text-[13px] font-medium text-fg">Erros registrados</p>
            {visiveis.filter((e) => e.processing_error).map((e) => (
              <Card key={`err-${e.event_id}`} className="border-critical">
                <p className="text-[12px] text-fg-mute mb-1">
                  {PROVEDORES[e.provider] ?? e.provider} · {e.event_type} · {dataHora(e.received_at)}
                  {e.attempts > 0 ? ` · ${e.attempts} tentativa(s)` : ''}
                </p>
                <p className="text-[13px] text-critical break-words font-mono">{e.processing_error}</p>
              </Card>
            ))}
          </div>
        ) : null}
      </section>

      {/* ── Reconciliação ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <div className={cn(
            'p-2.5 rounded-full border',
            reconciliacao.length === 0 ? 'bg-success-bg border-success' : 'bg-critical-bg border-critical',
          )}>
            {reconciliacao.length === 0
              ? <ShieldCheck className="w-5 h-5 text-success" />
              : <ShieldAlert className="w-5 h-5 text-critical" />}
          </div>
          <div>
            <h2 className="text-[28px] font-semibold text-fg">Reconciliação do razão</h2>
            <p className="text-[13px] text-fg-mute">
              Documento que não virou lançamento some do DRE e continua na tela — o relatório
              passa a mentir sem nada acusar.
            </p>
          </div>
        </div>

        <Card className={reconciliacao.length === 0 ? undefined : 'p-0 overflow-hidden'}>
          {reconciliacao.length === 0 ? (
            <div className="flex items-center gap-3 py-2">
              <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
              <p className="text-[13px] text-fg">
                Nenhuma divergência. Todo documento tem lançamento e todo lançamento fecha em zero.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="h-9 text-[13px] border-b border-divider text-fg-mute">
                    <th className="px-4 text-left font-medium">Problema</th>
                    <th className="px-4 text-left font-medium">Registro</th>
                    <th className="px-4 text-left font-medium">Quando</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliacao.map((r) => (
                    <tr
                      key={`${r.issue}-${r.entity_id}`}
                      className="h-9 text-[13px] border-b border-divider last:border-0 hover:bg-surface-2 transition-colors"
                    >
                      <td className="px-4 text-fg">{PROBLEMAS[r.issue] ?? r.issue}</td>
                      <td className="px-4 text-fg-mute">{r.detail}</td>
                      <td className="px-4 text-fg-mute whitespace-nowrap">{dataHora(r.occurred_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  )
}

function Resumo({
  icone, valor, rotulo, detalhe, tom,
}: {
  icone: React.ReactNode
  valor: number
  rotulo: string
  detalhe: string
  tom: 'ok' | 'warning' | 'danger'
}) {
  const cor = tom === 'danger' ? 'text-critical' : tom === 'warning' ? 'text-warning' : 'text-fg-mute'
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className={cn('shrink-0 mt-0.5', cor)}>{icone}</div>
        <div className="min-w-0">
          <p className={cn('text-[28px] font-semibold leading-none', tom === 'ok' ? 'text-fg' : cor)}>
            {valor}
          </p>
          <p className="text-[13px] font-medium text-fg mt-1.5">{rotulo}</p>
          <p className="text-[12px] text-fg-mute mt-0.5">{detalhe}</p>
        </div>
      </div>
    </Card>
  )
}
