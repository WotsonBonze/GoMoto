'use client'

/**
 * Gateways de pagamento — configurar vários, cobrar por um (ADR 0030).
 *
 * O que havia aqui era um botão fixo "Conectar Mercado Pago" e o texto
 * "Mercado Pago conectado", escritos à mão. O provedor não vinha do banco: a
 * tela dizia o nome porque só existia um, e o `is_default` da conta — a coluna
 * que decide quem recebe o dinheiro — não era lido por ninguém.
 *
 * Agora a lista sai do catálogo de `@gomoto/core` cruzado com as contas do
 * tenant, e "quem cobra" é uma escolha visível e reversível.
 */

import { useState, useTransition } from 'react'
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, Link2, Link2Off, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'
import type { PaymentProviderDescriptor } from '@gomoto/core'
import type { ProviderAccountRow } from '@gomoto/data'
import {
  connectGatewayAction, connectGatewayWithApiKeyAction, connectGatewayWithHandleAction,
  disconnectGatewayAction, setDefaultGatewayAction,
} from '../actions'
import { buildGatewayRows, type GatewayRowState } from './gateway-rows'

export type GatewayFeedback = { type: 'success' | 'error'; message: string }

type Props = {
  accounts: ProviderAccountRow[]
  isLoading: boolean
  feedback: GatewayFeedback | null
  onFeedback: (f: GatewayFeedback | null) => void
  onChanged: () => void
}

type Row = GatewayRowState

