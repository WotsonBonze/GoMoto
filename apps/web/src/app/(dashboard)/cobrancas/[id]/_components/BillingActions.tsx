'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { usePaymentIntentStatus } from '@gomoto/data'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { formatCurrency } from '@/lib/utils'
import { type LateChargePolicy } from '@gomoto/core'
import { RegistrarPagamentoModal, type CobrancaParaPagamento } from '@/components/financial/RegistrarPagamentoModal'
import { cancelChargeAction } from '../../actions'
import { applyCustomerCredits, generateChargePixAction } from '../actions'
import type { PaymentIntentResult } from '@/lib/payment/intents'

interface AvailableCredit {
  id: string
  amount: number
  available_balance: number
  origin: string
  reason: string
}

interface BillingActionsProps {
  billingId: string
  customerId: string
  status: string
  amountDue: number
  /** Tudo que o modal compartilhado precisa para identificar a cobrança e
   *  recalcular o devido na data do recebimento. */
  cobranca: CobrancaParaPagamento
  latePolicy: LateChargePolicy | null
  /**
   * Meio que o gateway ELEITO gera — `pix`, `payment_link`, ou `null` quando
   * não há gateway ativo.
   *
   * Vem do servidor porque o botão precisa dizer a verdade ANTES de gerar. O
   * rótulo era "Gerar Pix" fixo, o que funcionava enquanto todo gateway gerava
   * Pix; com um checkout hospedado eleito ele prometeria um QR e entregaria uma
   * URL.
   */
  gatewayMethod: string | null
  availableCredits: AvailableCredit[]
  /** Saldo de crédito do cliente — um POOL, vindo do razão.
   *
   *  Cada linha de `availableCredits` carrega este MESMO número em
   *  `available_balance`: somá-las multiplicaria o saldo pela quantidade de
   *  créditos concedidos. Por isso ele vem separado, uma vez só. */
  creditBalance: number
}


// A origem gravada em `customer_credits.origin` é o `source_module` de quem
// gerou o crédito. Faltavam justamente os que o produto cria hoje —
// 'maintenance', 'expense', 'manual' —, então o seletor exibia a chave crua em
// inglês: "maintenance — saldo R$ 300,00".
const CREDIT_ORIGIN_LABELS: Record<string, string> = {
  maintenance:        'Manutenção',
  maintenance_refund: 'Estorno manutenção',
  expense:            'Despesa',
  fine:               'Multa',
  manual:             'Lançamento manual',
  manual_adjustment:  'Ajuste manual',
  reversal:           'Estorno',
  customer_credit:    'Crédito ao cliente',
}

/**
 * Código copia-e-cola do Pix, venha do gateway que vier.
 *
 * `emv` é o campo canônico (ADR 0031 §4). `qr_code` é como o Mercado Pago o
 * nomeia e continua sendo gravado; a Cora só devolve `emv`. Ler os dois aqui
 * evita que a tela precise saber qual gateway gerou a cobrança.
 */
function emvDe(intent: PaymentIntentResult | null): string {
  const p = intent?.payload
  if (!p) return ''
  const emv = p.emv ?? p.qr_code
  return typeof emv === 'string' ? emv : ''
}

/** PNG do QR. Gerado no servidor quando o provedor não o entrega (ADR 0031 §4). */
function qrPngDe(intent: PaymentIntentResult | null): string {
  const b64 = intent?.payload?.qr_code_base64
  return typeof b64 === 'string' && b64 ? `data:image/png;base64,${b64}` : ''
}

/**
 * URL do checkout hospedado (ADR 0032).
 *
 * Chave própria, deliberadamente fora do vocabulário do Pix. Se a InfinitePay
 * gravasse a URL em `emv`, esta tela mostraria uma URL como copia-e-cola e o
 * cliente tentaria colá-la no app do banco.
 */
function checkoutUrlDe(intent: PaymentIntentResult | null): string {
  const url = intent?.payload?.checkout_url
  return typeof url === 'string' ? url : ''
}

