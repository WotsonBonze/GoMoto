import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useChargeDetail, useMyCharges, useMyPaidCharges, usePaymentIntentStatus } from '@gomoto/data'
import type { MyChargeRow } from '@gomoto/data'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useRefreshOnFocus } from '../hooks/useRefreshOnFocus'
import { useTheme, type ThemeTokens } from '../theme'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  ModalHeader,
  Notice,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  radius,
  toneColors,
  type Tone,
} from '../components/ui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resposta de `POST /api/charges/[id]/payment-intent` (`PaymentIntentResult`
 * em `apps/web/src/lib/payment/intents.ts`).
 *
 * O app não escolhe gateway nem meio: quem decide é a conta que a locadora
 * elegeu (ADR 0030). O que muda de provedor para provedor mora em `payload`,
 * e a tela se orienta por `method`:
 *
 * - `pix` (Mercado Pago, Cora): `payload.emv` + `payload.qr_code_base64`. A
 *   imagem é garantida pelo servidor (`ensureQrImage`, ADR 0031 §4).
 * - `payment_link` (InfinitePay): `payload.checkout_url` — página hospedada
 *   onde o cliente escolhe Pix ou cartão (ADR 0032).
 *
 * Antes o app lia `emv`/`qr_code_base64` no primeiro nível da resposta, onde
 * eles nunca estiveram: QR `base64,undefined` e copia-e-cola vazio para
 * qualquer gateway.
 */
type PaymentIntent = {
  intent_id: string
  provider: string
  provider_label: string
  method: string
  amount: number
  /**
   * `null` quando o gateway não declara validade — é o caso da Cora, cujo Pix
   * não vence sozinho, e do link da InfinitePay.
   */
  expires_at: string | null
  payload: {
    /** Copia-e-cola do Pix. Campo canônico, comum a todo gateway (ADR 0031 §4). */
    emv?: string
    /** Nome legado do copia-e-cola, ainda gravado por MP e Cora. */
    qr_code?: string
    qr_code_base64?: string
    checkout_url?: string
  } | null
  is_reused: boolean
}

type Styles = ReturnType<typeof createStyles>
type Tab = 'open' | 'paid'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `charge_status` (ADR 0024) + `overdue`, derivado de `is_overdue`.
const STATUS_LABEL: Record<string, string> = {
  open:        'Em aberto',
  overdue:     'Vencida',
  paid:        'Paga',
  cancelled:   'Cancelada',
  written_off: 'Baixada',
}

const MONTH_SHORT = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
const MONTH_LONG = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

/** "Vence em breve" — a partir daqui a linha ganha destaque de atenção. */
const SOON_DAYS = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

/**
 * Data de um INSTANTE (timestamptz) no fuso do aparelho. `formatDate` corta os
 * 10 primeiros caracteres, que num instante são a data em UTC: um Pix pago às
 * 22h apareceria como pago no dia seguinte.
 */
function formatLocalDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pt-BR')
}

/**
 * Hoje no fuso do APARELHO. `toISOString()` devolve UTC: depois das 21h no
 * Brasil já é "amanhã", e a cobrança que vence hoje aparecia como vencida.
 */
function localTodayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function daysUntil(isoDate: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(isoDate + 'T00:00:00')
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Origem da cobrança, em linguagem do cliente (não "ciclo"/"avulsa"). */
function kindLabel(billing: MyChargeRow): string {
  return billing.rental_id ? 'Locação' : 'Avulsa'
}

function isOverdue(billing: MyChargeRow, todayIso: string): boolean {
  return billing.is_overdue || (billing.status === 'open' && billing.due_date < todayIso)
}

/**
 * Tom visual de uma cobrança, derivado de status + vencimento: vencida
 * (danger), vence hoje (warning), em até SOON_DAYS (pending), futura
 * (primary), paga (success), cancelada/baixada (neutral).
 */
function toneOf(billing: MyChargeRow, todayIso: string): Tone {
  if (billing.status === 'paid') return 'success'
  if (billing.status !== 'open') return 'neutral'
  if (isOverdue(billing, todayIso)) return 'danger'
  const days = daysUntil(billing.due_date)
  if (days === 0) return 'warning'
  if (days <= SOON_DAYS) return 'pending'
  return 'primary'
}

/** Frase curta de vencimento: o que o cliente precisa saber de relance. */
function dueLabel(billing: MyChargeRow, todayIso: string): string {
  if (billing.status === 'paid') {
    return billing.paid_at
      ? `Pago em ${formatLocalDate(billing.paid_at)}`
      : `Venceu em ${formatDate(billing.due_date)}`
  }
  if (billing.status !== 'open') return STATUS_LABEL[billing.status] ?? billing.status
  if (isOverdue(billing, todayIso)) {
    const days = billing.days_overdue || Math.max(0, -daysUntil(billing.due_date))
    return days === 0 ? 'Venceu hoje' : `${plural(days, 'dia', 'dias')} de atraso`
  }
  const days = daysUntil(billing.due_date)
  if (days === 0) return 'Vence hoje'
  if (days === 1) return 'Vence amanhã'
  return `Vence em ${days} dias`
}

const OFFLINE_MESSAGE = 'Sem conexão com o servidor. Verifique a internet e tente de novo.'
const SESSION_EXPIRED_MESSAGE = 'Sua sessão expirou. Entre novamente.'
/** Inclui a ida ao gateway, que pode levar alguns segundos. */
const INTENT_TIMEOUT_MS = 30_000

/**
 * Token para a API. Falha ao renovar por rede não é sessão inválida: a sessão
 * continua salva, então a mensagem é de conexão. Quando o refresh token é
 * recusado, o auth-js já apaga a sessão e emite SIGNED_OUT — o RootGate leva
 * ao login.
 */
async function getAccessToken(forceRefresh: boolean): Promise<string> {
  const { data, error } = forceRefresh
    ? await supabase.auth.refreshSession()
    : await supabase.auth.getSession()
  if (error) throw new Error(isAuthRetryableFetchError(error) ? OFFLINE_MESSAGE : SESSION_EXPIRED_MESSAGE)
  if (!data.session) throw new Error(SESSION_EXPIRED_MESSAGE)
  return data.session.access_token
}

async function postPaymentIntent(webUrl: string, billingId: string, token: string): Promise<Response> {
  // AbortController + setTimeout em vez de AbortSignal.timeout, que o Hermes não garante.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS)
  try {
    // Sem `method` no corpo: o default é o meio principal do gateway eleito,
    // resolvido no servidor. Pedir `pix` aqui quebraria a InfinitePay.
    return await fetch(`${webUrl}/api/charges/${billingId}/payment-intent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    })
  } catch {
    throw new Error(OFFLINE_MESSAGE)
  } finally {
    clearTimeout(timer)
  }
}

async function createPaymentIntent(billingId: string): Promise<PaymentIntent> {
  const webUrl = process.env.EXPO_PUBLIC_WEB_URL ?? ''
  if (!webUrl) throw new Error('EXPO_PUBLIC_WEB_URL não configurado')

  let res = await postPaymentIntent(webUrl, billingId, await getAccessToken(false))
  // 401 = o servidor recusou o token (vencido pelo relógio real, sessão
  // revogada). Renova uma vez e repete; se a renovação for recusada, a sessão
  // cai e o app volta para o login.
  if (res.status === 401) {
    res = await postPaymentIntent(webUrl, billingId, await getAccessToken(true))
    if (res.status === 401) {
      await supabase.auth.signOut({ scope: 'local' })
      throw new Error(SESSION_EXPIRED_MESSAGE)
    }
  }

  const json = await res.json().catch(() => null)
  if (!json?.ok) throw new Error(json?.error?.message ?? 'Falha ao gerar pagamento')
  return json.data as PaymentIntent
}

/** Copia-e-cola do Pix, pelo nome canônico ou pelo legado. */
function pixCodeOf(intent: PaymentIntent): string | null {
  return intent.payload?.emv || intent.payload?.qr_code || null
}

/**
 * Abre o checkout hospedado num navegador DENTRO do app (Custom Tabs no
 * Android, SFSafariViewController no iOS): o cliente paga e fecha, sem se
 * perder entre apps — `Linking.openURL` jogaria para o navegador externo.
 */
async function openCheckout(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    })
  } catch {
    Alert.alert('Erro', 'Não foi possível abrir a página de pagamento.')
  }
}

// ---------------------------------------------------------------------------
// SummaryCard — "quanto devo e o que pagar primeiro", na superfície de marca
// ---------------------------------------------------------------------------

function SummaryCard({
  total,
  overdueCount,
  overdueTotal,
  urgent,
  todayIso,
  onOpenUrgent,
  styles,
  theme,
}: {
  total: number
  overdueCount: number
  overdueTotal: number
  urgent: MyChargeRow | null
  todayIso: string
  onOpenUrgent: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  const hasOverdue = overdueCount > 0
  const statusColor = hasOverdue ? theme.brandNegative : theme.brandPositive

  return (
    <Card variant="brand" style={styles.summary}>
      <View style={styles.summaryTop}>
        <Text style={styles.summaryLabel}>Total a pagar</Text>
        <Icon name="wallet-outline" size={20} color={theme.brandAccent} />
      </View>
      <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
        {formatCurrency(total)}
      </Text>

      <View style={styles.summaryStatus}>
        <Icon
          name={hasOverdue ? 'alert-circle' : 'checkmark-circle'}
          size={15}
          color={statusColor}
        />
        <Text style={[styles.summaryStatusText, { color: statusColor }]}>
          {hasOverdue
            ? `${plural(overdueCount, 'cobrança vencida', 'cobranças vencidas')} · ${formatCurrency(overdueTotal)}`
            : total > 0 ? 'Tudo em dia' : 'Nenhuma cobrança em aberto'}
        </Text>
      </View>

      {urgent && (
        <>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryNext}>
            <View style={styles.summaryNextBody}>
              <Text style={styles.summaryNextLabel}>
                {hasOverdue ? 'Mais antiga em atraso' : 'Próximo vencimento'}
              </Text>
              <Text style={styles.summaryNextTitle} numberOfLines={1}>{urgent.description}</Text>
              <Text style={styles.summaryNextMeta} numberOfLines={1}>
                {dueLabel(urgent, todayIso)} · {formatCurrency(urgent.amount_due)}
              </Text>
            </View>
            <Button
              label={hasOverdue ? 'Regularizar' : 'Pagar'}
              variant={hasOverdue ? 'danger' : 'onBrand'}
              size="md"
              onPress={onOpenUrgent}
            />
          </View>
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// DateBadge — dia/mês do vencimento, padrão de extrato bancário
// ---------------------------------------------------------------------------

function DateBadge({ iso, tone, styles, theme }: { iso: string; tone: Tone; styles: Styles; theme: ThemeTokens }) {
  const [, m, d] = iso.split('-')
  const { fg, bg } = toneColors(theme, tone)
  return (
    <View style={[styles.dateBadge, { backgroundColor: bg }]}>
      <Text style={[styles.dateBadgeDay, { color: fg }]}>{d}</Text>
      <Text style={[styles.dateBadgeMonth, { color: fg }]}>{MONTH_SHORT[Number(m) - 1]}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// ChargeRow — linha única para "a pagar" e "pagas"
// ---------------------------------------------------------------------------

function ChargeRow({
  billing,
  todayIso,
  onPress,
  styles,
  theme,
  last,
}: {
  billing: MyChargeRow
  todayIso: string
  onPress: () => void
  styles: Styles
  theme: ThemeTokens
  last?: boolean
}) {
  const tone = toneOf(billing, todayIso)
  const { fg } = toneColors(theme, tone)
  const isPaid = billing.status === 'paid'
  const partial = !isPaid && billing.paid_amount > 0
  const meta = [kindLabel(billing), billing.vehicle_plate].filter(Boolean).join(' · ')
  const amount = isPaid ? billing.paid_amount : billing.amount_due

  return (
    <Pressable
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${billing.description}, ${formatCurrency(amount)}, ${dueLabel(billing, todayIso)}`}
    >
      <DateBadge iso={billing.due_date} tone={tone} styles={styles} theme={theme} />

      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{billing.description}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{meta}</Text>
        {isPaid ? (
          billing.paid_at ? (
            <Text style={[styles.rowDue, { color: theme.textSoft }]}>{dueLabel(billing, todayIso)}</Text>
          ) : null
        ) : (
          <Text style={[styles.rowDue, { color: tone === 'primary' ? theme.textSoft : fg }]}>
            {dueLabel(billing, todayIso)}
          </Text>
        )}
      </View>

      <View style={styles.rowRight}>
        <Text
          style={[
            styles.rowAmount,
            tone === 'danger' && { color: theme.danger },
          ]}
        >
          {formatCurrency(amount)}
        </Text>
        {isPaid ? (
          <Badge label="Paga" tone="success" icon="checkmark" size="sm" />
        ) : partial ? (
          <Text style={styles.rowAmountSub}>de {formatCurrency(billing.total_amount)}</Text>
        ) : null}
      </View>
      <Icon name="chevron-forward" size={18} color={theme.textMute} />
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// PaymentModal
// ---------------------------------------------------------------------------

/**
 * Tela de pagamento, desenhada pelo `method` que o gateway eleito devolveu.
 *
 * O seletor "Pix / Boleto / Cartão" que existia antes foi removido: o app não
 * escolhe meio nenhum (o servidor usa o do gateway da locadora), então ele
 * prometia uma escolha que não existia.
 */
function PaymentModal({
  billing,
  intent,
  paid,
  onClose,
  styles,
  theme,
}: {
  billing: MyChargeRow
  intent: PaymentIntent
  paid: boolean
  onClose: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  const [copied, setCopied] = useState(false)
  const isLink  = intent.method === 'payment_link'
  const isPix   = intent.method === 'pix'
  const pixCode = pixCodeOf(intent)
  const qrImage = intent.payload?.qr_code_base64
  const url     = intent.payload?.checkout_url
  // O valor da tentativa, não o da lista: é o que o código cobra.
  const amount  = intent.amount ?? billing.amount_due

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(t)
  }, [copied])

  function copyCode() {
    if (!pixCode) return
    void Clipboard.setStringAsync(pixCode)
    setCopied(true)
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom']}>
        <ModalHeader title={isPix ? 'Pagar com Pix' : 'Pagamento'} onClose={onClose} />

        {paid ? (
          <View style={styles.successWrap}>
            <View style={styles.successIcon}>
              <Icon name="checkmark" size={48} color={theme.success} />
            </View>
            <Text style={styles.successTitle}>Pagamento confirmado</Text>
            <Text style={styles.successAmount}>{formatCurrency(amount)}</Text>
            <Text style={styles.successText}>{billing.description}</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Valor + estado da espera — o polling roda enquanto o detalhe estiver aberto */}
            <View style={styles.payHero}>
              <Text style={styles.heroLabel}>Valor</Text>
              <Text style={styles.heroAmount}>{formatCurrency(amount)}</Text>
              <Text style={styles.payHeroSub} numberOfLines={1}>
                {billing.description} · via {intent.provider_label}
              </Text>
              <View style={styles.waiting}>
                <ActivityIndicator size="small" color={theme.primary} />
                <Text style={styles.waitingText}>Aguardando pagamento</Text>
              </View>
            </View>

            {isPix && pixCode ? (
              <>
                {qrImage ? (
                  <View style={styles.qrWrap}>
                    <Image
                      source={{ uri: `data:image/png;base64,${qrImage}` }}
                      style={styles.qrImage}
                      resizeMode="contain"
                    />
                  </View>
                ) : null}

                <Button
                  label={copied ? 'Código copiado' : 'Copiar código Pix'}
                  icon={copied ? 'checkmark' : 'copy-outline'}
                  variant={copied ? 'success' : 'primary'}
                  onPress={copyCode}
                />

                <View style={styles.codeBox}>
                  <Text style={styles.codeLabel}>Pix copia e cola</Text>
                  <Text style={styles.code} selectable numberOfLines={3}>{pixCode}</Text>
                </View>

                <Card>
                  <Text style={styles.cardTitle}>Como pagar</Text>
                  <View style={styles.steps}>
                    {[
                      'Copie o código acima ou leia o QR Code.',
                      'No app do seu banco, escolha Pix › Pix copia e cola.',
                      'Cole o código e confirme. A confirmação aparece aqui sozinha.',
                    ].map((step, i) => (
                      <View key={i} style={styles.step}>
                        <View style={styles.stepNum}>
                          <Text style={styles.stepNumText}>{i + 1}</Text>
                        </View>
                        <Text style={styles.stepText}>{step}</Text>
                      </View>
                    ))}
                  </View>
                </Card>

                {intent.expires_at ? (
                  <Text style={styles.footnote}>
                    Código válido até {formatDate(intent.expires_at)}
                  </Text>
                ) : null}
              </>
            ) : null}

            {isLink && url ? (
              <>
                <Notice
                  icon="lock-closed"
                  tone="primary"
                  text={`O pagamento é feito na página segura da ${intent.provider_label}, onde você escolhe Pix ou cartão. Ao terminar, feche a página e volte para cá — a confirmação aparece automaticamente.`}
                />
                <Button
                  label="Abrir página de pagamento"
                  icon="open-outline"
                  onPress={() => void openCheckout(url)}
                />
              </>
            ) : null}

            {/* Gateway novo que esta versão do app ainda não sabe desenhar, ou
                payload incompleto: dizer isso em vez de mostrar um QR vazio. */}
            {!(isPix && pixCode) && !(isLink && url) && (
              <Notice
                icon="warning"
                tone="warning"
                text="Esta forma de pagamento ainda não é suportada nesta versão do app. Atualize o aplicativo ou fale com a locadora."
              />
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Peças do modal
// ---------------------------------------------------------------------------

function InfoRow({ label, value, styles, last }: { label: string; value: string; styles: Styles; last?: boolean }) {
  return (
    <View style={[styles.infoRow, !last && styles.infoRowDivider]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// BillingDetailModal
// ---------------------------------------------------------------------------

function BillingDetailModal({
  billing,
  todayIso,
  onClose,
  onPaid,
  styles,
  theme,
}: {
  billing: MyChargeRow
  todayIso: string
  onClose: () => void
  /** Pagamento confirmado pelo gateway — a tela recarrega a lista e fecha. */
  onPaid?: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  const [generating, setGenerating] = useState(false)
  const [intent, setIntent]         = useState<PaymentIntent | null>(null)
  const [paid, setPaid]             = useState(false)
  // Fechar o modal de pagamento NÃO encerra a tentativa: o Pix pode compensar
  // depois, e o polling segue enquanto o detalhe estiver aberto.
  const [showPayment, setShowPayment] = useState(false)

  // Itens do documento (a lista só traz o principal). A política
  // `customer_read_own_charge_items` deixa o cliente ler os próprios.
  const detail = useChargeDetail(billing.charge_id)
  const items = detail.data?.items ?? []

  // Confirmação: o MESMO mecanismo do cockpit (`BillingActions.tsx`) — lê o
  // status da tentativa a cada 5s até virar `paid`. O pagamento chega por
  // webhook, fora do app; a política `customer_read_own_payment_intents`
  // deixa o cliente ler a própria tentativa.
  //
  // Antes o app esperava a cobrança aparecer como `paid` em `useMyCharges(true)`
  // — que só devolve cobranças EM ABERTO. Paga, a cobrança sumia da lista e o
  // "Pagamento confirmado!" nunca aparecia.
  const intentStatus = usePaymentIntentStatus(intent?.intent_id, !!intent && !paid)

  useEffect(() => {
    if (!intent || paid || intentStatus.data !== 'paid') return
    setPaid(true)
    setShowPayment(true)
    // iOS: fecha o checkout hospedado se o cliente ainda estiver nele. No
    // Android não há como fechar a Custom Tab pelo app (a chamada rejeita);
    // ele volta sozinho.
    Promise.resolve()
      .then(() => WebBrowser.dismissBrowser())
      .catch(() => { /* nada aberto, ou plataforma sem suporte */ })
  }, [intentStatus.data, intent, paid])

  // Timer em efeito PRÓPRIO: no efeito acima, `setPaid(true)` o reexecutaria e
  // o cleanup cancelaria o fechamento antes de ele acontecer.
  useEffect(() => {
    if (!paid) return
    const t = setTimeout(() => onPaid?.(), 2500)
    return () => clearTimeout(t)
  }, [paid, onPaid])

  const isPaid  = billing.status === 'paid'
  const canPay  = billing.status === 'open'
  const tone    = toneOf(billing, todayIso)
  const colors  = toneColors(theme, tone)
  // Atraso não é status armazenado (Princípio 4): vem de `is_overdue`.
  const statusKey = tone === 'danger' ? 'overdue' : billing.status
  const overdueDays = billing.days_overdue

  async function handlePay() {
    setGenerating(true)
    try {
      const result = await createPaymentIntent(billing.charge_id)
      setIntent(result)
      setShowPayment(true)
      // Checkout hospedado: abre direto, o modal fica por trás para reabrir.
      const url = result.payload?.checkout_url
      if (result.method === 'payment_link' && url) void openCheckout(url)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao gerar pagamento'
      Alert.alert('Erro', msg)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom']}>
          <ModalHeader title={`Cobrança nº ${billing.charge_number}`} onClose={onClose} />

          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Hero: status + valor + vencimento */}
            <View style={styles.detailHero}>
              <Badge label={STATUS_LABEL[statusKey] ?? statusKey} tone={tone} dot />
              <Text style={[styles.heroLabel, styles.heroLabelSpaced]}>
                {isPaid ? 'Valor pago' : 'Valor a pagar'}
              </Text>
              <Text style={[styles.heroAmount, tone === 'danger' && { color: theme.danger }]}>
                {formatCurrency(isPaid ? billing.paid_amount : billing.amount_due)}
              </Text>
              <Text style={[styles.detailHeroDue, { color: tone === 'primary' || isPaid ? theme.textSoft : colors.fg }]}>
                {isPaid
                  ? `Vencimento ${formatDate(billing.due_date)}`
                  : `${dueLabel(billing, todayIso)} · ${formatDate(billing.due_date)}`}
              </Text>
            </View>

            {tone === 'danger' && (
              <Notice
                icon="alert-circle"
                tone="danger"
                title="Cobrança vencida"
                text={billing.accrued_total > 0
                  ? `Foram acrescidos ${formatCurrency(billing.accrued_total)} de encargos por ${plural(overdueDays, 'dia', 'dias')} de atraso. Pague o quanto antes para evitar novos acréscimos.`
                  : 'Pague o quanto antes para evitar encargos por atraso.'}
              />
            )}

            {isPaid && (
              <Notice
                icon="checkmark-circle"
                tone="success"
                title="Cobrança quitada"
                text={`Total recebido: ${formatCurrency(billing.paid_amount)}`}
              />
            )}

            {/* Composição: itens do documento + ajustes */}
            <Card>
              <Text style={styles.cardTitle}>Composição</Text>
              <View style={styles.lines}>
                {detail.isLoading ? (
                  <ActivityIndicator size="small" color={theme.primary} style={styles.inlineLoading} />
                ) : items.length > 0 ? (
                  items.map((item) => (
                    <View key={item.id} style={styles.lineRow}>
                      <Text style={styles.lineLabel} numberOfLines={2}>
                        {item.quantity > 1 ? `${item.quantity}× ` : ''}{item.description}
                      </Text>
                      <Text style={[styles.lineValue, item.amount < 0 && { color: theme.success }]}>
                        {item.amount < 0 ? `− ${formatCurrency(-item.amount)}` : formatCurrency(item.amount)}
                      </Text>
                    </View>
                  ))
                ) : (
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>{billing.description}</Text>
                    <Text style={styles.lineValue}>{formatCurrency(billing.total_amount)}</Text>
                  </View>
                )}

                {(billing.paid_amount > 0 && !isPaid) || billing.accrued_total > 0 ? (
                  <>
                    <View style={styles.lineDivider} />
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabelMuted}>Subtotal</Text>
                      <Text style={styles.lineValue}>{formatCurrency(billing.total_amount)}</Text>
                    </View>
                  </>
                ) : null}

                {billing.paid_amount > 0 && !isPaid && (
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabelMuted}>Já pago</Text>
                    <Text style={[styles.lineValue, { color: theme.success }]}>
                      − {formatCurrency(billing.paid_amount)}
                    </Text>
                  </View>
                )}

                {billing.accrued_total > 0 && (
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabelMuted}>
                      Encargos ({plural(overdueDays, 'dia', 'dias')} de atraso)
                    </Text>
                    <Text style={[styles.lineValue, { color: theme.danger }]}>
                      + {formatCurrency(billing.accrued_total)}
                    </Text>
                  </View>
                )}

                <View style={styles.lineDivider} />
                <View style={styles.lineRow}>
                  <Text style={styles.lineTotalLabel}>{isPaid ? 'Total pago' : 'Total a pagar'}</Text>
                  <Text style={styles.lineTotalValue}>
                    {formatCurrency(isPaid ? billing.paid_amount : billing.amount_due)}
                  </Text>
                </View>
              </View>
            </Card>

            {/* Dados do documento */}
            <Card>
              <Text style={styles.cardTitle}>Detalhes</Text>
              <View style={styles.lines}>
                <InfoRow label="Origem" value={kindLabel(billing)} styles={styles} />
                {billing.vehicle_plate ? <InfoRow label="Veículo" value={billing.vehicle_plate} styles={styles} /> : null}
                <InfoRow label="Emissão" value={formatDate(billing.issue_date)} styles={styles} />
                <InfoRow label="Vencimento" value={formatDate(billing.due_date)} styles={styles} />
                {isPaid && billing.paid_at ? (
                  <InfoRow label="Pagamento" value={formatLocalDate(billing.paid_at)} styles={styles} />
                ) : null}
                <InfoRow label="Número" value={`#${billing.charge_number}`} styles={styles} last />
              </View>
            </Card>
          </ScrollView>

          {/* Ação principal fixa no rodapé — sempre ao alcance do polegar */}
          {canPay && (
            <View style={styles.footer}>
              <Button
                label={intent ? 'Ver pagamento em andamento' : `Pagar ${formatCurrency(billing.amount_due)}`}
                icon={intent ? 'time-outline' : undefined}
                variant={tone === 'danger' && !intent ? 'danger' : 'primary'}
                loading={generating}
                onPress={intent ? () => setShowPayment(true) : handlePay}
              />
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {intent && showPayment && (
        <PaymentModal
          billing={billing}
          intent={intent}
          paid={paid}
          onClose={() => setShowPayment(false)}
          styles={styles}
          theme={theme}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// BillingsScreen
// ---------------------------------------------------------------------------

export function BillingsScreen() {
  const [selected, setSelected]     = useState<MyChargeRow | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab]               = useState<Tab>('open')
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])

  const query        = useMyCharges(true)
  const historyQuery = useMyPaidCharges()

  useRefreshOnFocus([query])

  // Paga, a cobrança sai de "a pagar" e entra em "pagas": recarrega as duas
  // listas e fecha o detalhe.
  const handlePaid = useCallback(() => {
    setSelected(null)
    void query.refetch()
    void historyQuery.refetch()
  }, [query.refetch, historyQuery.refetch])

  async function handleRefresh() {
    setRefreshing(true)
    await Promise.all([
      query.refetch(),
      tab === 'paid' ? historyQuery.refetch() : Promise.resolve(),
    ])
    setRefreshing(false)
  }

  const todayIso = localTodayIso()

  // Todas as cobranças em aberto, divididas só por vencimento. Antes a tela
  // mostrava apenas a PRÓXIMA cobrança de locação ("Próximo aluguel"), regra
  // da época em que o contrato inteiro era gerado de uma vez (ADR 0009). Desde
  // a ADR 0024 só existe o que já foi emitido, e esse recorte escondia
  // cobranças reais — a segunda semana emitida, por exemplo, nunca aparecia.
  const { overdue, upcoming } = useMemo(() => {
    const open = [...(query.data ?? [])].sort((a, b) => a.due_date.localeCompare(b.due_date))
    return {
      overdue:  open.filter((b) => isOverdue(b, todayIso)),
      upcoming: open.filter((b) => b.status === 'open' && !isOverdue(b, todayIso)),
    }
  }, [query.data, todayIso])

  // "Pagas": paginado (`useMyPaidCharges`), mais recentes primeiro. Os grupos
  // por mês são montados sobre as páginas já carregadas.
  const paidByMonth = useMemo(() => {
    const paid = historyQuery.data?.pages.flat() ?? []

    const groups: { key: string; title: string; total: number; rows: MyChargeRow[] }[] = []
    for (const b of paid) {
      const key = b.due_date.slice(0, 7)
      let g = groups[groups.length - 1]
      if (!g || g.key !== key) {
        const [y, m] = key.split('-')
        g = { key, title: `${MONTH_LONG[Number(m) - 1]} ${y}`, total: 0, rows: [] }
        groups.push(g)
      }
      g.rows.push(b)
      g.total += b.paid_amount
    }
    return groups
  }, [historyQuery.data])

  const visibleOpen = [...overdue, ...upcoming]
  const total = visibleOpen.reduce((sum, b) => sum + b.amount_due, 0)
  const overdueTotal = overdue.reduce((sum, b) => sum + b.amount_due, 0)
  const upcomingTotal = upcoming.reduce((sum, b) => sum + b.amount_due, 0)
  const urgent = visibleOpen[0] ?? null

  function renderRows(rows: MyChargeRow[]) {
    return (
      <Card padded={false}>
        {rows.map((b, i) => (
          <ChargeRow
            key={b.charge_id}
            billing={b}
            todayIso={todayIso}
            onPress={() => setSelected(b)}
            styles={styles}
            theme={theme}
            last={i === rows.length - 1}
          />
        ))}
      </Card>
    )
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Cobranças" />

      {query.isError && !query.isFetching && (
        <View style={styles.offlineBanner}>
          <Icon name="cloud-offline-outline" size={16} color={theme.warning} />
          <Text style={styles.offlineBannerText}>Sem conexão — exibindo dados salvos</Text>
        </View>
      )}

      {query.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.primary} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.primary} />
          }
        >
          <SummaryCard
            total={total}
            overdueCount={overdue.length}
            overdueTotal={overdueTotal}
            urgent={urgent}
            todayIso={todayIso}
            onOpenUrgent={() => urgent && setSelected(urgent)}
            styles={styles}
            theme={theme}
          />

          <SegmentedControl
            value={tab}
            onChange={setTab}
            options={[
              { value: 'open', label: 'A pagar', count: visibleOpen.length },
              { value: 'paid', label: 'Pagas' },
            ]}
          />

          {tab === 'open' ? (
            visibleOpen.length === 0 ? (
              <EmptyState
                icon="checkmark-done"
                tone="success"
                title="Tudo em dia"
                text="Você não tem cobranças em aberto. As próximas aparecem aqui assim que forem geradas."
              />
            ) : (
              <>
                {overdue.length > 0 && (
                  <View style={styles.section}>
                    <SectionHeader title="Vencidas" trailing={formatCurrency(overdueTotal)} color={theme.danger} />
                    {renderRows(overdue)}
                  </View>
                )}

                {upcoming.length > 0 && (
                  <View style={styles.section}>
                    <SectionHeader title="A vencer" trailing={formatCurrency(upcomingTotal)} />
                    {renderRows(upcoming)}
                  </View>
                )}
              </>
            )
          ) : historyQuery.isLoading ? (
            <View style={styles.inlineLoadingBlock}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : paidByMonth.length === 0 ? (
            <EmptyState
              icon="receipt-outline"
              title="Nenhum pagamento ainda"
              text="As cobranças que você pagar ficam registradas aqui."
            />
          ) : (
            <>
              {paidByMonth.map((g) => (
                <View key={g.key} style={styles.section}>
                  <SectionHeader title={g.title} trailing={formatCurrency(g.total)} />
                  {renderRows(g.rows)}
                </View>
              ))}
              {historyQuery.hasNextPage && (
                <Button
                  label="Carregar mais"
                  variant="secondary"
                  size="md"
                  loading={historyQuery.isFetchingNextPage}
                  onPress={() => void historyQuery.fetchNextPage()}
                />
              )}
            </>
          )}
        </ScrollView>
      )}

      {selected && (
        <BillingDetailModal
          billing={selected}
          todayIso={todayIso}
          onClose={() => setSelected(null)}
          onPaid={handlePaid}
          styles={styles}
          theme={theme}
        />
      )}
    </SafeAreaView>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: theme.warningBg,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineBannerText: {
    color: theme.warning,
    fontSize: 13,
    fontWeight: '500',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 40,
    gap: 20,
  },
  pressed: {
    opacity: 0.7,
  },
  section: {
    gap: 10,
  },

  // Summary (superfície de marca)
  summary: {
    padding: 20,
    gap: 4,
  },
  summaryTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryLabel: {
    color: theme.brandTextSoft,
    fontSize: 14,
    fontWeight: '500',
  },
  summaryAmount: {
    color: theme.brandText,
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1.2,
    fontVariant: ['tabular-nums'],
  },
  summaryStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  summaryStatusText: {
    fontSize: 13,
    fontWeight: '600',
  },
  summaryDivider: {
    height: 1,
    backgroundColor: theme.brandBorder,
    marginVertical: 14,
  },
  summaryNext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  summaryNextBody: {
    flex: 1,
    gap: 2,
  },
  summaryNextLabel: {
    color: theme.brandTextSoft,
    fontSize: 12,
    fontWeight: '500',
  },
  summaryNextTitle: {
    color: theme.brandText,
    fontSize: 15,
    fontWeight: '600',
  },
  summaryNextMeta: {
    color: theme.brandAccent,
    fontSize: 12,
    fontWeight: '500',
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  rowDivider: {
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowPressed: {
    backgroundColor: theme.surfaceAlt,
  },
  dateBadge: {
    width: 46,
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateBadgeDay: {
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 21,
    fontVariant: ['tabular-nums'],
  },
  dateBadgeMonth: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
  },
  rowMeta: {
    color: theme.textMute,
    fontSize: 12.5,
  },
  rowDue: {
    fontSize: 12.5,
    fontWeight: '600',
    marginTop: 1,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  rowAmount: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rowAmountSub: {
    color: theme.textMute,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },

  inlineLoading: {
    paddingVertical: 8,
  },
  inlineLoadingBlock: {
    paddingVertical: 32,
    alignItems: 'center',
  },

  // Modal base
  modalSafe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  modalBody: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 32,
    gap: 16,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopColor: theme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.surface,
  },

  // Hero (detalhe e pagamento)
  detailHero: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 2,
  },
  heroLabel: {
    color: theme.textSoft,
    fontSize: 14,
  },
  heroLabelSpaced: {
    marginTop: 12,
  },
  heroAmount: {
    color: theme.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.4,
    fontVariant: ['tabular-nums'],
  },
  detailHeroDue: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Card content
  cardTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
  },
  lines: {
    gap: 12,
  },
  lineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  lineLabel: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
  },
  lineLabelMuted: {
    flex: 1,
    color: theme.textSoft,
    fontSize: 14,
  },
  lineValue: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  lineDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
  },
  lineTotalLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '700',
  },
  lineTotalValue: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoRowDivider: {
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 12,
  },
  infoLabel: {
    color: theme.textSoft,
    fontSize: 14,
  },
  infoValue: {
    flexShrink: 1,
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },

  // Payment modal
  payHero: {
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
  },
  payHeroSub: {
    color: theme.textMute,
    fontSize: 13,
  },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.primaryTint,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    marginTop: 10,
  },
  waitingText: {
    color: theme.primary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  qrWrap: {
    // QR code precisa de fundo branco sólido pra ler bem — não segue o tema.
    alignSelf: 'center',
    backgroundColor: 'white',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
  },
  qrImage: {
    width: 220,
    height: 220,
  },
  codeBox: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: radius.md,
    padding: 12,
    gap: 4,
  },
  codeLabel: {
    color: theme.textMute,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  code: {
    color: theme.textSoft,
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  steps: {
    gap: 12,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: {
    color: theme.primary,
    fontSize: 12,
    fontWeight: '800',
  },
  stepText: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    lineHeight: 21,
  },
  footnote: {
    color: theme.textMute,
    fontSize: 12,
    textAlign: 'center',
  },
  successWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 6,
  },
  successIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: theme.successBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  successTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '800',
  },
  successAmount: {
    color: theme.success,
    fontSize: 30,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  successText: {
    color: theme.textSoft,
    fontSize: 14,
    textAlign: 'center',
  },
})
