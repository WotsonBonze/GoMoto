import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import {
  calculateAmountDue, calculateAccruedCharges, toPolicyInput, DAYS_PER_MONTH,
  findPaymentProvider,
  type LateChargePolicy, type AccruedCharges,
} from '@gomoto/core'
import { formatCurrency } from '@/lib/utils'
import { fetchTenantTimezone, tenantToday } from '@/lib/payment/business-time'
import { BillingActions } from './_components/BillingActions'
import { ReversePaymentButton } from './_components/ReversePaymentButton'

// ─── Local types ──────────────────────────────────────────────────────────────






// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: string | null | undefined) {
  if (!d) return '—'
  const date = d.includes('T') ? new Date(d) : new Date(d + 'T12:00:00')
  return date.toLocaleDateString('pt-BR')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** "5% sobre R$ 142,86" — de onde a multa saiu. */
function regraDaMulta(
  policy: LateChargePolicy,
  view: ReturnType<typeof toPolicyInput>,
  principal: number,
): string {
  return policy.fee_type === 'percentage'
    ? `${num(view.fee_value)}% sobre ${formatCurrency(principal)}`
    : `valor fixo de ${formatCurrency(policy.fee_value)}`
}

/** "0,99% ao mês (0,033% ao dia) × 25 dias sobre R$ 142,86" — de onde os juros saíram. */
function regraDosJuros(
  view: ReturnType<typeof toPolicyInput>,
  principal: number,
  dias: number,
): string {
  return `${num(view.monthly_interest_percent)}% ao mês (${num(view.monthly_interest_percent / DAYS_PER_MONTH, 4)}% ao dia)`
    + ` × ${dias} dia${dias !== 1 ? 's' : ''} sobre ${formatCurrency(principal)}`
}

/**
 * Reconstrói multa e juros de um encargo JÁ REALIZADO.
 *
 * O banco guarda só o TOTAL: `realizeLateCharge` grava um `charge_items` com
 * `amount = accrued.total` e o rateio não é persistido em lugar nenhum. Para a
 * cobrança paga exibir a mesma abertura da não paga, a conta precisa ser
 * refeita — e refeita pela MESMA função que a produziu, com os mesmos insumos:
 * o saldo em aberto antes daquele recebimento e a DATA do recebimento (é ela
 * que manda no encargo, não a data de hoje).
 *
 * A garantia contra inventar número está no final: só devolve o rateio quando
 * ele reproduz, ao centavo, o total que está gravado. Sem essa checagem a tela
 * mostraria uma decomposição plausível de um valor que ela não explicou.
 */
function rateioDoEncargoRealizado(
  policy: LateChargePolicy,
  dueDate: string,
  principalEmitido: number,
  totalGravado: number,
  recebimentos: { paid_at: string; amount: number }[],
  timezone: string | null,
): AccruedCharges | null {
  let abatido = 0

  for (const r of [...recebimentos].sort((a, b) => (a.paid_at < b.paid_at ? -1 : 1))) {
    const principal = round2(principalEmitido - abatido)
    if (principal > 0) {
      const tentativa = calculateAccruedCharges(policy, principal, dueDate, tenantToday(timezone, new Date(r.paid_at)))
      if (round2(tentativa.total) === totalGravado) return tentativa
    }
    abatido = round2(abatido + r.amount)
  }

  return null
}

/** Decimal em pt-BR, sem zeros à toa — mesma forma da tela de Configurações. */
function num(n: number, casas = 2): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

function fmtDatetime(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * `charge_status` da ADR 0024: open | paid | cancelled | written_off.
 * `overdue` não é status armazenado — é derivado de `due_date` (Princípio 4) e
 * entra aqui só como chave de exibição, vindo de `charge_balances.is_overdue`.
 */
const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; border: string }> = {
  open:        { label: 'Em aberto', bg: 'bg-info-bg',    text: 'text-info',    border: 'border-info' },
  paid:        { label: 'Paga',      bg: 'bg-success-bg', text: 'text-success', border: 'border-success' },
  overdue:     { label: 'Vencida',   bg: 'bg-danger-bg',  text: 'text-danger',  border: 'border-danger' },
  cancelled:   { label: 'Cancelada', bg: 'bg-surface-2',  text: 'text-fg-mute', border: 'border-divider' },
  written_off: { label: 'Baixada',   bg: 'bg-warning-bg', text: 'text-warning', border: 'border-warning' },
}

/** Fora destes, a cobrança saiu de contas a receber e não há o que cobrar. */

const BILLING_TYPE_LABELS: Record<string, string> = {
  cycle:         'Ciclo',
  one_time:      'Avulsa',
  complementary: 'Complementar',
  deposit:       'Caução',
  down_payment:  'Entrada',
}

const SOURCE_LABELS: Record<string, string> = {
  cycle:        'Ciclo',
  rental_cycle: 'Ciclo',
  // Origens que os ITENS realmente usam. `late_charge` faltava, e é o do
  // encargo realizado — apareceria cru na composição, que é onde ele mais
  // aparece.
  rental:       'Locação',
  late_charge:  'Encargo por atraso',
  discount:     'Desconto',
  fine:         'Multa',
  maintenance:  'Manutenção',
  expense:      'Despesa',
  manual:       'Manual',
  deposit:      'Caução',
  down_payment: 'Entrada',
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  pix:              'PIX',
  cash:             'Dinheiro',
  // Abatimento por crédito grava `method = 'credit'` em `payments`. Faltava
  // aqui, então a linha aparecia como "credit" cru ao lado de "PIX" traduzido.
  credit:            'Crédito do cliente',
  deposit_retention: 'Retenção de caução',
  credit_card:      'Cartão de crédito',
  debit_card:       'Cartão de débito',
  bank_transfer:    'Transferência',
  other:            'Outro',
}