/** Rótulo do que o gateway eleito vai gerar. */
function rotuloDoMeio(method: string | null): { acao: string; gerando: string; titulo: string } {
  if (method === 'payment_link') {
    return { acao: 'Gerar link de pagamento', gerando: 'Gerando link...', titulo: 'Link de pagamento' }
  }
  return { acao: 'Gerar Pix', gerando: 'Gerando Pix...', titulo: 'Cobrança Pix' }
}

export function BillingActions({ billingId, customerId, status, amountDue, cobranca, latePolicy, gatewayMethod, availableCredits, creditBalance }: BillingActionsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [flashError, setFlashError] = useState<string | null>(null)

  const [payOpen, setPayOpen]     = useState(false)
  const [creditOpen, setCreditOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  // Pix do gateway ativo. `intent` só existe depois que a action volta — não há
  // estado "gerando" separado porque `isPending` já cobre, e o botão some
  // enquanto isso.
  const [intent, setIntent] = useState<PaymentIntentResult | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [pago, setPago] = useState(false)

  // O pagamento chega por WEBHOOK, fora do navegador. Sem acompanhar, a tela
  // segue exibindo o QR de uma cobrança já quitada — e o botão de gerar Pix
  // continua aparecendo numa cobrança paga.
  //
  // O poll para assim que confirma (`!pago`) e quando o modal fecha (`!!intent`).
  const intentStatus = usePaymentIntentStatus(intent?.intent_id, !!intent && !pago)

  useEffect(() => {
    if (!intent || pago) return
    if (intentStatus.data !== 'paid') return

    setPago(true)
    // `router.refresh()` reexecuta o Server Component: o status vira 'paid', e
    // com ele somem os botões de ação — inclusive o de gerar Pix. Era o segundo
    // sintoma da mesma causa, não um bug separado.
    router.refresh()
  }, [intentStatus.data, intent, pago, router])

  // Register Payment form

  // O SELETOR de crédito saiu. O saldo é um POOL por cliente, derivado de
  // `creditos_de_clientes` no razão; as linhas de `customer_credits` guardam o
  // que foi concedido, não o que resta. Escolher entre elas era decisão sem
  // efeito — e a action nem recebia a escolha.
  const saldoDeCredito = creditBalance

  /**
   * Dois tetos, porque abater só o que já é dívida (`open_amount`) e quitar
   * TUDO (incluindo o juros até hoje, `amountDue`) são ações diferentes — a
   * segunda lança encargo na hora, a primeira não (ver `applyCustomerCredits`).
   *
   * `tetoSemJuros` é o que o crédito abate sem tocar em juros: nunca mais que
   * o saldo, nunca mais que a dívida já lançada. É o valor SEGURO, e o que o
   * campo sugere por padrão — o operador só entra na zona de juros se digitar
   * mais que isso, ou clicar em "quitar tudo" explicitamente.
   *
   * `tetoComJuros` é o limite real do banco: saldo e o total devido HOJE,
   * incluindo o encargo ainda em projeção. Passar de `tetoSemJuros` até aqui é
   * válido, mas realiza o encargo — por isso o campo mostra o aviso dinâmico
   * abaixo assim que o valor digitado ultrapassa `tetoSemJuros`.
   */
  const tetoSemJuros = Math.round(Math.min(saldoDeCredito, cobranca.openAmount) * 100) / 100
  const tetoComJuros = Math.round(Math.min(saldoDeCredito, amountDue) * 100) / 100
  const tetoDoCredito = tetoComJuros

  // Nasce preenchido com o teto SEM juros: é o abatimento que o operador quer
  // no caso comum, e não lança encargo nenhum por padrão. Um campo vazio com
  // placeholder cinza já foi confundido com campo preenchido — clicava em
  // Aplicar e recebia "Valor inválido". Quem quer quitar tudo, juros incluído,
  // digita mais ou usa o atalho abaixo — decisão explícita, não default.
  const [creditAmount, setCreditAmount] = useState(() =>
    tetoSemJuros > 0 ? tetoSemJuros.toFixed(2) : '')

  /** Este valor avança sobre o que ainda é projeção — vai lançar encargo. */
  const valorIncluiJuros = (parseFloat(creditAmount) || 0) > tetoSemJuros + 0.004
  /** Dá para quitar a cobrança inteira, juros de hoje incluído, só com crédito. */
  const podeQuitarTudo = tetoComJuros > tetoSemJuros && saldoDeCredito >= tetoComJuros - 0.004

  // Vencida é estado DERIVADO de uma cobrança aberta, não um status terminal:
  // a página envia 'overdue' no lugar de 'open' quando há atraso. Comparar com
  // 'open' escondia a barra inteira — pagar, cancelar, dar baixa, consolidar —
  // exatamente na cobrança que mais precisa de ação.
  const isActionable = status === 'open' || status === 'overdue'
  const hasCredits = availableCredits.length > 0 && isActionable

  function handleCredit() {
    const amount = Math.round((parseFloat(creditAmount) || 0) * 100) / 100
    if (amount <= 0) { setFlashError('Informe um valor maior que zero.'); return }
    if (amount > tetoDoCredito) {
      setFlashError(
        `O máximo aqui é ${formatCurrency(tetoDoCredito)} — o menor entre o saldo `
        + 'de crédito do cliente e o que esta cobrança deve hoje, juros incluído.',
      )
      return
    }
    setFlashError(null)
    startTransition(async () => {
      // Dirigido: este valor, NESTA cobrança. A versão anterior mandava só o
      // cliente e a action varria o saldo para as cobranças mais antigas —
      // podia abater numa que o operador nem tinha aberto.
      const result = await applyCustomerCredits({
        customer_id: customerId,
        charge_id: billingId,
        amount,
      })
      if (!result.ok) { setFlashError(result.error.message); return }
      setCreditOpen(false)
      setCreditAmount('')
    })
  }

  /** Rótulos do gateway eleito antes de gerar; do intent depois que ele existe. */
  const rotulo = rotuloDoMeio(intent?.method ?? gatewayMethod)
  const ehLink = !!checkoutUrlDe(intent)

  function handleGeneratePix() {
    setFlashError(null)
    startTransition(async () => {
      const result = await generateChargePixAction(billingId)
      if (!result.ok) { setFlashError(result.error.message); return }
      setIntent(result.data)
      setCopiado(false)
      setPago(false)
    })
  }

  async function copiarCodigo() {
    // Pix copia o EMV; checkout hospedado copia a URL. É a mesma ação para o
    // operador — "manda isso para o cliente" — e o que muda é só o conteúdo.
    const codigo = emvDe(intent) || checkoutUrlDe(intent)
    if (!codigo) return
    try {
      await navigator.clipboard.writeText(codigo)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2500)
    } catch {
      // Área de transferência bloqueada (http, permissão negada). O código está
      // selecionável na tela — não vale derrubar o modal por causa disso.
      setFlashError('Não foi possível copiar. Selecione o código manualmente.')
    }
  }

  function handleCancel() {
    setFlashError(null)
    startTransition(async () => {
      const result = await cancelChargeAction({ charge_id: billingId, reason: 'Cancelada pelo operador' })
      if (!result.ok) { setFlashError(result.error.message); return }
      setCancelOpen(false)
    })
  }

  return (
    <>
      {flashError && (
        <div className="rounded-xl border border-danger bg-danger-bg px-4 py-3">
          <p className="text-[13px] text-danger">{flashError}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {isActionable && (
          <button
            onClick={() => { setFlashError(null); setPayOpen(true) }}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-bg transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            Registrar pagamento
          </button>
        )}
        {hasCredits && (
          <button
            onClick={() => { setFlashError(null); setCreditOpen(true) }}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg disabled:opacity-50"
          >
            Aplicar crédito
          </button>
        )}
        {isActionable && (
          <button
            onClick={handleGeneratePix}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg disabled:opacity-50"
          >
            {isPending && !intent ? rotulo.gerando : rotulo.acao}
          </button>
        )}
        {isActionable && (
          <button
            onClick={() => { setFlashError(null); setCancelOpen(true) }}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-danger bg-danger-bg px-4 text-[13px] text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
          >
            Cancelar cobrança
          </button>
        )}
      </div>

      {/* Implementação única, a mesma da lista de cobranças. */}
      <RegistrarPagamentoModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        cobranca={cobranca}
        policy={latePolicy}
      />

      {/* ── Pix do gateway ativo ───────────────────────────────────────────── */}
      <Modal open={!!intent} onClose={() => { setIntent(null); setPago(false) }} title={rotulo.titulo} size="sm">
        <div className="space-y-4">
          {pago && (
            <div className="rounded-lg border border-success bg-success-bg px-3 py-2.5 text-center">
              <p className="text-[14px] font-semibold text-success">Pagamento confirmado!</p>
              <p className="text-[12px] text-fg-mute mt-0.5">
                A cobrança foi quitada e o recebimento já está no financeiro.
              </p>
            </div>
          )}
          {!pago && intent?.is_reused && (
            <p className="rounded-lg border border-divider bg-surface-2 px-3 py-2 text-[12px] text-fg-mute">
              {ehLink
                ? 'Este link já existia e continua válido. Gerar outro cobraria a mesma dívida duas vezes, então o mesmo link é reaproveitado.'
                : 'Este Pix já existia e continua válido. Gerar um novo cobraria a mesma dívida duas vezes, então o mesmo código é reaproveitado.'}
            </p>
          )}

          <div className="flex flex-col items-center gap-3">
            {!pago && qrPngDe(intent) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrPngDe(intent)}
                alt="QR code do Pix"
                className="h-[220px] w-[220px] rounded-lg bg-white p-2"
              />
            ) : null}

            <div className="text-center">
              <p className="text-[20px] font-semibold text-fg">{formatCurrency(intent?.amount ?? 0)}</p>
              <p className="text-[12px] text-fg-mute">
                via {intent?.provider_label ?? intent?.provider}
                {intent?.expires_at
                  ? ` · vence em ${new Date(intent.expires_at).toLocaleString('pt-BR')}`
                  : ''}
              </p>
            </div>
          </div>

          {!pago && (
          <div className="space-y-1.5">
            <p className="text-[12px] text-fg-mute">{ehLink ? 'Link do checkout' : 'Copia e cola'}</p>
            <p className="max-h-24 overflow-y-auto break-all rounded-lg border border-divider bg-surface-2 px-3 py-2 font-mono text-[11px] text-fg">
              {ehLink ? checkoutUrlDe(intent) : emvDe(intent)}
            </p>
            {/* O cliente escolhe Pix ou cartão na página do provedor, não aqui.
                Dizer isso evita que o operador procure um QR que não existe. */}
            {ehLink && (
              <a
                href={checkoutUrlDe(intent)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-[12px] text-primary hover:underline"
              >
                Abrir checkout
              </a>
            )}
          </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setIntent(null); setPago(false) }}
              className="inline-flex h-9 items-center rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
            >
              Fechar
            </button>
            {!pago && (
              <button
                onClick={copiarCodigo}
                className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[13px] font-semibold text-bg transition-colors hover:bg-primary-hover"
              >
                {copiado ? 'Copiado!' : ehLink ? 'Copiar link' : 'Copiar código'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* ── Aplicar crédito ────────────────────────────────────────────────── */}
      <Modal open={creditOpen} onClose={() => setCreditOpen(false)} title="Aplicar crédito">
        <div className="space-y-4">
          {/* De onde vem e para onde vai, antes de confirmar. O modal antigo
              pedia "qual crédito" — escolha sem efeito, porque o saldo é um
              pool — e mandava só o cliente para a action, que abatia nas
              cobranças mais antigas. Podia nem ser esta. */}
          <div className="rounded-lg border border-divider bg-surface-2 px-3 py-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-fg-mute">Saldo de crédito</span>
              <span className="tabular-nums text-fg">{formatCurrency(saldoDeCredito)}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-fg-mute">Esta cobrança deve (sem juros)</span>
              <span className="tabular-nums text-fg">{formatCurrency(cobranca.openAmount)}</span>
            </div>
            {/* Só aparece quando há o que mostrar: cobrança em dia não tem
                juros previstos, e a linha ficaria dizendo "+ R$ 0,00". */}
            {amountDue > cobranca.openAmount && (
              <>
                <div className="mt-1 flex justify-between text-warning">
                  <span>+ Juros previstos até hoje</span>
                  <span className="tabular-nums">{formatCurrency(amountDue - cobranca.openAmount)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-divider pt-1">
                  <span className="text-fg-mute">Se quitar tudo agora</span>
                  <span className="tabular-nums text-fg">{formatCurrency(amountDue)}</span>
                </div>
              </>
            )}
            <div className="mt-1 flex justify-between border-t border-divider pt-1">
              <span className="text-fg-mute">Pode abater até</span>
              <span className="tabular-nums font-semibold text-fg">{formatCurrency(tetoDoCredito)}</span>
            </div>
            {availableCredits.length > 0 && (
              <p className="mt-2 text-[12px] text-fg-mute">
                Origem: {[...new Set(availableCredits.map(c => CREDIT_ORIGIN_LABELS[c.origin] ?? c.origin))].join(', ')}.
              </p>
            )}
          </div>

          <Input
            label="Valor a aplicar (R$)"
            type="number"
            step="0.01"
            min="0.01"
            max={tetoDoCredito.toFixed(2)}
            value={creditAmount}
            onChange={e => {
              // Duas casas e teto na digitação, como no modal de recebimento:
              // o campo aceitava qualquer valor e o excesso só era descoberto
              // depois — quando era descoberto.
              const v = e.target.value.replace(/^(\d*[.,]?\d{0,2}).*$/, '$1')
              const n = parseFloat(v)
              if (!isNaN(n) && n > tetoDoCredito) {
                setCreditAmount(tetoDoCredito.toFixed(2))
                setFlashError(`O máximo aqui é ${formatCurrency(tetoDoCredito)}.`)
                return
              }
              setCreditAmount(v)
              setFlashError(null)
            }}
          />

          {/* A ação muda de natureza acima de `tetoSemJuros`, e isso precisa
              estar visível ANTES de confirmar — não só depois, no extrato. */}
          {valorIncluiJuros ? (
            <p className="rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] text-warning">
              Este valor passa do que já é dívida lançada — inclui juros até hoje. Ao confirmar,
              o encargo é calculado e lançado nesta cobrança agora.
            </p>
          ) : podeQuitarTudo ? (
            <button
              type="button"
              onClick={() => { setCreditAmount(tetoComJuros.toFixed(2)); setFlashError(null) }}
              className="text-[12px] text-primary hover:underline"
            >
              Quitar a cobrança inteira agora com o crédito ({formatCurrency(tetoComJuros)}, juros de hoje incluído)
            </button>
          ) : (
            <p className="text-[12px] text-fg-mute">
              Este valor abate só a dívida já lançada. Juros, se houver, só entram ao registrar o
              pagamento do restante, pela data do recebimento.
            </p>
          )}

          {flashError && <p className="text-[13px] text-danger">{flashError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setCreditOpen(false)}
              className="inline-flex h-9 items-center px-4 rounded-full border border-border text-[13px] text-fg-mute hover:text-fg"
            >
              Cancelar
            </button>
            <button
              onClick={handleCredit}
              disabled={isPending}
              className="inline-flex h-9 items-center px-4 rounded-full bg-primary text-[13px] font-semibold text-bg hover:bg-primary-hover disabled:opacity-50"
            >
              {isPending ? 'Salvando…' : 'Aplicar crédito'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Cancelar cobrança ──────────────────────────────────────────────── */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar cobrança">
        <div className="space-y-4">
          <p className="text-[13px] text-fg-mute">
            Esta cobrança será cancelada e não poderá mais ser reativada. Confirma?
          </p>
          {flashError && <p className="text-[13px] text-danger">{flashError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setCancelOpen(false)}
              className="inline-flex h-9 items-center px-4 rounded-full border border-border text-[13px] text-fg-mute hover:text-fg"
            >
              Voltar
            </button>
            <button
              onClick={handleCancel}
              disabled={isPending}
              className="inline-flex h-9 items-center px-4 rounded-full border border-danger bg-danger-bg text-[13px] text-danger transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {isPending ? 'Cancelando…' : 'Confirmar cancelamento'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}
