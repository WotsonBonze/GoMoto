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
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import { useMyCharges, usePaymentIntentStatus } from '@gomoto/data'
import type { MyChargeRow } from '@gomoto/data'
import {
} from '@gomoto/core'
import { supabase } from '../lib/supabase'
import { useTheme, type ThemeTokens } from '../theme'

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `charge_status` (ADR 0024) + `overdue`, derivado de `is_overdue`.
const STATUS_LABEL: Record<string, string> = {
  open:        'Em aberto',
  overdue:     'Vencida',
  paid:        'Pago',
  cancelled:   'Cancelada',
  written_off: 'Baixada',
}

function getStatusTone(theme: ThemeTokens): Record<string, { color: string; bg: string }> {
  return {
    open:        { color: theme.pending, bg: theme.pendingBg },
    overdue:     { color: theme.warning, bg: theme.warningBg },
    paid:        { color: theme.success, bg: theme.successBg },
    cancelled:   { color: theme.textMute, bg: theme.surfaceAlt },
    written_off: { color: theme.danger, bg: theme.dangerBg },
  }
}

const BILLING_TYPE_LABEL: Record<string, string> = {
  cycle:         'Ciclo',
  one_time:      'Avulsa',
  complementary: 'Complementar',
  fine:          'Multa',
}

function getBillingTypeTone(theme: ThemeTokens): Record<string, { bg: string; fg: string }> {
  return {
    cycle:         { bg: theme.successBg, fg: theme.success },
    one_time:      { bg: theme.indigoBg, fg: theme.indigo },
    complementary: { bg: theme.violetBg, fg: theme.violet },
    fine:          { bg: theme.dangerBg, fg: theme.danger },
  }
}

type StatusTone = ReturnType<typeof getStatusTone>
type TypeTone = ReturnType<typeof getBillingTypeTone>
type Styles = ReturnType<typeof createStyles>

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  pix:           'Pix',
  cash:          'Dinheiro',
  credit_card:   'Cartão de crédito',
  debit_card:    'Cartão de débito',
  bank_transfer: 'Transferência',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function daysUntil(isoDate: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(isoDate + 'T00:00:00')
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}

function vehicleLabel(billing: MyChargeRow): string | null {
  return billing.vehicle_plate
}