export function PaymentGatewaySection({ accounts, isLoading, feedback, onFeedback, onChanged }: Props) {
  const [pending, startTransition] = useTransition()
  /** Qual linha está em ação — para o spinner não acender em todas. */
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toDisconnect, setToDisconnect] = useState<Row | null>(null)
  /** Provedor cuja credencial é digitada, não autorizada por redirecionamento. */
  const [toType, setToType] = useState<Row | null>(null)
  /** Provedor cuja credencial é uma chave de API colada pelo operador. */
  const [toKey, setToKey] = useState<Row | null>(null)
  /** Conta recém-conectada por handle, à espera de conferência do operador. */
  const [toConfirm, setToConfirm] = useState<
    { label: string; accountId: string; handle: string; checkoutUrl: string } | null
  >(null)

  const rows = buildGatewayRows(accounts)
  const billingRow = rows.find((r) => r.billing) ?? null
  const hasConnected = rows.some((r) => r.connected)

  function run(id: string, fn: () => Promise<{ ok: boolean; error?: { message: string } }>, sucesso: string) {
    setBusyId(id)
    onFeedback(null)
    startTransition(async () => {
      const result = await fn()
      setBusyId(null)
      if (!result.ok) {
        onFeedback({ type: 'error', message: result.error?.message ?? 'Não foi possível concluir a operação.' })
        return
      }
      onFeedback({ type: 'success', message: sucesso })
      onChanged()
    })
  }

  async function handleConnect(row: Row) {
    // Credencial digitada não sai da aplicação: não há para onde redirecionar.
    if (row.descriptor.connectionMode === 'handle') {
      onFeedback(null)
      setToType(row)
      return
    }
    if (row.descriptor.connectionMode === 'api_key') {
      onFeedback(null)
      setToKey(row)
      return
    }

    setBusyId(row.descriptor.id)
    onFeedback(null)
    const result = await connectGatewayAction(row.descriptor.id)
    if (!result.ok) {
      setBusyId(null)
      onFeedback({ type: 'error', message: result.error.message })
      return
    }
    // Sai da aplicação: o spinner fica até o navegador trocar de página.
    window.location.href = result.data.authUrl
  }

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2.5 rounded-full bg-info-bg border border-info">
          <CreditCard className="w-5 h-5 text-info" />
        </div>
        <div>
          <h2 className="text-[28px] font-semibold text-fg">Gateway de Pagamento</h2>
          <p className="text-[13px] text-fg-mute">
            Conecte quantos quiser. Um único gateway gera as cobranças — você escolhe qual.
          </p>
        </div>
      </div>

      <Card>
        {isLoading ? (
          <div className="flex items-center gap-3 py-2">
            <Loader2 className="animate-spin text-fg-mute" size={20} />
            <p className="text-[13px] text-fg-mute">Verificando integrações...</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Conectado mas sem eleito é o estado silencioso que este aviso
                existe para quebrar: as cobranças online simplesmente param de
                ser geradas e nada na tela dizia por quê. */}
            {hasConnected && !billingRow && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-critical-bg border border-critical">
                <AlertTriangle className="w-5 h-5 text-critical shrink-0 mt-0.5" />
                <div className="text-[13px]">
                  <p className="font-medium text-critical">Nenhum gateway ativo</p>
                  <p className="text-fg-mute mt-0.5">
                    Enquanto nenhum gateway estiver ativo, o app do cliente não consegue gerar
                    cobranças. Escolha um abaixo.
                  </p>
                </div>
              </div>
            )}

            {rows.map((row) => (
              <GatewayRow
                key={row.descriptor.id}
                row={row}
                busy={pending && busyId === row.descriptor.id}
                disabled={pending}
                onConnect={() => handleConnect(row)}
                onActivate={() =>
                  run(
                    row.descriptor.id,
                    () => setDefaultGatewayAction(row.account!.id),
                    `${row.descriptor.label} agora gera as cobranças.`,
                  )
                }
                onDisconnect={() => setToDisconnect(row)}
              />
            ))}

            {feedback && (
              <p
                className={cn(
                  'text-[13px]',
                  feedback.type === 'success' ? 'text-success' : 'text-critical',
                )}
              >
                {feedback.message}
              </p>
            )}
          </div>
        )}
      </Card>

      <HandleConnectModal
        row={toType}
        onClose={() => setToType(null)}
        onConnected={(data) => {
          setToType(null)
          setToConfirm(data)
          onChanged()
        }}
      />

      <ApiKeyConnectModal
        row={toKey}
        onClose={() => setToKey(null)}
        onConnected={(message) => {
          setToKey(null)
          onFeedback({ type: 'success', message })
          onChanged()
        }}
      />

      {/* Conferência DEPOIS de gravar, e não antes, porque a única prova que a
          InfinitePay oferece de que o handle cobra é o link já criado. O
          desfazer fica no mesmo modal: quem não reconhecer a loja desconecta
          sem procurar o botão na lista. */}
      <Modal
        open={!!toConfirm}
        onClose={() => setToConfirm(null)}
        title={`Confirme que a conta é sua`}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-[13px] text-fg-mute">
            {toConfirm?.label} identifica a conta apenas pela InfiniteTag, e nada na
            integração prova que <span className="text-fg font-medium">{toConfirm?.handle}</span> é
            você. Abra o checkout de teste e confirme que ele mostra a sua loja.
          </p>
          <p className="text-[13px] text-critical">
            Se for a loja de outra pessoa, todo dinheiro cobrado por aqui vai para ela.
          </p>

          {toConfirm && (
            <a
              href={toConfirm.checkoutUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 p-3 rounded-xl bg-surface-2 border border-border text-[13px] text-fg hover:border-fg-mute"
            >
              <ExternalLink className="w-4 h-4 shrink-0 text-fg-mute" />
              <span className="truncate">Abrir checkout de verificação</span>
            </a>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={pending}
              onClick={() => {
                const c = toConfirm!
                setToConfirm(null)
                run(c.accountId, () => disconnectGatewayAction(c.accountId), `${c.label} desconectado.`)
              }}
            >
              Não é minha conta
            </Button>
            <Button size="sm" onClick={() => setToConfirm(null)}>
              Conferi, é minha
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!toDisconnect}
        onClose={() => setToDisconnect(null)}
        title={`Desconectar ${toDisconnect?.descriptor.label ?? ''}`}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-[13px] text-fg-mute">
            {toDisconnect?.billing
              // "deixa de gerar Pix" era verdade enquanto todo gateway gerava
              // Pix. A InfinitePay gera link de checkout, então a frase passou
              // a prometer errado justamente na tela que decide o dinheiro.
              ? 'Este é o gateway que gera as cobranças. Ao desconectar, o app do cliente deixa de gerar cobrança online até você ativar outro.'
              : 'Esta conta deixa de ficar disponível. Você pode reconectá-la depois.'}
          </p>
          <p className="text-[13px] text-fg-mute">
            Cobranças já pagas e o histórico de tentativas continuam no sistema.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setToDisconnect(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={pending}
              onClick={() => {
                const row = toDisconnect!
                setToDisconnect(null)
                run(
                  row.descriptor.id,
                  () => disconnectGatewayAction(row.account!.id),
                  `${row.descriptor.label} desconectado.`,
                )
              }}
            >
              Desconectar
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  )
}

function GatewayRow({
  row, busy, disabled, onConnect, onActivate, onDisconnect,
}: {
  row: Row
  busy: boolean
  disabled: boolean
  onConnect: () => void
  onActivate: () => void
  onDisconnect: () => void
}) {
  const { descriptor, account, connected, billing } = row
  const identidade = account?.account_label ?? account?.external_account_id ?? null

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-4 rounded-xl border',
        billing ? 'bg-success-bg border-success' : 'bg-surface border-border',
      )}
    >
      {billing ? (
        <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
      ) : (
        <Link2 className="w-5 h-5 text-fg-mute shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-fg">{descriptor.label}</p>
          <StatusBadge descriptor={descriptor} connected={connected} billing={billing} />
        </div>
        <p className="text-[12px] text-fg-mute mt-0.5 truncate">
          {identidade ?? descriptor.description}
        </p>
      </div>

      {busy ? (
        <Loader2 className="animate-spin text-fg-mute shrink-0" size={18} />
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          {connected && !billing && (
            <Button size="sm" disabled={disabled} onClick={onActivate}>
              Ativar
            </Button>
          )}
          {connected ? (
            <Button variant="danger" size="sm" disabled={disabled} onClick={onDisconnect}>
              <Link2Off className="w-4 h-4" />
              Desconectar
            </Button>
          ) : (
            <Button
              size="sm"
              variant={account ? 'outline' : 'primary'}
              disabled={disabled || !descriptor.available}
              onClick={onConnect}
            >
              <Link2 className="w-4 h-4" />
              {account ? 'Reconectar' : 'Conectar'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Conexão de gateway cuja credencial é DIGITADA (ADR 0032).
 *
 * O ramo OAuth manda o operador para o provedor e volta com a identidade da
 * conta. Aqui não há para onde ir: ele digita uma InfiniteTag pública e a única
 * verificação possível é a própria API tentar criar um link.
 *
 * Por isso o texto do campo fala em conferir, e não em guardar segredo. Tratar
 * este campo como senha — mascarar, esconder — daria ao operador a impressão
 * errada sobre o que está em jogo: o risco não é alguém ler, é ele errar.
 */
function HandleConnectModal({
  row, onClose, onConnected,
}: {
  row: Row | null
  onClose: () => void
  onConnected: (data: { label: string; accountId: string; handle: string; checkoutUrl: string }) => void
}) {
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  function fechar() {
    setHandle('')
    setErro(null)
    onClose()
  }

  async function submeter() {
    if (!row || busy) return
    setBusy(true)
    setErro(null)

    const result = await connectGatewayWithHandleAction(row.descriptor.id, handle)
    setBusy(false)

    if (!result.ok) {
      setErro(result.error.message)
      return
    }

    setHandle('')
    onConnected({ label: row.descriptor.label, ...result.data })
  }

  return (
    <Modal open={!!row} onClose={fechar} title={`Conectar ${row?.descriptor.label ?? ''}`} size="sm">
      <div className="space-y-4">
        <p className="text-[13px] text-fg-mute">
          Informe a sua InfiniteTag — o nome de usuário do app da InfinitePay. Pode colar
          com o <span className="text-fg">$</span>; ele é removido.
        </p>

        <Input
          label="InfiniteTag"
          placeholder="sua-infinitetag"
          value={handle}
          autoFocus
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submeter() }}
          error={erro ?? undefined}
          hint="Precisa estar com o Checkout Externo habilitado na sua conta InfinitePay."
        />

        <p className="text-[12px] text-fg-mute">
          Vamos criar um checkout de teste de R$ 1,00 para confirmar que a tag cobra.
          Ele não é enviado a ninguém e não precisa ser pago.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={fechar}>
            Cancelar
          </Button>
          <Button size="sm" loading={busy} disabled={!handle.trim()} onClick={() => void submeter()}>
            Conectar
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Conexão por CHAVE DE API (ADR 0037).
 *
 * Ao contrário da InfiniteTag, aqui o campo é um segredo de verdade: mascarado,
 * sem autocompletar, e a chave não volta para a tela depois de gravada. A
 * conexão recusa chave com permissão de saque — a orientação para criar uma
 * chave só de cobrança vem antes do campo, para o operador não ter de errar
 * primeiro.
 */
function ApiKeyConnectModal({
  row, onClose, onConnected,
}: {
  row: Row | null
  onClose: () => void
  onConnected: (message: string) => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  function fechar() {
    setKey('')
    setErro(null)
    onClose()
  }

  async function submeter() {
    if (!row || busy) return
    setBusy(true)
    setErro(null)

    const result = await connectGatewayWithApiKeyAction(row.descriptor.id, key)
    setBusy(false)

    if (!result.ok) {
      setErro(result.error.message)
      return
    }

    setKey('')
    const conta = result.data.label ? ` (${result.data.label})` : ''
    onConnected(`${row.descriptor.label} conectado${conta}. Clique em Ativar para usá-lo nas cobranças.`)
  }

  return (
    <Modal open={!!row} onClose={fechar} title={`Conectar ${row?.descriptor.label ?? ''}`} size="sm">
      <div className="space-y-4">
        <p className="text-[13px] text-fg-mute">
          No Asaas, abra <span className="text-fg">Integrações → Chaves de API</span> e crie uma chave
          só para o GoMoto, <span className="text-fg">sem</span> habilitar saque via API. Ela aparece
          uma única vez: copie e cole aqui.
        </p>

        <Input
          label="Chave de API"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="$aact_prod_..."
          value={key}
          autoFocus
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submeter() }}
          error={erro ?? undefined}
          hint="Chaves com permissão de saque são recusadas: o GoMoto só precisa gerar e consultar cobranças."
        />

        <p className="text-[12px] text-fg-mute">
          Ao conectar, o GoMoto cadastra um webhook na sua conta Asaas para saber quando cada Pix é pago.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={fechar}>
            Cancelar
          </Button>
          <Button size="sm" loading={busy} disabled={!key.trim()} onClick={() => void submeter()}>
            Conectar
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function StatusBadge({
  descriptor, connected, billing,
}: {
  descriptor: PaymentProviderDescriptor
  connected: boolean
  billing: boolean
}) {
  const base = 'text-[11px] px-2 py-0.5 rounded-full border'

  if (billing) {
    return <span className={cn(base, 'bg-success-bg border-success text-success')}>Gerando cobranças</span>
  }
  if (connected) {
    return <span className={cn(base, 'bg-surface-2 border-border text-fg-mute')}>Conectado</span>
  }
  if (!descriptor.available) {
    return <span className={cn(base, 'bg-surface-2 border-border text-fg-mute')}>Em breve</span>
  }
  return null
}