const CREDIT_ORIGIN_LABELS: Record<string, string> = {
  maintenance_refund: 'Estorno manutenção',
  reversal:          'Estorno',
  manual_adjustment: 'Ajuste manual',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function BillingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  // Spec 0014: saldo e atraso vêm de `charge_balances`, derivados. A composição
  // do documento são os ITENS — `late_charges` e `credit_applications` deixaram
  // de existir: encargo é calculado até ser realizado (R-06), e aplicação de
  // crédito é transação no ledger.
  const [balanceResult, itemsResult, allocationsResult, gatewayResult, membrosResult, timezone] = await Promise.all([
    supabase
      .from('charge_balances')
      .select('*')
      .eq('charge_id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase
      .from('charge_items')
      .select('id, description, credit_account_code, quantity, unit_amount, amount, source_module, created_at')
      .eq('charge_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true }),
    supabase
      .from('payment_allocations')
      // `received_by_system` e o provedor do intent respondem "de onde veio este
      // dinheiro" (ADR 0034). Os dois porque cobrem épocas diferentes: a coluna
      // só existe a partir da Fase 1, e o intent cobre os recebimentos
      // anteriores a ela.
      .select(
        'id, amount, created_at, '
        + 'payment:payments(id, amount, method, paid_at, notes, reversed_at, '
        + 'received_by, received_by_system, intent:payment_intents(provider))',
      )
      .eq('charge_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }),
    // O gateway ELEITO, só para o botão dizer a verdade sobre o que vai gerar.
    // Um provedor de checkout hospedado não gera Pix, e o botão rotulado "Gerar
    // Pix" prometeria ao operador uma coisa que a tela entregaria como outra.
    supabase
      .from('payment_provider_accounts')
      .select('provider')
      .eq('tenant_id', tenantId)
      .eq('is_default', true)
      .eq('active', true)
      .maybeSingle(),
    // Quem registrou o recebimento manual. `payments.received_by` é um id de
    // `auth.users`, que `authenticated` não lê direto — `list_tenant_members` é
    // SECURITY DEFINER e resolve o nome.
    //
    // Ela é owner/admin apenas, então para um Operator isto volta vazio. A tela
    // continua dizendo que o recebimento foi manual; só não diz por quem. É
    // degradação honesta: melhor omitir o nome do que inventar um.
    supabase.rpc('list_tenant_members', { p_search: null }),
    // "Hoje" do encargo é o da LOCADORA. A página roda no servidor (UTC na
    // Vercel): com `new Date()`, a partir das 21h de Brasília a cobrança que
    // vence hoje aparecia com multa e juros de um dia.
    fetchTenantTimezone(supabase, tenantId),
  ])

  if (balanceResult.error || !balanceResult.data) notFound()

  // Sem gateway eleito o método fica nulo e o botão volta ao rótulo genérico —
  // gerar vai falhar de qualquer forma, com a mensagem que aponta para
  // Configurações.
  const electedProvider = (gatewayResult.data as { provider: string } | null)?.provider ?? null
  const gatewayMethod = (electedProvider ? findPaymentProvider(electedProvider) : null)?.methods[0] ?? null

  const balance = balanceResult.data as unknown as {
    charge_id: string; customer_id: string; rental_id: string | null
    charge_number: number; status: 'open' | 'paid' | 'cancelled' | 'written_off'
    issue_date: string; due_date: string
    total_amount: number; paid_amount: number; open_amount: number
    late_charge_amount: number
    is_overdue: boolean; days_overdue: number
  }

  const items = (itemsResult.data ?? []) as unknown as {
    id: string; description: string; credit_account_code: string
    quantity: number; unit_amount: number; amount: number
    source_module: string; created_at: string
  }[]

  // Nome de quem registrou o recebimento manual, por id.
  const nomePorUsuario = new Map<string, string>(
    ((membrosResult.data ?? []) as { user_id: string; name: string | null; email: string }[])
      .map((m) => [m.user_id, m.name || m.email]),
  )

  type PaymentRow = {
    id: string; amount: number; method: string; paid_at: string
    notes: string | null; reversed_at: string | null
    received_by: string | null; received_by_system: string | null
    intent: { provider: string } | { provider: string }[] | null
  }
  type AllocRow = {
    id: string; amount: number; created_at: string
    payment: PaymentRow | PaymentRow[] | null
  }

  /**
   * De onde veio o dinheiro.
   *
   * A pergunta que a tela não respondia: um recebimento de R$ 100 aparecia como
   * "PIX" tanto se a Cora confirmou sozinha quanto se alguém digitou à mão — e
   * são situações que exigem coisas diferentes de quem confere.
   *
   * Duas fontes, em ordem de confiança:
   *
   *   1. `received_by_system` — gravado pela RPC de confirmação (ADR 0034,
   *      Fase 1). É o que o próprio caminho do dinheiro registrou.
   *   2. o provedor do INTENT — cobre os recebimentos anteriores àquela coluna.
   *      Menos direto, mas suficiente: pagamento amarrado a uma tentativa de
   *      gateway veio de gateway.
   *
   * Sem nenhuma das duas, foi registrado por gente. Não é inferência frouxa:
   * `fn_confirm_gateway_payment` SEMPRE marca a origem, então a ausência das
   * duas só sobra para o caminho manual.
   */
  function origemDoPagamento(p: PaymentRow | null) {
    const intent = Array.isArray(p?.intent) ? p?.intent[0] : p?.intent
    const provider = p?.received_by_system?.replace(/^gateway:/, '') ?? intent?.provider ?? null

    if (provider) {
      return {
        tipo: 'gateway' as const,
        label: findPaymentProvider(provider)?.label ?? provider,
      }
    }

    const quem = p?.received_by ? nomePorUsuario.get(p.received_by) ?? null : null
    return { tipo: 'manual' as const, label: quem }
  }

  const payments = ((allocationsResult.data ?? []) as unknown as AllocRow[]).map((a) => {
    const p = Array.isArray(a.payment) ? a.payment[0] : a.payment
    return {
      // `id` aqui é o da ALOCAÇÃO, e a linha da tabela é por alocação. O
      // estorno age sobre o PAGAMENTO — passar um pelo outro dá "pagamento não
      // encontrado" com os dois campos parecendo igualmente plausíveis.
      id: a.id,
      payment_id: p?.id ?? null,
      amount: a.amount,
      payment_method: p?.method ?? '—',
      paid_at: p?.paid_at ?? a.created_at,
      notes: p?.notes ?? null,
      reversed: !!p?.reversed_at,
      origem: origemDoPagamento(p),
    }
  })

  // Cliente e veículo em consulta separada: `charge_balances` agrega por
  // cobrança, e juntar tabelas ali reintroduziria o fan-out de F-01.
  const [customerRes, rentalRes] = await Promise.all([
    supabase.from('customers').select('id, name, phone').eq('id', balance.customer_id).maybeSingle(),
    balance.rental_id
      ? supabase.from('rentals').select('id, vehicles(id, license_plate, make, model)').eq('id', balance.rental_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const customer = customerRes.data as { id: string; name: string; phone: string | null } | null
  type RentalVehicle = { id: string; vehicles: { id: string; license_plate: string; make: string; model: string } | { id: string; license_plate: string; make: string; model: string }[] | null }
  const rentalRow = rentalRes.data as unknown as RentalVehicle | null
  const vehicle = rentalRow
    ? (Array.isArray(rentalRow.vehicles) ? rentalRow.vehicles[0] : rentalRow.vehicles)
    : null

  // Saldo de crédito do cliente — derivado, não coluna.
  const { data: creditBalanceRow } = await supabase
    .from('customer_credit_balances')
    .select('balance')
    .eq('customer_id', balance.customer_id)
    .maybeSingle()

  const creditBalance = (creditBalanceRow as { balance: number } | null)?.balance ?? 0

  const { data: creditRows } = await supabase
    .from('customer_credits')
    .select('id, amount, origin, reason, expires_at')
    .eq('customer_id', balance.customer_id)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })

  const availableCredits = ((creditRows ?? []) as { id: string; amount: number; origin: string; reason: string }[])
    .map((c) => ({ ...c, available_balance: creditBalance }))

  // Encargo acumulado: projetado até ser consolidado (R-06).
  const { data: chargeRow } = await supabase
    .from('charges')
    .select('late_charge_policy_id, cancellation_reason')
    .eq('id', id)
    .maybeSingle()

  const charge = chargeRow as {
    late_charge_policy_id: string | null; cancellation_reason: string | null
  } | null
  const policyId = charge?.late_charge_policy_id
  let policy: LateChargePolicy | null = null

  // `version` e `effective_from` não entram na conta — entram na EXPLICAÇÃO.
  // Sem elas a tela mostrava "Multa R$ 17,50" e o operador não tinha como saber
  // de onde saiu o número, nem que a regra desta cobrança é a fixada na emissão
  // e não a que está em Configurações agora.
  let policyMeta: { version: number; effective_from: string } | null = null

  if (policyId) {
    const { data: policyRow } = await supabase
      .from('late_charge_policies')
      .select('fee_type, fee_value, daily_interest_rate, grace_period_days, min_amount, version, effective_from')
      .eq('id', policyId)
      .maybeSingle()

    const row = policyRow as (LateChargePolicy & { version: number; effective_from: string }) | null
    policy = row
    policyMeta = row ? { version: row.version, effective_from: row.effective_from } : null
  }

  // Quanto esta cobrança deve — pela função canônica, a mesma que a LISTA de
  // cobranças e o app do cliente usam.
  //
  // Aqui a conta era refeita à mão: `isTerminal ? 0 : max(0, open + accrued)`.
  // Aritmeticamente igual, menos por um detalhe — a cópia perdeu o `round2`, e
  // devolvia resíduo de ponto flutuante (250.00000000000003 onde a lista dava
  // 250,00). Esse número vira o TETO do campo de recebimento, então as duas
  // telas discordavam sobre o valor exato que quita a dívida.
  //
  // A regra de status terminal continua valendo e agora vive num lugar só:
  // `charge_balances.open_amount` é a aritmética do documento (total − alocado)
  // e devolve o saldo de uma cobrança baixada — correto para registrar a perda,
  // errado de exibir como "a pagar".
  const {
    accrued, amount_due: amountDue,
    principal: principalEmAberto, late_charge_realized: jaLancado, accrued_pending: aAcrescentar,
  } = calculateAmountDue(balance, policy, tenantToday(timezone))
  const statusCfg = STATUS_CONFIG[balance.is_overdue ? 'overdue' : balance.status] ?? STATUS_CONFIG.open

  // A REGRA em números que o operador reconhece: percentual ao mês como ele
  // digitou em Configurações, não a taxa diária que o banco guarda. Mesma
  // conversão que a tela de Configurações usa, pela mesma função.
  const policyView = policy ? toPolicyInput(policy) : null

  // O mínimo só aparece quando MORDE: multa + juros abaixo do piso significa que
  // o total exibido não é a soma das duas linhas acima, e sem dizer isso a
  // tabela parece errada.

  /** Encargo em PROJEÇÃO: corre enquanto a cobrança está aberta e vencida. */
  const chargesCalc = accrued.total > 0 ? accrued : null

  // Encargo REALIZADO: virou item da cobrança no recebimento (R-06). Depois
  // disso `open_amount` cai a zero, `calculateAccruedCharges` devolve zero e o
  // bloco de encargos sumia inteiro — a regra que gerou receita de verdade
  // ficava invisível exatamente quando havia o que auditar.
  const encargoRealizado = Math.round(
    items.filter((i) => i.source_module === 'late_charge').reduce((sum, i) => sum + i.amount, 0) * 100,
  ) / 100

  const cobrandoAgora  = !!chargesCalc && !chargesCalc.grace_period_active && chargesCalc.total > 0
  const naCarencia     = !!chargesCalc?.grace_period_active

  // Principal sobre o qual o encargo correu: o que a cobrança emitiu SEM o
  // próprio encargo. Somar o item de encargo aqui faria juros sobre juros.
  const principalEmitido = round2(
    items.filter((i) => i.source_module !== 'late_charge').reduce((sum, i) => sum + i.amount, 0),
  )

  const rateioRealizado = policy && encargoRealizado > 0 && !cobrandoAgora
    ? rateioDoEncargoRealizado(
        policy, balance.due_date, principalEmitido, encargoRealizado,
        payments.filter((p) => !p.reversed).map((p) => ({ paid_at: p.paid_at, amount: p.amount })),
        timezone,
      )
    : null

  // Uma abertura só, usada pelos dois estados: o encargo que ainda corre e o
  // que já virou item. O que muda é a origem dos números, não a forma.
  const encargoExibido = cobrandoAgora
    // O principal é o saldo SEM o encargo ainda não pago (ADR 0028). Usar
    // `open_amount` aqui descrevia a regra sobre uma base que incluía o próprio
    // encargo — e era a mesma base que a conta usava, cobrando multa de novo.
    ? { accrued: chargesCalc!, principal: principalEmAberto, realizado: false }
    : rateioRealizado
      ? { accrued: rateioRealizado, principal: principalEmitido, realizado: true }
      : null

  // O mínimo só aparece quando MORDE: com multa + juros abaixo do piso, o total
  // deixa de ser a soma das duas linhas acima, e sem dizer isso a tabela parece
  // errada.
  const somaBruta = encargoExibido
    ? round2(encargoExibido.accrued.fee + encargoExibido.accrued.interest)
    : 0
  const minimoMordeu = !!policy && !!encargoExibido && policy.min_amount > 0 && somaBruta < policy.min_amount

  // Encargo já calculado acima a partir da política fixada na emissão.
  const lateChargesList: { id: string; fee: number; interest: number; total: number; days_overdue: number; captured_at: string }[] = []
  const creditAppsList: { id: string; amount: number; is_auto: boolean; created_at: string; credit: { origin: string; reason: string } | null }[] = []

  // Alias com a forma que o JSX desta página consome. O item de maior valor
  // representa a cobrança no título — no modelo novo a descrição vive nos
  // ITENS, não no documento.
  const principalItem = [...items].sort((a, b) => b.amount - a.amount)[0]

  // Recebimentos que ainda valem — estornado não é pagamento.
  const recebimentos = payments.filter((p) => !p.reversed)
  const ultimoRecebimento = [...recebimentos].sort((a, b) =>
    String(a.paid_at) < String(b.paid_at) ? 1 : -1)[0]
  const formas = new Set(recebimentos.map((p) => p.payment_method))
  const formaUnica: string | null =
    balance.status === 'paid' && formas.size === 1 ? [...formas][0]! : null

  // Desconto é item negativo (`source_module = 'discount'`), não coluna —
  // `balance.total_amount` já vem NETO dele. O valor bruto emitido é a soma
  // do que sobra sem os itens de desconto; sem separar os dois, "R$ 30 − R$ 5
  // de desconto" mostraria R$ 25, quando o total já é R$ 30.
  const discountAmount = round2(
    -items.filter((i) => i.source_module === 'discount').reduce((sum, i) => sum + i.amount, 0),
  )
  const grossAmount = round2(balance.total_amount + discountAmount)

  const billing = {
    id: balance.charge_id,
    charge_number: balance.charge_number,
    // billing_type e source saíram: a origem vive nos ITENS. O item principal
    // representa a cobrança quando a tela precisa de um rótulo único (F-11).
    billing_type: balance.rental_id ? 'cycle' : 'one_time',
    source: principalItem?.source_module ?? 'manual',
    // "Pago em" é a data do RECEBIMENTO. A linha era
    // `balance.status === 'paid' ? balance.due_date : null` — o vencimento com
    // outro rótulo, e ainda por `fmtDatetime`, que lê "YYYY-MM-DD" como
    // meia-noite UTC e devolve o dia anterior às 21:00. Uma cobrança recebida
    // em 21/08/2026 aparecia "Pago em 20/07/2026, 21:00": um mês antes, e antes
    // do próprio vencimento. A data real sempre esteve em `payments.paid_at`,
    // logo abaixo na tabela de pagamentos.
    paid_at: balance.status === 'paid' ? (ultimoRecebimento?.paid_at ?? null) : null,
    // Só quando houver uma forma única: com dois recebimentos por meios
    // diferentes, exibir um deles no cabeçalho seria escolher qual mentira
    // contar. A tabela de pagamentos discrimina cada um.
    payment_method: formaUnica,
    // `waiver_reason` era fixo em `null` desde que a dispensa de encargo saiu
    // (R-06: encargo é projetado e só vira receita ao receber). A linha da
    // tabela existia e nunca renderizava.
    //
    // No lugar entra o motivo que o operador REALMENTE digita. Cancelar e dar
    // baixa exigem justificativa, `cancelCharge`/`writeOffCharge` gravam em
    // `charges.cancellation_reason` — e nenhuma tela lia. O operador escrevia
    // para o nada.
    cancellation_reason: charge?.cancellation_reason ?? null,
    lease_id: balance.rental_id,
    description: principalItem?.description ?? `Cobrança #${balance.charge_number}`,
    original_amount: grossAmount,
    discount_amount: discountAmount,
    credit_applied: 0,
    due_date: balance.due_date,
    status: balance.status,
    customer_id: balance.customer_id,
    charges_waived: false,
  }
  const creditApplied = 0

  return (
    <div className="min-h-screen bg-bg">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-divider bg-bg px-6">
        <Link href="/cobrancas" className="whitespace-nowrap text-[13px] text-fg-mute transition-colors hover:text-fg">
          ← Cobranças
        </Link>
        <span className="text-border">/</span>
        <h1 className="flex-1 truncate text-[15px] font-bold text-fg">
          {billing.description ?? `Cobrança #${id.slice(0, 8)}`}
        </h1>
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">

        {/* ── Status + valor ────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-4">
          {/* "Vencida" sozinha não diz o tamanho do problema: vencida ontem e
              vencida há três meses são conversas diferentes com o cliente. O
              número vem de `charge_balances.days_overdue`, que é a distância até
              o vencimento — NÃO desconta carência. É por isso que ele pode ser
              maior que os "N dias de atraso" do bloco de encargo, que conta os
              dias em que multa e juros efetivamente correram. */}
          <span className={`inline-flex h-7 items-center rounded-full border px-3 text-[13px] font-medium ${statusCfg.bg} ${statusCfg.text} ${statusCfg.border}`}>
            {statusCfg.label}
            {balance.is_overdue && balance.days_overdue > 0 && (
              <> há {balance.days_overdue} dia{balance.days_overdue !== 1 ? 's' : ''}</>
            )}
          </span>
          <span className="text-2xl font-bold text-fg">
            {formatCurrency(billing.original_amount)}
          </span>
          {billing.discount_amount ? (
            <span className="text-[14px] text-fg-mute">− {formatCurrency(billing.discount_amount)} desconto</span>
          ) : null}
          {creditApplied > 0 ? (
            <span className="text-[14px] text-fg-mute">− {formatCurrency(creditApplied)} crédito</span>
          ) : null}
          {amountDue > 0 && (balance.is_overdue ? 'overdue' : balance.status) !== 'paid' && (balance.is_overdue ? 'overdue' : balance.status) !== 'cancelled' && (
            <span className={`text-[14px] font-semibold ${(balance.is_overdue ? 'overdue' : balance.status) === 'overdue' ? 'text-danger' : 'text-info'}`}>
              = {formatCurrency(amountDue)} a pagar
            </span>
          )}
          {billing.charges_waived && (
            <span className="rounded-full bg-surface px-3 py-0.5 text-[12px] text-fg-mute">
              Encargos dispensados
            </span>
          )}
        </div>

        {/* ── Dados da cobrança ─────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">Cobrança</h2>
          <div className="overflow-hidden rounded-xl bg-surface">
            <table className="w-full text-[13px]">
              <tbody>
                {([
                  ['Tipo',           BILLING_TYPE_LABELS[billing.billing_type ?? 'one_time'] ?? '—'],
                  ['Origem',         SOURCE_LABELS[billing.source ?? ''] ?? billing.source ?? '—'],
                  ['Vencimento',     fmt(billing.due_date)],
                  ['Pago em',        billing.paid_at ? fmtDatetime(billing.paid_at) : null],
                  ['Forma de pag.',  billing.payment_method ? (PAYMENT_METHOD_LABELS[billing.payment_method] ?? billing.payment_method) : null],
                ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([label, value]) => (
                  <tr key={label} className="border-b border-divider last:border-0">
                    <td className="h-9 w-44 shrink-0 px-4 text-fg-mute">{label}</td>
                    <td className="h-9 px-4 text-fg">{value}</td>
                  </tr>
                ))}
                {billing.cancellation_reason && (
                  <tr className="border-b border-divider last:border-0">
                    <td className="h-9 w-44 shrink-0 px-4 text-fg-mute">
                      {balance.status === 'written_off' ? 'Motivo da baixa' : 'Motivo do cancelamento'}
                    </td>
                    <td className="h-9 px-4 text-fg italic">{billing.cancellation_reason}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Vínculo ───────────────────────────────────────────────────── */}
        {(customer || vehicle) && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-primary">Vínculo</h2>
            <div className="grid grid-cols-2 gap-4">
              {customer && (
                <div className="space-y-1 rounded-xl bg-surface p-4">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-fg-mute">Cliente</p>
                  <p className="text-[15px] font-bold text-fg">{customer.name}</p>
                  {customer.phone && <p className="text-[13px] text-fg-mute">{customer.phone}</p>}
                  <Link href={`/clientes/${customer.id}`} className="text-[12px] text-fg-mute transition-colors hover:text-primary">
                    Ver cliente →
                  </Link>
                </div>
              )}
              {vehicle && (
                <div className="space-y-1 rounded-xl bg-surface p-4">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-fg-mute">Veículo</p>
                  <p className="font-mono text-[15px] font-bold text-primary">{vehicle.license_plate}</p>
                  <p className="text-[13px] text-fg">{vehicle.make} {vehicle.model}</p>
                  {billing.lease_id && (
                    <Link href={`/locacoes/${billing.lease_id}`} className="text-[12px] text-fg-mute transition-colors hover:text-primary">
                      Ver locação →
                    </Link>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Encargo por atraso ────────────────────────────────────────── */}
        {/* A seção vale para os dois momentos do encargo: enquanto ele é
            PROJEÇÃO (cobrança aberta e vencida) e depois que virou ITEM, no
            recebimento. A abertura é a mesma nos dois — multa, juros e a regra
            que produziu cada um. O que muda é de onde vêm os números, e isso
            não é motivo para o operador reaprender a ler a tela. */}
        {(policy || (balance.is_overdue && balance.status === 'open')) && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-primary">
              Encargo por atraso
              {encargoExibido && (
                <span className="ml-2 text-[12px] font-normal text-fg-mute">
                  {encargoExibido.accrued.days_overdue} dia{encargoExibido.accrued.days_overdue !== 1 ? 's' : ''} de atraso
                  {encargoExibido.realizado && ' · já lançado'}
                </span>
              )}
            </h2>

            {!policy ? (
              /* Vencida sem regra é resultado legítimo, e silêncio parecia falha:
                 a tela não mostrava encargo e não dizia por quê. */
              <div className="rounded-xl bg-surface px-4 py-3">
                <p className="text-[13px] text-fg-mute">
                  Esta cobrança foi emitida sem política de encargo — vencida, ela continua
                  devendo o valor original, sem multa nem juros.
                </p>
              </div>
            ) : (
              <>
                {encargoExibido && (
                  <div className="overflow-hidden rounded-xl bg-surface">
                    {/* Terceira coluna: a REGRA que produziu o número. Sem ela o bloco
                        informava "Multa R$ 17,50" e deixava o operador sem meio de
                        conferir. */}
                    <table className="w-full text-[13px]">
                      <tbody>
                        <tr className="border-b border-divider">
                          <td className="h-9 w-44 px-4 text-fg-mute">Multa</td>
                          <td className="h-9 w-32 px-4 font-mono text-fg">{formatCurrency(encargoExibido.accrued.fee)}</td>
                          <td className="h-9 px-4 text-[12px] text-fg-mute">
                            {regraDaMulta(policy, policyView!, encargoExibido.principal)}
                          </td>
                        </tr>
                        <tr className="border-b border-divider">
                          <td className="h-9 w-44 px-4 text-fg-mute">Juros</td>
                          <td className="h-9 w-32 px-4 font-mono text-fg">{formatCurrency(encargoExibido.accrued.interest)}</td>
                          <td className="h-9 px-4 text-[12px] text-fg-mute">
                            {regraDosJuros(policyView!, encargoExibido.principal, encargoExibido.accrued.days_overdue)}
                          </td>
                        </tr>
                        {minimoMordeu && (
                          <tr className="border-b border-divider">
                            <td className="h-9 w-44 px-4 text-fg-mute">Encargo mínimo</td>
                            <td className="h-9 w-32 px-4 font-mono text-fg">{formatCurrency(policy.min_amount)}</td>
                            <td className="h-9 px-4 text-[12px] text-fg-mute">
                              aplicado — multa + juros somariam {formatCurrency(somaBruta)}
                            </td>
                          </tr>
                        )}
                        {!encargoExibido.realizado && jaLancado > 0 && (
                          <tr className="border-b border-divider">
                            <td className="h-9 w-44 px-4 text-fg-mute">Já lançado</td>
                            <td className="h-9 w-32 px-4 font-mono text-fg">−{formatCurrency(jaLancado)}</td>
                            <td className="h-9 px-4 text-[12px] text-fg-mute">
                              já é item desta cobrança, de um recebimento anterior — está dentro
                              dos {formatCurrency(balance.open_amount)} em aberto e não é cobrado de novo
                            </td>
                          </tr>
                        )}
                        {encargoExibido.realizado ? (
                          <tr>
                            <td className="h-9 w-44 px-4 font-medium text-fg">Encargo lançado</td>
                            <td className="h-9 w-32 px-4 font-mono font-bold text-fg">{formatCurrency(encargoExibido.accrued.total)}</td>
                            <td className="h-9 px-4 text-[12px] text-fg-mute">
                              virou item desta cobrança no recebimento — a composição abaixo traz a linha
                            </td>
                          </tr>
                        ) : (
                          <tr>
                            <td className="h-9 w-44 px-4 font-medium text-fg">Total com encargos</td>
                            {/* `amountDue` JÁ inclui o encargo acumulado (saldo +
                                acréscimo). Somar de novo aqui exibia o encargo em
                                dobro: R$ 532,88 no bloco contra R$ 516,44 no cabeçalho,
                                dois números para a mesma coisa na mesma tela. */}
                            <td className="h-9 w-32 px-4 font-mono font-bold text-danger">{formatCurrency(amountDue)}</td>
                            <td className="h-9 px-4 text-[12px] text-fg-mute">
                              {formatCurrency(balance.open_amount)} em aberto + {formatCurrency(aAcrescentar)} de encargo
                              {jaLancado > 0 && ' ainda não lançado'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {naCarencia && (
                  <div className="rounded-xl bg-surface px-4 py-3">
                    <p className="text-[13px] text-fg-mute">
                      Dentro do período de carência — encargo não aplicado ainda.
                      {policyView && (
                        <>
                          {' '}A política desta cobrança dá {policyView.grace_period_days} dia
                          {policyView.grace_period_days !== 1 ? 's' : ''} de carência e o vencimento
                          passou há {chargesCalc!.days_since_due}. Multa e juros começam a correr
                          {/* +1: o encargo passa a existir no dia em que `days_since_due`
                              ULTRAPASSA a carência, não no dia em que a iguala. Sem isto a
                              frase dizia "em 0 dias" no último dia de carência. */}
                          {' '}em {policyView.grace_period_days - chargesCalc!.days_since_due + 1} dia
                          {policyView.grace_period_days - chargesCalc!.days_since_due + 1 !== 1 ? 's' : ''}.
                        </>
                      )}
                    </p>
                  </div>
                )}

                {/* Encargo lançado que a reconstrução não conseguiu reproduzir ao
                    centavo. Mostrar um rateio que não fecha seria pior que mostrar
                    só o total: o operador confere e não bate. */}
                {!encargoExibido && !naCarencia && encargoRealizado > 0 && (
                  <div className="rounded-xl bg-surface px-4 py-3">
                    <p className="text-[13px] text-fg-mute">
                      Encargo de <span className="font-mono text-fg">{formatCurrency(encargoRealizado)}</span>{' '}
                      já lançado como item desta cobrança, no recebimento. A composição abaixo
                      traz a linha; a abertura em multa e juros não pôde ser reconstruída para
                      este caso.
                    </p>
                  </div>
                )}

                {!encargoExibido && !naCarencia && encargoRealizado === 0 && (
                  <div className="rounded-xl bg-surface px-4 py-3">
                    <p className="text-[13px] text-fg-mute">
                      {balance.status === 'open'
                        ? 'Nenhum encargo até aqui. Se esta cobrança vencer, é esta a regra que passa a correr:'
                        : 'Nenhum encargo foi cobrado nesta cobrança. A regra que valia para ela era:'}
                    </p>
                  </div>
                )}

                {policyView && (
                  <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                    Regra fixada na emissão desta cobrança
                    {policyMeta && <>: <span className="text-fg-soft">política versão {policyMeta.version}</span>, vigente desde {fmt(policyMeta.effective_from)}</>}.
                    {' '}Multa de{' '}
                    <span className="text-fg-soft">
                      {policy.fee_type === 'percentage'
                        ? `${num(policyView.fee_value)}% sobre o saldo`
                        : formatCurrency(policy.fee_value)}
                    </span>, cobrada uma vez;
                    {' '}juros de <span className="text-fg-soft">{num(policyView.monthly_interest_percent)}% ao mês</span>{' '}
                    ({num(policyView.monthly_interest_percent / DAYS_PER_MONTH, 4)}% ao dia, sobre o saldo em aberto);
                    {' '}carência de {policyView.grace_period_days} dia{policyView.grace_period_days !== 1 ? 's' : ''} após o vencimento;
                    {' '}encargo mínimo de {formatCurrency(policyView.min_amount)}.
                    {' '}Alterar a política em Configurações passa a valer para cobranças emitidas depois — esta continua com a regra do dia em que saiu.
                  </p>
                )}
              </>
            )}
          </section>
        )}

        {/* ── Composição da cobrança ────────────────────────────────────── */}
        {/* A tela CARREGAVA os itens e só os usava para escolher o título. Quem
            abria uma cobrança de R$ 370 via o total e nada do que o forma: nem
            o aluguel, nem o encargo realizado, nem o crédito abatido. Sem isso
            não há como conferir uma conta — só acreditar nela. */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">
            Composição
            <span className="ml-2 text-[12px] font-normal text-fg-mute">({items.length})</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-divider">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-divider bg-surface">
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Item</th>
                  <th className="h-9 px-4 text-left font-medium text-fg-mute">Origem</th>
                  <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b border-border last:border-0">
                    <td className="h-9 px-4 text-fg">{it.description}</td>
                    <td className="h-9 px-4 text-fg-mute">
                      {SOURCE_LABELS[it.source_module] ?? it.source_module}
                    </td>
                    <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(it.amount)}</td>
                  </tr>
                ))}
                <tr className="border-t border-divider bg-surface">
                  <td className="h-9 px-4 font-medium text-fg-mute" colSpan={2}>Total emitido</td>
                  <td className="h-9 px-4 text-right font-mono font-bold text-fg">
                    {formatCurrency(balance.total_amount)}
                  </td>
                </tr>
                {/* Encargo AINDA NÃO realizado é projeção, não item: só vira
                    linha da cobrança quando alguém recebe. Aparece aqui como
                    previsão para o total bater com o "a pagar" do topo — por
                    isso é o que FALTA acrescentar, não o encargo corrente: o já
                    lançado está em "Total emitido", uma linha acima (ADR 0028). */}
                {aAcrescentar > 0 && (
                  <tr className="border-t border-divider">
                    <td className="h-9 px-4 text-warning" colSpan={2}>
                      Encargo previsto · {accrued.days_overdue} dia{accrued.days_overdue === 1 ? '' : 's'} de atraso
                      <span className="ml-2 text-[12px] text-fg-mute">ainda não lançado</span>
                    </td>
                    <td className="h-9 px-4 text-right font-mono text-warning">
                      + {formatCurrency(aAcrescentar)}
                    </td>
                  </tr>
                )}
                {balance.paid_amount > 0 && (
                  <tr className="border-t border-divider">
                    <td className="h-9 px-4 text-success" colSpan={2}>Recebido e abatido</td>
                    <td className="h-9 px-4 text-right font-mono text-success">
                      − {formatCurrency(balance.paid_amount)}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-divider bg-surface">
                  <td className="h-9 px-4 font-medium text-fg-mute" colSpan={2}>A pagar</td>
                  <td className="h-9 px-4 text-right font-mono font-bold text-fg">
                    {formatCurrency(amountDue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Histórico de pagamentos ───────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">
            Pagamentos
            {payments.length > 0 && <span className="ml-2 text-[12px] font-normal text-fg-mute">({payments.length})</span>}
          </h2>
          {payments.length === 0 ? (
            <div className="flex items-center justify-center rounded-xl bg-surface py-8">
              <p className="text-[13px] text-fg-mute">Nenhum pagamento registrado.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Data</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Forma</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Origem</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Observação</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      {/* `nowrap` nas duas primeiras: com a observação ocupando largura,
                          a data quebrava no meio ("24/08/2026," numa linha, "12:00" na outra). */}
                      <td className="h-9 whitespace-nowrap px-4 text-fg-soft">{fmtDatetime(p.paid_at)}</td>
                      <td className="h-9 whitespace-nowrap px-4 text-fg-mute">{PAYMENT_METHOD_LABELS[p.payment_method] ?? p.payment_method}</td>
                      {/* Gateway e manual pedem coisas diferentes de quem confere:
                          o primeiro tem contrapartida no extrato do provedor, o
                          segundo depende de alguém ter digitado certo. Sem esta
                          coluna, os dois apareciam idênticos como "PIX". */}
                      <td className="h-9 whitespace-nowrap px-4">
                        {p.origem.tipo === 'gateway' ? (
                          <span className="text-fg-soft">{p.origem.label}</span>
                        ) : (
                          <span className="text-fg-mute">
                            Manual
                            {p.origem.label ? (
                              <span className="text-fg-soft"> · {p.origem.label}</span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className={`h-9 px-4 text-right font-mono font-semibold ${
                        p.reversed ? 'text-fg-mute line-through' : 'text-success'
                      }`}>
                        {formatCurrency(p.amount)}
                      </td>
                      {/* Sem `truncate`: o que o operador digitou ao receber é a única
                          explicação de "por que este valor, deste jeito" — cortar em 200px
                          escondia justamente a observação que valia a pena escrever. Texto
                          longo quebra linha e cresce a altura da linha; curto, que é o caso
                          comum, continua em `h-9`. */}
                      <td className="h-9 px-4 text-fg-soft">
                        {p.notes ?? <span className="text-fg-mute">—</span>}
                      </td>
                      <td className="h-9 px-4 text-right">
                        {p.reversed
                          ? <span className="text-[12px] text-fg-mute">Estornado</span>
                          : p.payment_id
                            ? <ReversePaymentButton paymentId={p.payment_id} amount={p.amount} />
                            : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Encargos capturados ───────────────────────────────────────── */}
        {lateChargesList.length > 0 && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-primary">
              Encargos registrados
              <span className="ml-2 text-[12px] font-normal text-fg-mute">({lateChargesList.length})</span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Data</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Multa</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Juros</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Total</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Dias</th>
                  </tr>
                </thead>
                <tbody>
                  {lateChargesList.map(lc => (
                    <tr key={lc.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 px-4 text-fg-soft">{fmtDatetime(lc.captured_at)}</td>
                      <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(lc.fee)}</td>
                      <td className="h-9 px-4 text-right font-mono text-fg">{formatCurrency(lc.interest)}</td>
                      <td className="h-9 px-4 text-right font-mono font-semibold text-danger">{formatCurrency(lc.total)}</td>
                      <td className="h-9 px-4 text-right text-fg-mute">{lc.days_overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Créditos aplicados ────────────────────────────────────────── */}
        {creditAppsList.length > 0 && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-primary">
              Créditos aplicados
              <span className="ml-2 text-[12px] font-normal text-fg-mute">({creditAppsList.length})</span>
            </h2>
            <div className="overflow-hidden rounded-xl border border-divider">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-divider bg-surface">
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Data</th>
                    <th className="h-9 px-4 text-left font-medium text-fg-mute">Origem</th>
                    <th className="h-9 px-4 text-right font-medium text-fg-mute">Valor</th>
                    <th className="h-9 px-4 font-medium text-fg-mute">Tipo</th>
                  </tr>
                </thead>
                <tbody>
                  {creditAppsList.map(ca => (
                    <tr key={ca.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="h-9 px-4 text-fg-soft">{fmt(ca.created_at)}</td>
                      <td className="h-9 px-4 text-fg-mute">
                        {ca.credit ? (CREDIT_ORIGIN_LABELS[ca.credit.origin] ?? ca.credit.origin) : '—'}
                      </td>
                      <td className="h-9 px-4 text-right font-mono font-semibold text-info">{formatCurrency(ca.amount)}</td>
                      <td className="h-9 px-4 text-fg-mute">{ca.is_auto ? 'Automático' : 'Manual'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Ações ─────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-primary">Ações</h2>
          {/* Valores reais. Estavam fixos em `accruedCharges={0}` e
              `isOverdue={false}`, e a condição do botão "Consolidar encargo" é
              `isOverdue && accruedCharges > 0` — ou seja, ele NUNCA era
              renderizado, e realizar o encargo era inalcançável pela tela. */}
          <BillingActions
            billingId={id}
            status={(balance.is_overdue ? 'overdue' : balance.status)}
            amountDue={amountDue}
            cobranca={{
              chargeId:     balance.charge_id,
              chargeNumber: balance.charge_number,
              customerId:   balance.customer_id,
              customerName: customer?.name ?? '—',
              dueDate:      balance.due_date,
              openAmount:   balance.open_amount,
          paidAmount:   balance.paid_amount,
          lateChargeAmount: balance.late_charge_amount,
              status:       balance.status,
            }}
            latePolicy={policy}
            gatewayMethod={gatewayMethod}
            customerId={billing.customer_id ?? ''}
            availableCredits={availableCredits}
            creditBalance={creditBalance}
          />
        </section>

      </div>
    </div>
  )
}