async function createPaymentIntent(billingId: string): Promise<PaymentIntent> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Não autenticado')
  const webUrl = process.env.EXPO_PUBLIC_WEB_URL ?? ''
  if (!webUrl) throw new Error('EXPO_PUBLIC_WEB_URL não configurado')
  // Sem `method` no corpo: o default é o meio principal do gateway eleito,
  // resolvido no servidor. Pedir `pix` aqui quebraria a InfinitePay.
  const res = await fetch(`${webUrl}/api/charges/${billingId}/payment-intent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
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
// SectionHeader
// ---------------------------------------------------------------------------

function SectionHeader({ title, count, danger, styles }: { title: string; count: number; danger?: boolean; styles: Styles }) {
  return (
    <View style={styles.sectionHeader}>
      {danger && <View style={styles.sectionDangerDot} />}
      <Text style={[styles.sectionTitle, danger && styles.sectionTitleDanger]}>
        {title}
      </Text>
      <View style={[styles.sectionCount, danger && styles.sectionCountDanger]}>
        <Text style={[styles.sectionCountText, danger && styles.sectionCountTextDanger]}>
          {count}
        </Text>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// TypeBadge
// ---------------------------------------------------------------------------

function TypeBadge({ type, styles, typeTone }: { type: string | null | undefined; styles: Styles; typeTone: TypeTone }) {
  if (type === 'one_time') return null
  const label = BILLING_TYPE_LABEL[type ?? ''] ?? null
  if (!label) return null
  // fallback inalcançável na prática: os 4 tipos em BILLING_TYPE_LABEL são os
  // mesmos 4 de getBillingTypeTone — mantido só por segurança de tipos.
  const tone = typeTone[type ?? ''] ?? typeTone.one_time
  return (
    <View style={[styles.typeBadge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.typeBadgeText, { color: tone.fg }]}>{label}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// BillingRow — used in overdue + upcoming sections
// ---------------------------------------------------------------------------

function BillingRow({
  billing,
  onPress,
  styles,
  typeTone,
}: {
  billing: MyChargeRow
  onPress: () => void
  styles: Styles
  typeTone: TypeTone
}) {
  const today = new Date()
  const overdue = billing.is_overdue
  const days = overdue
    ? billing.days_overdue
    : daysUntil(billing.due_date)

  // F-05: o valor devido vem pronto do servidor, já com encargo e crédito.
  const finalAmount = billing.amount_due
  const plate = vehicleLabel(billing)

  let dueMeta: string
  if (overdue) {
    dueMeta = days === 0
      ? `Venceu hoje · ${formatDate(billing.due_date)}`
      : `${days} dia${days !== 1 ? 's' : ''} de atraso · venceu ${formatDate(billing.due_date)}`
  } else {
    dueMeta = days === 0
      ? `Vence hoje`
      : days === 1
        ? `Vence amanhã · ${formatDate(billing.due_date)}`
        : `Vence em ${days} dias · ${formatDate(billing.due_date)}`
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.billingRow, overdue && styles.billingRowOverdue, pressed && styles.billingRowPressed]}
      onPress={onPress}
    >
      <View style={styles.billingRowTop}>
        <TypeBadge type={billing.rental_id ? 'cycle' : 'one_time'} styles={styles} typeTone={typeTone} />
        <Text style={[styles.billingRowMeta, overdue ? styles.billingRowMetaDanger : styles.billingRowMetaMuted]}>
          {dueMeta}
        </Text>
      </View>
      <View style={styles.billingRowMain}>
        <View style={styles.billingRowLeft}>
          <Text style={styles.billingRowDesc} numberOfLines={2}>{billing.description ?? '—'}</Text>
          {plate && <Text style={styles.billingRowPlate}>{plate}</Text>}
        </View>
        <View style={styles.billingRowRight}>
          {billing.paid_amount > 0 ? (
            <>
              <Text style={styles.billingRowAmountStrike}>{formatCurrency(billing.total_amount)}</Text>
              <Text style={[styles.billingRowAmount, overdue && styles.billingRowAmountDanger]}>
                {formatCurrency(finalAmount)}
              </Text>
            </>
          ) : (
            <Text style={[styles.billingRowAmount, overdue && styles.billingRowAmountDanger]}>
              {formatCurrency(finalAmount)}
            </Text>
          )}
          <Text style={styles.billingRowChevron}>›</Text>
        </View>
      </View>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// HistoryRow — compact row for paid billings
// ---------------------------------------------------------------------------

function HistoryRow({ billing, onPress, styles }: { billing: MyChargeRow; onPress: () => void; styles: Styles }) {
  // F-05: o valor devido vem pronto do servidor, já com encargo e crédito.
  const finalAmount = billing.amount_due
  // Data e forma de pagamento vivem em `payments`, não na cobrança —
  // um documento pode ter vários recebimentos.
  const paidDate = billing.status === 'paid' ? billing.due_date : null
  const method = null

  return (
    <Pressable
      style={({ pressed }) => [styles.historyRow, pressed && styles.billingRowPressed]}
      onPress={onPress}
    >
      <View style={styles.historyRowLeft}>
        <View style={styles.historyCheckCircle}>
          <Text style={styles.historyCheckText}>✓</Text>
        </View>
        <View style={styles.historyRowInfo}>
          <Text style={styles.historyRowDesc} numberOfLines={1}>{billing.description ?? '—'}</Text>
          <Text style={styles.historyRowMeta}>
            {paidDate ? `Pago em ${formatDate(paidDate)}` : formatDate(billing.due_date)}
            {method ? ` · ${method}` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.historyRowRight}>
        <Text style={styles.historyRowAmount}>{formatCurrency(finalAmount)}</Text>
        <Text style={styles.billingRowChevron}>›</Text>
      </View>
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
}: {
  billing: MyChargeRow
  intent: PaymentIntent
  paid: boolean
  onClose: () => void
  styles: Styles
}) {
  const isLink  = intent.method === 'payment_link'
  const isPix   = intent.method === 'pix'
  const pixCode = pixCodeOf(intent)
  const qrImage = intent.payload?.qr_code_base64
  const url     = intent.payload?.checkout_url

  function copyCode() {
    if (!pixCode) return
    void Clipboard.setStringAsync(pixCode)
    Alert.alert('Copiado!', 'Código Pix copiado para a área de transferência.')
  }

  const title = isPix ? 'Pagar com Pix' : `Pagar com ${intent.provider_label}`

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.modalClose}>Fechar</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalBody}>
          {paid && (
            <View style={styles.pixPaidConfirm}>
              <Text style={styles.pixPaidConfirmText}>Pagamento confirmado!</Text>
            </View>
          )}
          {intent.is_reused && (
            <View style={styles.reuseNote}>
              <Text style={styles.reuseNoteText}>
                {isLink
                  ? 'Link de pagamento ativo reutilizado — o mesmo gerado anteriormente.'
                  : 'Pix ativo reutilizado — mesmo código gerado anteriormente.'}
              </Text>
            </View>
          )}

          {isPix && qrImage ? (
            <View style={styles.pixQrContainer}>
              <Image
                source={{ uri: `data:image/png;base64,${qrImage}` }}
                style={styles.pixQrImage}
                resizeMode="contain"
              />
            </View>
          ) : null}

          <View style={styles.pixInfo}>
            {/* O valor da tentativa, não o da lista: é o que o código cobra. */}
            <Text style={styles.pixAmount}>{formatCurrency(intent.amount ?? billing.amount_due)}</Text>
            {intent.expires_at ? (
              <Text style={styles.pixExpiry}>Vence em {formatDate(intent.expires_at.slice(0, 10))}</Text>
            ) : null}
          </View>

          {isPix && pixCode ? (
            <>
              <View style={styles.pixCodeBlock}>
                <Text style={styles.pixCodeLabel}>Copia e Cola</Text>
                <Text style={styles.pixCode} selectable>{pixCode}</Text>
              </View>
              <TouchableOpacity style={styles.copyBtn} onPress={copyCode}>
                <Text style={styles.copyBtnText}>Copiar Código Pix</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {isLink && url ? (
            <>
              <View style={styles.pixCodeBlock}>
                <Text style={styles.linkNoteText}>
                  O pagamento é feito na página segura da {intent.provider_label}, onde você
                  escolhe Pix ou cartão. Ao terminar, feche a página e volte para cá — a
                  confirmação aparece automaticamente.
                </Text>
              </View>
              <TouchableOpacity style={styles.payBtn} onPress={() => void openCheckout(url)}>
                <Text style={styles.payBtnText}>Abrir página de pagamento</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {/* Gateway novo que esta versão do app ainda não sabe desenhar, ou
              payload incompleto: dizer isso em vez de mostrar um QR vazio. */}
          {!(isPix && pixCode) && !(isLink && url) && (
            <View style={styles.reuseNote}>
              <Text style={styles.reuseNoteText}>
                Esta forma de pagamento ainda não é suportada nesta versão do app.
                Atualize o aplicativo ou fale com a locadora.
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// BillingDetailModal
// ---------------------------------------------------------------------------

function BillingDetailModal({
  billing,
  onClose,
  onPaid,
  styles,
  typeTone,
  statusTone,
}: {
  billing: MyChargeRow
  onClose: () => void
  /** Pagamento confirmado pelo gateway — a tela recarrega a lista e fecha. */
  onPaid?: () => void
  styles: Styles
  typeTone: TypeTone
  statusTone: StatusTone
}) {
  const [generating, setGenerating] = useState(false)
  const [intent, setIntent]         = useState<PaymentIntent | null>(null)
  const [paid, setPaid]             = useState(false)
  // Fechar o modal de pagamento NÃO encerra a tentativa: o Pix pode compensar
  // depois, e o polling segue enquanto o detalhe estiver aberto.
  const [showPayment, setShowPayment] = useState(false)

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

  const original  = billing.total_amount
  const discount  = 0
  const finalAmt  = billing.amount_due
  const canPay    = billing.status === 'open' || billing.is_overdue
  const today     = new Date()
  const overdue   = billing.is_overdue
  const daysOver  = overdue ? billing.days_overdue : 0
  const plate     = vehicleLabel(billing)

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

  // Atraso não é status armazenado (Princípio 4): vem de `is_overdue`.
  const statusKey   = billing.is_overdue ? 'overdue' : billing.status
  const statusColor = statusTone[statusKey]?.color ?? statusTone.open.color
  const statusBg    = statusTone[statusKey]?.bg ?? statusTone.open.bg

  return (
    <>
      <Modal
        visible
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.modalSafe}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Cobrança</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.modalClose}>Fechar</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody}>
            {/* Identity block */}
            <View style={styles.detailIdentity}>
              <View style={styles.detailIdentityBadges}>
                <TypeBadge type={billing.rental_id ? 'cycle' : 'one_time'} styles={styles} typeTone={typeTone} />
                <View style={[styles.statusPill, { backgroundColor: statusBg }]}>
                  <Text style={[styles.statusPillText, { color: statusColor }]}>
                    {STATUS_LABEL[statusKey] ?? statusKey}
                  </Text>
                </View>
              </View>
              <Text style={styles.detailDesc}>{billing.description ?? '—'}</Text>
              {plate && <Text style={styles.detailPlate}>{plate}</Text>}
              {overdue && daysOver > 0 ? (
                <Text style={styles.detailOverdueMeta}>
                  {daysOver} dia{daysOver !== 1 ? 's' : ''} de atraso · venceu {formatDate(billing.due_date)}
                </Text>
              ) : (
                <Text style={styles.detailDueMeta}>
                  Vencimento: {formatDate(billing.due_date)}
                </Text>
              )}
            </View>

            {/* Composição — total, o que já foi pago e o encargo acumulado */}
            <View style={styles.detailSection}>
              <Text style={styles.detailSectionTitle}>Composição</Text>
              <View style={styles.compositionBlock}>
                <View style={styles.compositionRow}>
                  <Text style={styles.compositionLabel}>
                    {billing.item_count > 1 ? `Total (${billing.item_count} itens)` : 'Valor'}
                  </Text>
                  <Text style={styles.compositionValue}>{formatCurrency(billing.total_amount)}</Text>
                </View>

                {billing.paid_amount > 0 && (
                  <View style={styles.compositionRow}>
                    <View style={styles.compositionLabelGroup}>
                      <Text style={styles.compositionLabel}>Já pago</Text>
                      <Text style={styles.compositionSub}>Pagamento parcial registrado</Text>
                    </View>
                    <Text style={[styles.compositionValue, { color: statusTone.paid.color }]}>
                      − {formatCurrency(billing.paid_amount)}
                    </Text>
                  </View>
                )}

                {billing.accrued_total > 0 && (
                  <View style={styles.compositionRow}>
                    <View style={styles.compositionLabelGroup}>
                      <Text style={styles.compositionLabel}>Encargo por atraso</Text>
                      <Text style={styles.compositionSub}>{billing.days_overdue} dias</Text>
                    </View>
                    <Text style={styles.compositionValue}>
                      + {formatCurrency(billing.accrued_total)}
                    </Text>
                  </View>
                )}

                <View style={styles.compositionDivider} />

                <View style={styles.compositionRow}>
                  <Text style={[styles.compositionLabel, styles.compositionLabelTotal]}>A pagar</Text>
                  <Text style={[styles.compositionValue, styles.compositionValueTotal]}>
                    {formatCurrency(billing.amount_due)}
                  </Text>
                </View>
              </View>
            </View>

            {/* Pagamento */}
            {canPay && (
              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Pagamento</Text>
                <TouchableOpacity
                  style={[styles.payBtn, generating && styles.payBtnDisabled]}
                  onPress={handlePay}
                  disabled={generating}
                >
                  <Text style={styles.payBtnText}>
                    {generating ? 'Gerando pagamento…' : `Pagar ${formatCurrency(billing.amount_due)}`}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {billing.status === 'paid' && (
              <View style={styles.paidBlock}>
                <Text style={styles.paidTitle}>Cobrança quitada</Text>
                <CompositionRow
                  label="Total recebido"
                  value={formatCurrency(billing.paid_amount)}
                  styles={styles}
                />
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {intent && showPayment && (
        <PaymentModal
          billing={billing}
          intent={intent}
          paid={paid}
          onClose={() => setShowPayment(false)}
          styles={styles}
        />
      )}
    </>
  )
}

function CompositionRow({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.compositionRow}>
      <Text style={styles.compositionLabel}>{label}</Text>
      <Text style={styles.compositionValue}>{value}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// BillingsScreen
// ---------------------------------------------------------------------------

export function BillingsScreen() {
  const [selected, setSelected]         = useState<MyChargeRow | null>(null)
  const [refreshing, setRefreshing]     = useState(false)
  const [historyOpen, setHistoryOpen]   = useState(false)
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const typeTone = useMemo(() => getBillingTypeTone(theme), [theme])
  const statusTone = useMemo(() => getStatusTone(theme), [theme])

  const query        = useMyCharges(true)
  const historyQuery = useMyCharges(false)

  useFocusEffect(
    useCallback(() => {
      void query.refetch()
    }, [query.refetch]),
  )

  // Paga, a cobrança sai de "em aberto" e entra no histórico: recarrega as
  // duas listas e fecha o detalhe.
  const handlePaid = useCallback(() => {
    setSelected(null)
    void query.refetch()
    void historyQuery.refetch()
  }, [query.refetch, historyQuery.refetch])

  async function handleRefresh() {
    setRefreshing(true)
    await Promise.all([
      query.refetch(),
      historyOpen ? historyQuery.refetch() : Promise.resolve(),
    ])
    setRefreshing(false)
  }

  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)

  // O backend gera todas as cobranças de ciclo antecipadamente (pode ser anos).
  // Regras de exibição:
  //   • Em atraso  — todas vencidas, qualquer tipo
  //   • Próxima    — única próxima cobrança de ciclo (due_date >= hoje)
  //   • Outras     — multas, avulsas e complementares pendentes não vencidas
  //   • Histórico  — buscado sob demanda via useHistoryBillingsForCustomer
  const { overdue, nextCycle, others } = useMemo(() => {
    const all = query.data ?? []

    const overdue = all
      .filter((b) =>
        b.is_overdue ||
        (b.status === 'open' && b.due_date < todayIso),
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date))

    const overdueIds = new Set(overdue.map((b) => b.charge_id))

    const nextCycle = all
      .filter(
        (b) =>
          b.rental_id !== null &&
          b.status === 'open' &&
          b.due_date >= todayIso &&
          !overdueIds.has(b.charge_id),
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date))[0] ?? null

    const others = all
      .filter(
        (b) =>
          b.rental_id === null &&
          b.status === 'open' &&
          b.due_date >= todayIso &&
          !overdueIds.has(b.charge_id),
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date))

    return { overdue, nextCycle, others }
  }, [query.data, todayIso])

  const hasContent = overdue.length > 0 || nextCycle !== null || others.length > 0

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Cobranças</Text>
        <Text style={styles.headerSubtitle}>Sua situação financeira</Text>
      </View>

      {/* Offline banner */}
      {query.isError && !query.isFetching && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>Sem conexão — exibindo dados salvos localmente</Text>
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
          {!hasContent ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Nenhuma cobrança</Text>
              <Text style={styles.emptyText}>Suas cobranças aparecerão aqui quando forem geradas.</Text>
            </View>
          ) : (
            <>
              {/* Em atraso */}
              {overdue.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Em atraso" count={overdue.length} danger styles={styles} />
                  <View style={styles.sectionBody}>
                    {overdue.map((b) => (
                      <BillingRow key={b.charge_id} billing={b} onPress={() => setSelected(b)} styles={styles} typeTone={typeTone} />
                    ))}
                  </View>
                </View>
              )}

              {/* Próxima cobrança de ciclo */}
              {nextCycle && (
                <View style={styles.section}>
                  <SectionHeader title="Próxima cobrança" count={1} styles={styles} />
                  <View style={styles.sectionBody}>
                    <BillingRow billing={nextCycle} onPress={() => setSelected(nextCycle)} styles={styles} typeTone={typeTone} />
                  </View>
                </View>
              )}

              {/* Outras cobranças pendentes (multas, avulsas, complementares) */}
              {others.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Outras" count={others.length} styles={styles} />
                  <View style={styles.sectionBody}>
                    {others.map((b) => (
                      <BillingRow key={b.charge_id} billing={b} onPress={() => setSelected(b)} styles={styles} typeTone={typeTone} />
                    ))}
                  </View>
                </View>
              )}

              {/* Histórico de pagamentos — lazy, só busca ao abrir */}
              <View style={styles.section}>
                <Pressable
                  style={styles.historyToggle}
                  onPress={() => setHistoryOpen((v) => !v)}
                >
                  <Text style={styles.historyToggleText}>
                    {historyOpen ? 'Ocultar histórico' : 'Ver histórico de pagamentos'}
                  </Text>
                  <Text style={styles.historyToggleChevron}>{historyOpen ? '▲' : '▼'}</Text>
                </Pressable>
                {historyOpen && (
                  historyQuery.isLoading ? (
                    <View style={styles.historyLoading}>
                      <ActivityIndicator color={theme.primary} size="small" />
                    </View>
                  ) : (historyQuery.data ?? []).length === 0 ? (
                    <View style={styles.historyEmpty}>
                      <Text style={styles.historyEmptyText}>Nenhum pagamento registrado.</Text>
                    </View>
                  ) : (
                    <View style={styles.sectionBody}>
                      {(historyQuery.data ?? []).map((b) => (
                        <HistoryRow key={b.charge_id} billing={b} onPress={() => setSelected(b)} styles={styles} />
                      ))}
                    </View>
                  )
                )}
              </View>
            </>
          )}
        </ScrollView>
      )}

      {selected && (
        <BillingDetailModal
          billing={selected}
          onClose={() => setSelected(null)}
          onPaid={handlePaid}
          styles={styles}
          typeTone={typeTone}
          statusTone={statusTone}
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
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomColor: theme.surfaceAlt,
    borderBottomWidth: 1,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '700',
  },
  headerSubtitle: {
    color: theme.textMute,
    fontSize: 13,
    marginTop: 2,
  },
  offlineBanner: {
    backgroundColor: theme.warningBg,
    borderBottomColor: theme.warning,
    borderBottomWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineBannerText: {
    color: theme.warning,
    fontSize: 13,
    textAlign: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 8,
  },

  // Section
  section: {
    gap: 6,
    marginTop: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
  },
  sectionDangerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.warning,
  },
  sectionTitle: {
    color: theme.textMute,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    flex: 1,
  },
  sectionTitleDanger: {
    color: theme.warning,
  },
  sectionCount: {
    backgroundColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  sectionCountDanger: {
    backgroundColor: theme.warningBg,
  },
  sectionCountText: {
    color: theme.textMute,
    fontSize: 11,
    fontWeight: '700',
  },
  sectionCountTextDanger: {
    color: theme.warning,
  },
  sectionBody: {
    gap: 6,
  },

  // Type badge
  typeBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  // MyChargeRow row
  billingRow: {
    backgroundColor: theme.surface,
    borderColor: theme.surfaceAlt,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  billingRowOverdue: {
    borderColor: theme.warning,
    backgroundColor: theme.warningBg,
  },
  billingRowPressed: {
    opacity: 0.8,
  },
  billingRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  billingRowMeta: {
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
  },
  billingRowMetaDanger: {
    color: theme.warning,
  },
  billingRowMetaMuted: {
    color: theme.textMute,
  },
  billingRowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  billingRowLeft: {
    flex: 1,
    gap: 3,
  },
  billingRowDesc: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  billingRowPlate: {
    color: theme.textMute,
    fontSize: 12,
  },
  billingRowRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  billingRowAmount: {
    color: theme.primary,
    fontSize: 15,
    fontWeight: '700',
  },
  billingRowAmountDanger: {
    color: theme.danger,
  },
  billingRowAmountStrike: {
    color: theme.textMute,
    fontSize: 12,
    textDecorationLine: 'line-through',
  },
  billingRowChevron: {
    color: theme.border,
    fontSize: 18,
    lineHeight: 20,
  },

  // History row
  historyRow: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  historyRowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  historyCheckCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.successBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyCheckText: {
    color: theme.success,
    fontSize: 12,
    fontWeight: '700',
  },
  historyRowInfo: {
    flex: 1,
    gap: 2,
  },
  historyRowDesc: {
    color: theme.textSoft,
    fontSize: 13,
    fontWeight: '500',
  },
  historyRowMeta: {
    color: theme.textMute,
    fontSize: 11,
  },
  historyRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  historyRowAmount: {
    color: theme.textMute,
    fontSize: 13,
    fontWeight: '600',
  },

  // History loading / empty
  historyLoading: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  historyEmpty: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  historyEmptyText: {
    color: theme.textMute,
    fontSize: 13,
  },

  // History toggle button
  historyToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: theme.surface,
    borderColor: theme.surfaceAlt,
    borderWidth: 1,
    borderRadius: 10,
  },
  historyToggleText: {
    color: theme.textMute,
    fontSize: 13,
    fontWeight: '600',
  },
  historyToggleChevron: {
    color: theme.textMute,
    fontSize: 10,
  },

  // Empty state
  emptyCard: {
    backgroundColor: theme.surface,
    borderColor: theme.surfaceAlt,
    borderWidth: 1,
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    gap: 8,
    marginTop: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    color: theme.textMute,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Pay button
  payBtn: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  payBtnDisabled: {
    opacity: 0.6,
  },
  payBtnText: {
    color: theme.primaryContrast,
    fontSize: 15,
    fontWeight: '700',
  },

  // Modal base
  modalSafe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomColor: theme.surfaceAlt,
    borderBottomWidth: 1,
  },
  modalTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
  },
  modalClose: {
    color: theme.primary,
    fontSize: 15,
  },
  modalBody: {
    padding: 20,
    gap: 20,
  },

  // Detail modal — identity block
  detailIdentity: {
    gap: 6,
  },
  detailIdentityBadges: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 4,
  },
  detailDesc: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  detailPlate: {
    color: theme.textMute,
    fontSize: 13,
  },
  detailOverdueMeta: {
    color: theme.warning,
    fontSize: 13,
    fontWeight: '500',
  },
  detailDueMeta: {
    color: theme.textMute,
    fontSize: 13,
  },

  // Detail modal — sections
  detailSection: {
    gap: 10,
  },
  detailSectionTitle: {
    color: theme.textMute,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Composition block
  compositionBlock: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  compositionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  compositionLabelGroup: {
    flex: 1,
    gap: 2,
  },
  compositionLabel: {
    color: theme.textMute,
    fontSize: 14,
  },
  compositionLabelTotal: {
    color: theme.text,
    fontWeight: '600',
  },
  compositionSub: {
    color: theme.border,
    fontSize: 12,
  },
  compositionValue: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '500',
  },
  compositionValueTotal: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.primary,
  },
  compositionDivider: {
    height: 1,
    backgroundColor: theme.surfaceAlt,
  },

  // Status pill
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // Paid block
  paidBlock: {
    backgroundColor: theme.successBg,
    borderColor: theme.success,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  paidTitle: {
    color: theme.success,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  paidConfirmedTag: {
    color: theme.success,
    fontSize: 12,
    opacity: 0.8,
  },

  // Pix modal
  pixPaidConfirm: {
    backgroundColor: theme.successBg,
    borderColor: theme.success,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  pixPaidConfirmText: {
    color: theme.success,
    fontSize: 17,
    fontWeight: '700',
  },
  reuseNote: {
    backgroundColor: theme.indigoBg,
    borderRadius: 8,
    padding: 10,
  },
  reuseNoteText: {
    color: theme.textMute,
    fontSize: 12,
    textAlign: 'center',
  },
  pixQrContainer: {
    // QR code precisa de fundo branco sólido pra ler bem — não segue o tema.
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 16,
  },
  pixQrImage: {
    width: 200,
    height: 200,
  },
  pixInfo: {
    alignItems: 'center',
    gap: 4,
  },
  pixAmount: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '700',
  },
  pixExpiry: {
    color: theme.textMute,
    fontSize: 13,
  },
  pixCodeBlock: {
    backgroundColor: theme.surface,
    borderColor: theme.surfaceAlt,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  pixCodeLabel: {
    color: theme.textMute,
    fontSize: 12,
  },
  pixCode: {
    color: theme.text,
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  copyBtn: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  copyBtnText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
  },
  linkNoteText: {
    color: theme.textMute,
    fontSize: 13,
    lineHeight: 19,
  },
})
