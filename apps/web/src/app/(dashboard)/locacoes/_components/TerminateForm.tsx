'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ChevronRight, Bike, CalendarX2, ReceiptText } from 'lucide-react'

import {
  useRentalOpenCharges,
  useDepositBalance,
  useCustomerCreditBalance,
  useRentalTerminationPlan,
} from '@gomoto/data'
import {
  getEarlyTerminationImpact,
  isRentalTerminationWithinMinimum,
  minimumFinalKm,
  computeDebtDistribution,
  buildTerminationAllocations,
  clampAllocationInput,
  formatAllocationInput,
  FINE_DEBT_ID,
} from '@gomoto/core'
import type { Rental, DistributionDebt } from '@gomoto/core'
import { formatCurrency, formatDate } from '@/lib/utils'
import { terminateRental, returnRemainingDeposit } from '../actions'
import { settleCustomerCredit } from '../../clientes/[id]/actions'

interface TerminateFormProps {
  rental: Rental
}

/** Destino da SOBRA depois da distribuição (RF-008/RF-009): devolver em dinheiro, ou deixar como está. */
type LeftoverChoice = 'return' | 'keep'

/**
 * Origem da dívida em texto de tela — `source_module` cru ("down_payment") não
 * serve a um operador. Só rótulo de UI: a regra de qual dívida entra na lista
 * não depende disto.
 */
const SOURCE_LABELS: Record<string, string> = {
  rental:                 'Ciclo',
  down_payment:           'Entrada',
  deposit:                'Caução',
  expense:                'Despesa',
  maintenance:            'Manutenção',
  fine:                   'Multa de trânsito',
  early_termination_fine: 'Multa de rescisão',
  late_charge:            'Encargo por atraso',
  manual:                 'Manual',
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Quantas linhas de "Fora do período" a tela mostra antes do botão "Exibir mais".
 * Um contrato longo encerrado cedo cancela dezenas de parcelas: todas na tela
 * empurram a decisão que importa (a distribuição de caução e crédito) para
 * muito longe. O total e o valor a cancelar seguem inteiros na Apuração.
 */
const OUTSIDE_PERIOD_PREVIEW = 5

/** "12,50" digitado → 12.5. Vazio e lixo viram 0; `computeDebtDistribution` saneia de novo. */
function toNumericMap(inputs: Record<string, string>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(inputs).map(([id, v]) => [id, Number(v.replace(',', '.')) || 0]),
  )
}

/**
 * Hoje no fuso do operador.
 *
 * `new Date().toISOString().slice(0, 10)` é UTC: depois das 21h em Brasília ele
 * devolve AMANHÃ, e o encerramento nasceria com data futura sem ninguém
 * escolher isso. O modal de recebimento já tinha `hojeLocal` pelo mesmo motivo.
 */
function hojeLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TerminateForm({ rental }: TerminateFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  /**
   * A data de encerramento serve para RETROAGIR — a devolução foi na sexta e o
   * registro é na segunda —, nunca para adiantar. Encerramento com data futura
   * não existe no produto: a RPC fecha a locação e libera o veículo na hora,
   * então uma data à frente significaria "moto liberada hoje, contrato até
   * dezembro", com as parcelas do intervalo presas em `scheduled` — nunca
   * emitidas (`issue_due_charges` exige locação ativa) e nunca canceladas (o
   * corte é `period_start > p_termination_date`). Encerramento AGENDADO é outra
   * feature: exige a locação seguir ativa até o dia e algo fechá-la lá.
   *
   * Por isso o padrão é o menor entre o fim do contrato e hoje. Ele era
   * `rental.end_date` puro, que em locação em curso é justamente uma data
   * futura: a tela abria no valor que ela deveria recusar, e a apuração
   * mostrava "cronograma a cancelar R$ 0,00" porque nenhum período começa
   * depois do fim do contrato.
   */
  const hoje = hojeLocal()
  const [terminationDate, setTerminationDate] = useState(
    rental.end_date && rental.end_date < hoje ? rental.end_date : hoje,
  )
  const [error, setError] = useState('')

  // Spec 0016 (revisão): cancelamento OPCIONAL de linha que, por estar dentro
  // do período, sobreviveria por padrão — chave é `schedule_line_id` (serve
  // tanto para cobrança já emitida quanto para linha ainda não emitida).
  // Zera sempre que a data muda — mudar a data muda quem é "dentro" e "fora"
  // (RN-002), então uma marcação feita para a data anterior não deve
  // sobreviver em silêncio.
  const [extraSelected, setExtraSelected] = useState<Set<string>>(new Set())

  // "Fora do período" mostra só as primeiras linhas até o operador pedir o resto.
  const [showAllOutside, setShowAllOutside] = useState(false)

  function handleTerminationDateChange(value: string) {
    setTerminationDate(value)
    setExtraSelected(new Set())
    // Mudar a data muda quais cobranças serão canceladas — e, com isso, quais
    // dívidas existem na lista. Valores digitados para a lista anterior não
    // devem sobreviver em silêncio.
    setDepositInputs({})
    setCreditInputs({})
  }

  // Km final (Spec 0014, RN-002 + RN-003 + RN-004) — obrigatório em todo
  // encerramento, mesmo de locação anterior a esta feature (km_initial nulo
  // entra como 0 no piso). Atualiza vehicles.km_current na mesma transação.
  const [kmFinal, setKmFinal] = useState('')
  const pisoKm = minimumFinalKm(rental.vehicle?.km_current ?? 0, rental.km_initial ?? 0)
  const kmFinalNumero = kmFinal === '' ? null : Number(kmFinal)
  const kmFinalInvalido = kmFinalNumero === null || isNaN(kmFinalNumero) || kmFinalNumero < pisoKm

  // Spec 0014: a apuração passa a olhar três coisas distintas — o que foi
  // emitido e não pago, o saldo de caução, e o cronograma ainda não emitido.
  // Antes, `useBillings` misturava documento e plano numa lista só.
  const chargesQuery = useRentalOpenCharges(rental.id)
  const depositQuery = useDepositBalance(rental.id)

  // Spec 0016 (revisão): TODA linha viva do cronograma — vencida, emitida ou
  // planejada —, classificada como fora do período (sempre cancelada, ou
  // bloqueada por já ter valor reduzido) ou dentro dele (mantida, com opção
  // de cancelar mesmo assim).
  const terminationPlanQuery = useRentalTerminationPlan(rental.id, terminationDate)
  const terminationPlan = useMemo(() => terminationPlanQuery.data ?? [], [terminationPlanQuery.data])

  const outsidePeriod = useMemo(() => terminationPlan.filter((l) => l.is_outside_period), [terminationPlan])

  // Só resume quando esconde AO MENOS DUAS: um botão para revelar uma única
  // linha é pior do que mostrá-la.
  const outsideResumida = outsidePeriod.length > OUTSIDE_PERIOD_PREVIEW + 1
  const outsideVisiveis = outsideResumida && !showAllOutside
    ? outsidePeriod.slice(0, OUTSIDE_PERIOD_PREVIEW)
    : outsidePeriod
  const outsideEscondidas = outsidePeriod.length - outsideVisiveis.length
  // `keep_locked` (já paga ou com crédito aplicado) nunca tem nada a decidir
  // aqui — mostrar só polui a lista com o que já está resolvido e continua
  // exatamente igual, dentro ou fora desta tela.
  const insidePeriod = useMemo(
    () => terminationPlan.filter((l) => !l.is_outside_period && l.action !== 'keep_locked'),
    [terminationPlan],
  )

  // Ids (schedule_line_id) que serão cancelados de fato: toda `cancel_auto`
  // (fora do período, sem escolha) + o que o operador marcou por opção dentro
  // dele. `chargeIdsSendoCancelados` é o recorte financeiro (só o que já é
  // documento) usado para excluir do valor em aberto abaixo (RF-004).
  const chargeIdsSendoCancelados = useMemo(() => new Set(
    terminationPlan
      .filter((l) => l.charge_id && (l.action === 'cancel_auto' || (l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id))))
      .map((l) => l.charge_id!),
  ), [terminationPlan, extraSelected])

  // Consulta por LOCAÇÃO, não por cliente: antes o valor em aberto dependia de
  // `rental.customer_id` estar presente, e sem ele a apuração mostrava zero e o
  // encerramento falhava sem explicação.
  //
  // RF-004: cobrança que será cancelada sai daqui ANTES de qualquer conta
  // abaixo (caução, crédito, multa, botão de confirmar) ser calculada — um
  // único filtro na origem em vez de repetir a exclusão em cada `useMemo`.
  const openCharges = useMemo(
    () => (chargesQuery.data ?? []).filter((c) => !chargeIdsSendoCancelados.has(c.charge_id)),
    [chargesQuery.data, chargeIdsSendoCancelados],
  )

  const openAmount     = openCharges.reduce((s, c) => s + c.open_amount, 0)
  const depositBalance = depositQuery.data ?? 0

  /**
   * "Cobranças em aberto" soma tudo que foi EMITIDO e não pago — vencido ou
   * não —, porque é isso que sobrevive ao encerramento e é o mesmo recorte que
   * `terminate_rental` usa para travar (`status = 'open' AND open_amount > 0`).
   * Mostrar só as vencidas faria a tela oferecer um número e o banco recusar
   * por outro.
   *
   * Só que abaixo havia um alerta contando apenas as vencidas: dois recortes
   * diferentes, um debaixo do outro, sem dizer que eram diferentes. A abertura
   * resolve — e passa a ser a ÚNICA fonte da contagem de vencidas na tela, em
   * vez de `impact.overdue_count`, que refazia a mesma conta a partir de
   * `due_date` no relógio do navegador.
   */
  const emAberto = useMemo(() => {
    const vencidas = openCharges.filter(c => c.is_overdue)
    const aVencer  = openCharges.filter(c => !c.is_overdue)
    const soma = (l: typeof openCharges) => l.reduce((s, c) => s + c.open_amount, 0)
    return {
      vencidas: { count: vencidas.length, total: soma(vencidas) },
      aVencer:  { count: aVencer.length,  total: soma(aVencer)  },
    }
  }, [openCharges])

  /**
   * Crédito do cliente — passivo igual à caução, e que estava fora da apuração.
   *
   * A diferença é o escopo: a caução é DESTA locação e precisa de destino aqui;
   * o crédito é do CLIENTE e sobrevive ao contrato. Por isso ele aparece como
   * aviso, não como decisão obrigatória — mas aparecer é o mínimo. Sem isto o
   * contrato encerrava, não sobrava cobrança para abater, e o cliente ia embora
   * credor sem ninguém saber.
   */
  const creditBalance = useCustomerCreditBalance(rental.customer_id).data ?? 0

  /**
   * O que será cancelado de fato, separado por já ter virado documento ou não
   * — a Apuração financeira e o bloco "Ao confirmar" falam desses dois números
   * separadamente (RF-001..RF-005). Fora do período entra inteiro (sem
   * escolha); dentro, só o que foi marcado por opção.
   */
  const willCancel = useMemo(() => {
    const linhas = terminationPlan.filter((l) =>
      l.action === 'cancel_auto' || (l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id)),
    )
    const planejadas = linhas.filter((l) => !l.is_issued)
    const emitidas    = linhas.filter((l) => l.is_issued)
    const soma = (ls: typeof linhas) => ls.reduce((s, l) => s + l.total_amount, 0)
    return {
      planejadas: { count: planejadas.length, total: soma(planejadas) },
      emitidas:    { count: emitidas.length,   total: soma(emitidas)   },
    }
  }, [terminationPlan, extraSelected])

  // Spec 0015: multa e prazo mínimo agora são configuráveis por locação —
  // `getEarlyTerminationImpact` lê a config da própria locação, não mais uma
  // constante por contract_type. Só para feedback instantâneo: o valor e a
  // elegibilidade finais são sempre recalculados de novo na RPC.
  const impact = useMemo(() => {
    if (!rental.start_date) return null
    return getEarlyTerminationImpact(
      openCharges.map(c => ({ due_date: c.due_date, status: 'pending' })),
      new Date(),
      rental.start_date,
      {
        early_termination_fine_amount: rental.early_termination_fine_amount,
        minimum_term_days: rental.minimum_term_days,
      },
    )
  }, [openCharges, rental.start_date, rental.early_termination_fine_amount, rental.minimum_term_days])

  const multaAplicavel = !!impact?.within_minimum && (impact?.fine_amount ?? 0) > 0
  const multaValor = impact?.fine_amount ?? 0

  /** Encerrar com débito em aberto exige confirmação explícita (F-08). */
  const [force, setForce] = useState(false)

  // Spec 0017 — distribuição dirigida de caução e crédito, dívida a dívida.
  // Strings porque o operador está DIGITANDO ("12," ainda não é número); a
  // conversão e a conta ficam em `computeDebtDistribution` (@gomoto/core).
  const [depositInputs, setDepositInputs] = useState<Record<string, string>>({})
  const [creditInputs, setCreditInputs] = useState<Record<string, string>>({})

  // Motivo ÚNICO do abatimento de caução (ADR 0026): explica ao cliente por que
  // o dinheiro dele virou pagamento. Um para a tela toda, não um por dívida.
  const [depositReason, setDepositReason] = useState('')

  /**
   * Destino da SOBRA depois da distribuição. `null` = ainda não escolhido; o
   * efetivo sai de `depositLeftoverEfetivo`/`creditLeftoverEfetivo` abaixo —
   * derivado, e não fixado no mount, porque os saldos vêm de hook e chegam
   * depois do primeiro render.
   */
  const [depositLeftover, setDepositLeftover] = useState<LeftoverChoice | null>(null)
  const [creditLeftover, setCreditLeftover] = useState<LeftoverChoice | null>(null)

  // Elegibilidade de transferência do rent_to_own (compra programada) — regra
  // FIXA de 2 anos, independente da multa configurável (Spec 0015). Não usa
  // `impact` (que agora é sobre a multa): repurpose-ar essa checagem quebraria
  // a transferência de qualquer rent_to_own sem multa configurada.
  const newStatus =
    rental.contract_type === 'rent_to_own' &&
    rental.start_date &&
    !isRentalTerminationWithinMinimum({ start_date: rental.start_date, rental_type: 'rent_to_own' }, new Date())
      ? 'transferred'
      : 'closed'

  /**
   * Multa por rescisão antecipada (Spec 0015). RF-004: decisão explícita de
   * cobrar ou não, antes de confirmar. `null` = ainda não decidido — o botão
   * de confirmar fica bloqueado até o operador escolher (mesmo padrão de
   * `force` para débito em aberto).
   */
  const [multaDecisao, setMultaDecisao] = useState<'charge' | 'skip' | null>(null)

  // Spec 0016 (revisão): dentro do período, decisão explícita por linha —
  // manter (padrão) ou cancelar mesmo assim —, ou todas as elegíveis de uma
  // vez. A bloqueada (`keep_locked`) nunca entra no atalho.
  function setLineDecision(scheduleLineId: string, decision: 'keep' | 'cancel') {
    setExtraSelected((prev) => {
      const next = new Set(prev)
      if (decision === 'cancel') next.add(scheduleLineId)
      else next.delete(scheduleLineId)
      return next
    })
  }

  const optionalLineIds = useMemo(
    () => insidePeriod.filter((l) => l.action === 'keep_optional').map((l) => l.schedule_line_id),
    [insidePeriod],
  )
  const allOptionalMarked = optionalLineIds.length > 0
    && optionalLineIds.every((id) => extraSelected.has(id))

  function toggleMarkAllOptional() {
    setExtraSelected(allOptionalMarked ? new Set() : new Set(optionalLineIds))
  }

  /**
   * A lista de dívidas da distribuição (RF-001): as cobranças em aberto DESTA
   * locação — `openCharges` já exclui o que será cancelado (Spec 0016), então
   * nunca se oferece caução a uma dívida que deixa de existir na mesma
   * confirmação — mais a multa, quando o operador decide cobrá-la.
   *
   * A multa é linha VIRTUAL: o `charge_id` dela só nasce dentro da RPC (Spec
   * 0015). Na tela é uma dívida como as outras (RN-007); no payload, os valores
   * dela seguem nos dois campos escalares (`buildTerminationAllocations`).
   */
  const multaEntraNaLista = multaAplicavel && multaDecisao === 'charge'

  const debts = useMemo<DistributionDebt[]>(() => [
    ...openCharges.map((c) => ({ id: c.charge_id, amount_due: c.open_amount })),
    ...(multaEntraNaLista ? [{ id: FINE_DEBT_ID, amount_due: multaValor }] : []),
  ], [openCharges, multaEntraNaLista, multaValor])

  const debtMeta = useMemo(() => {
    const m = new Map<string, { label: string; origin: string; dueDate: string | null; overdue: boolean }>()
    for (const c of openCharges) {
      m.set(c.charge_id, {
        label: `Cobrança #${c.charge_number}`,
        origin: SOURCE_LABELS[c.source_module] ?? c.source_module,
        dueDate: c.due_date,
        overdue: c.is_overdue,
      })
    }
    m.set(FINE_DEBT_ID, { label: 'Multa por rescisão', origin: 'ao confirmar', dueDate: null, overdue: false })
    return m
  }, [openCharges])

  // Só soma e compara, para mostrar alocado/restante sem ir ao servidor a cada
  // dígito. Quem recusa de verdade é `terminate_rental`, sob trava.
  const distribution = useMemo(() => computeDebtDistribution({
    debts,
    deposit_balance: depositBalance,
    credit_balance: creditBalance,
    deposit_allocations: toNumericMap(depositInputs),
    credit_allocations: toNumericMap(creditInputs),
  }), [debts, depositBalance, creditBalance, depositInputs, creditInputs])

  const temSaldo = depositBalance > 0 || creditBalance > 0

  // O motivo e o "encerrar com dívida em aberto" falam das dívidas que JÁ
  // existiam; a multa tem cobrança própria e nunca pediu motivo.
  const linhasReais = distribution.lines.filter((l) => l.id !== FINE_DEBT_ID)
  const caucaoEmDividasReais = round2(linhasReais.reduce((sum, l) => sum + l.deposit, 0))
  const creditoEmDividasReais = round2(linhasReais.reduce((sum, l) => sum + l.credit, 0))
  const restanteReal = round2(linhasReais.reduce((sum, l) => sum + l.remaining, 0))

  const restanteTotal = distribution.debt_remaining
  const sobraCaucao = distribution.deposit_remaining
  const sobraCredito = distribution.credit_remaining

  /**
   * Nunca devolve dinheiro por inércia enquanto o cliente ainda deve (ADR 0026:
   * abater vem antes de devolver): com dívida em aberto o operador PRECISA
   * escolher; sem dívida, devolver é o padrão. Crédito é do CLIENTE e sobrevive
   * ao contrato, então deixar é o padrão seguro.
   */
  const depositLeftoverEfetivo: LeftoverChoice | null =
    depositLeftover ?? (restanteTotal > 0 ? null : 'return')
  const creditLeftoverEfetivo: LeftoverChoice = creditLeftover ?? 'keep'

  const caucaoParaDevolver  = depositLeftoverEfetivo === 'return' ? sobraCaucao : 0
  const creditoParaDevolver = creditLeftoverEfetivo === 'return' ? sobraCredito : 0

  const violationMessages = distribution.violations.map((v) => {
    if (v.code === 'LINE_EXCEEDS_DEBT') {
      return `${debtMeta.get(v.id)?.label ?? 'Dívida'}: caução e crédito somam ${formatCurrency(v.excess)} a mais do que ela deve.`
    }
    if (v.code === 'DEPOSIT_EXCEEDS_BALANCE') {
      return `A caução alocada passa do saldo em ${formatCurrency(v.excess)}.`
    }
    return `O crédito alocado passa do saldo em ${formatCurrency(v.excess)}.`
  })

  function setAllocation(kind: 'deposit' | 'credit', debtId: string, value: string) {
    if (kind === 'credit') {
      // O crédito não passa do que cabe: nem do saldo que as OUTRAS linhas ainda
      // deixam, nem do que a dívida ainda deve depois da caução. É o mesmo teto
      // (`max_credit`) que o `max` do input e o botão "Máx." usam — digitar,
      // colar ou usar a setinha dá no mesmo. O servidor recusa de qualquer jeito;
      // aqui o operador simplesmente não consegue montar o valor inválido.
      const teto = distribution.lines.find((l) => l.id === debtId)?.max_credit ?? 0
      setCreditInputs((prev) => ({ ...prev, [debtId]: clampAllocationInput(value, teto) }))
      return
    }
    setDepositInputs((prev) => ({ ...prev, [debtId]: value }))
  }

  function handleConfirm() {
    setError('')

    // `max` no input fecha o seletor, não o teclado — dá para digitar uma data
    // à frente e enviar. A trava precisa existir aqui também, pelo mesmo motivo
    // que a política de encargo recusa vigência retroativa nos dois lugares.
    if (terminationDate > hoje) {
      setError('A data de encerramento não pode ser futura — a locação é encerrada e o veículo liberado no ato. Para registrar uma devolução combinada, encerre no dia.')
      return
    }

    if (kmFinalInvalido || kmFinalNumero === null) {
      setError(`Informe o km final — não pode ser menor que ${pisoKm.toLocaleString('pt-BR')} km.`)
      return
    }

    // RF-004 (Spec 0015): a decisão de cobrar ou não a multa é explícita — sem
    // default, sem silêncio (RN-004: não pode ser desfeita depois de confirmada).
    if (multaAplicavel && multaDecisao === null) {
      setError('Decida se a multa por rescisão antecipada será cobrada.')
      return
    }

    // A RPC recusa tudo isto também, mas depois do clique — e o encerramento é
    // irreversível. Aqui o operador descobre antes.
    if (!distribution.is_valid) {
      setError('A distribuição passa de um limite — corrija os valores destacados na lista de dívidas.')
      return
    }

    // Abater caução exige justificativa (ADR 0026) — `TerminateRentalSchema`
    // recusa com menos de 5 caracteres.
    if (caucaoEmDividasReais > 0 && depositReason.trim().length < 5) {
      setError('Informe o motivo do abatimento da caução — ele explica ao cliente por que o dinheiro dele virou pagamento.')
      return
    }

    if (sobraCaucao > 0 && depositLeftoverEfetivo === null) {
      setError(`Decida o que fazer com a caução que sobrou (${formatCurrency(sobraCaucao)}): o cliente ainda deve ${formatCurrency(restanteTotal)}.`)
      return
    }

    const alloc = buildTerminationAllocations(distribution)

    startTransition(async () => {
      // A distribuição inteira vai NESTA chamada: a RPC a aplica na mesma
      // transação que fecha a locação, e qualquer recusa desfaz tudo — o
      // operador nunca fica com a locação encerrada e o acerto pela metade.
      const result = await terminateRental({
        lease_id:         rental.id,
        termination_date: terminationDate,
        new_status:       newStatus,
        force,
        km_final:         kmFinalNumero,
        charge_fine:          multaEntraNaLista,
        fine_deposit_amount:  alloc.fine_deposit_amount,
        fine_credit_amount:   alloc.fine_credit_amount,
        deposit_allocations:  alloc.deposit_allocations,
        credit_allocations:   alloc.credit_allocations,
        deposit_reason:       caucaoEmDividasReais > 0 ? depositReason.trim() : undefined,
        extra_charge_ids_to_cancel: terminationPlan
          .filter((l) => l.charge_id && l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id))
          .map((l) => l.charge_id!),
        extra_schedule_line_ids_to_cancel: terminationPlan
          .filter((l) => !l.charge_id && l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id))
          .map((l) => l.schedule_line_id),
      })
      if (!result.ok) { setError(result.error.message); return }

      // O que sobrou. Daqui em diante a locação JÁ está encerrada: uma falha vira
      // aviso, não desfaz nada (tolerância herdada — PRD 0017). O menor entre o
      // que o operador viu e o que o razão diz que resta: nunca devolve mais do
      // que foi confirmado na tela.
      const devolverCaucao = round2(Math.min(caucaoParaDevolver, result.data.deposit_remaining))
      if (devolverCaucao > 0) {
        const dep = await returnRemainingDeposit({
          rental_id:   rental.id,
          amount:      devolverCaucao,
          return_date: terminationDate,
        })
        if (!dep.ok) { setError(`Locação encerrada, mas a caução não foi devolvida: ${dep.error.message}`); return }
      }

      const devolverCredito = round2(Math.min(creditoParaDevolver, result.data.credit_remaining))
      if (devolverCredito > 0) {
        const dev = await settleCustomerCredit({
          customer_id: rental.customer_id,
          amount:      devolverCredito,
          notes:       `Devolução no encerramento da locação ${rental.vehicle?.license_plate ?? ''}`.trim(),
        })
        if (!dev.ok) { setError(`Locação encerrada, mas o crédito não foi devolvido: ${dev.error.message}`); return }
      }

      router.push('/locacoes')
    })
  }

  return (
    <div className="min-h-screen bg-bg">

      {/* Header */}
      <div className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-bg px-6 backdrop-blur">
        <Link href={`/locacoes/${rental.id}`} className="text-[13px] text-fg-mute transition-colors hover:text-fg">
          ← {rental.vehicle?.license_plate ?? 'Locação'}
        </Link>
        <span className="text-fg-mute">/</span>
        <h1 className="flex-1 text-[15px] font-bold text-fg">Encerrar locação</h1>
        <Link
          href={`/locacoes/${rental.id}`}
          className="inline-flex h-8 items-center rounded-full border border-border px-4 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
        >
          Cancelar
        </Link>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isPending || !terminationDate || kmFinalInvalido || (openAmount > 0 && !force) || (multaAplicavel && multaDecisao === null) || !distribution.is_valid}
          className="inline-flex h-8 items-center rounded-full bg-danger-bg px-5 text-[13px] font-bold text-danger transition-opacity hover:opacity-80 disabled:opacity-60"
        >
          {isPending ? 'Encerrando…' : 'Confirmar Encerramento'}
        </button>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8">

        {/* Identificação — o que está sendo encerrado, antes de qualquer decisão.
            Era um bloco cinza de três linhas soltas, com o mesmo peso visual do
            resto da tela. */}
        <div className="mb-6 flex items-start gap-4 rounded-xl border border-divider bg-surface p-5">
          <div className="rounded-full border border-divider bg-surface-2 p-3">
            <Bike className="h-5 w-5 text-fg-mute" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold text-fg">
              {rental.vehicle?.license_plate}
              <span className="ml-2 font-normal text-fg-mute">
                {rental.vehicle?.make} {rental.vehicle?.model}
              </span>
            </p>
            <p className="mt-1 text-[13px] text-fg-soft">{rental.customer?.name}</p>
            <p className="mt-0.5 text-[12px] text-fg-mute">
              {rental.start_date ? formatDate(rental.start_date) : '—'} até {rental.end_date ? formatDate(rental.end_date) : '—'}
            </p>
          </div>
        </div>

        {/* Decisões à esquerda, consequências à direita. O operador lê o efeito
            do que escolheu sem rolar a tela — antes, apuração e alertas ficavam
            abaixo dos controles, numa coluna única de 576px. */}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">

          <div className="space-y-6">

            <section>
              <h2 className="mb-3 text-[14px] font-bold text-primary">Data de encerramento</h2>
              <div className="rounded-xl border border-divider bg-surface p-4">
                <input
                  type="date"
                  value={terminationDate}
                  max={hoje}
                  onChange={e => handleTerminationDateChange(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg outline-none transition-all focus:border-primary"
                />
                <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                  Use uma data passada se a devolução foi antes do registro. Data futura não é
                  aceita: a locação encerra e o veículo é liberado no ato.
                </p>
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-[14px] font-bold text-primary">Km final</h2>
              <div className="rounded-xl border border-divider bg-surface p-4">
                <input
                  type="number"
                  min={pisoKm}
                  step="1"
                  placeholder={`Mínimo ${pisoKm.toLocaleString('pt-BR')}`}
                  value={kmFinal}
                  onChange={e => setKmFinal(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg outline-none transition-all focus:border-primary"
                />
                <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                  Km do veículo na devolução. Não pode ser menor que{' '}
                  <strong className="font-medium text-fg-soft">{pisoKm.toLocaleString('pt-BR')} km</strong>
                  {' '}(o maior entre o km atual do veículo e o km registrado na entrega desta locação).
                </p>
                {kmFinal !== '' && kmFinalInvalido && (
                  <p className="mt-1 text-[12px] text-danger">
                    Km não pode ser menor que {pisoKm.toLocaleString('pt-BR')}.
                  </p>
                )}
              </div>
            </section>

            {/* Spec 0016 (revisão): TODA linha viva do cronograma — vencida,
                emitida ou planejada —, dividida entre o que fica fora do
                período (sempre cancelada, sem escolha) e o que fica dentro
                dele (mantida por padrão, com opção de cancelar mesmo assim). */}
            {outsidePeriod.length > 0 && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Fora do período — serão canceladas</h2>
                <div className="overflow-hidden rounded-xl border border-divider bg-surface">
                  {outsideVisiveis.map((l) => (
                    <div
                      key={l.schedule_line_id}
                      className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 text-[13px] last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-fg">
                            {l.is_issued ? `Cobrança #${l.charge_number}` : 'Parcela ainda não emitida'}
                            {l.is_overdue && (
                              <span className="ml-2 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-danger">
                                atrasada
                              </span>
                            )}
                          </span>
                          <span className="tabular-nums text-fg">{formatCurrency(l.total_amount)}</span>
                        </div>
                        <p className="mt-0.5 text-[12px] text-fg-mute">
                          Período {formatDate(l.period_start)} a {formatDate(l.period_end)}
                        </p>
                        {l.action === 'blocked' ? (
                          <p className="mt-1 text-[12px] text-warning">
                            Já paga ou com crédito aplicado ({formatCurrency(l.paid_amount)}) — não pode ser
                            cancelada por aqui.
                          </p>
                        ) : (
                          <p className="mt-1 text-[12px] text-danger">Será cancelada.</p>
                        )}
                      </div>
                    </div>
                  ))}

                  {outsideResumida && (
                    <button
                      type="button"
                      onClick={() => setShowAllOutside((v) => !v)}
                      aria-expanded={showAllOutside}
                      className="flex h-9 w-full items-center justify-center border-t border-divider text-[13px] font-medium text-primary transition-colors hover:bg-surface-2"
                    >
                      {showAllOutside ? 'Exibir menos' : `Exibir mais ${outsideEscondidas} cobranças`}
                    </button>
                  )}
                </div>
              </section>
            )}

            {insidePeriod.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-[14px] font-bold text-primary">Dentro do período</h2>
                  {optionalLineIds.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleMarkAllOptional}
                      className="text-[12px] font-medium text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      {allOptionalMarked ? 'Manter todas' : 'Cancelar todas mesmo assim'}
                    </button>
                  )}
                </div>
                <div className="overflow-hidden rounded-xl border border-divider bg-surface">
                  {insidePeriod.map((l) => {
                    const marcada = extraSelected.has(l.schedule_line_id)
                    return (
                      <div
                        key={l.schedule_line_id}
                        className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 text-[13px] last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="font-medium text-fg">
                              {l.is_issued ? `Cobrança #${l.charge_number}` : 'Parcela ainda não emitida'}
                              {l.is_overdue && (
                                <span className="ml-2 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-danger">
                                  atrasada
                                </span>
                              )}
                            </span>
                            <span className="tabular-nums text-fg">{formatCurrency(l.total_amount)}</span>
                          </div>
                          <p className="mt-0.5 text-[12px] text-fg-mute">
                            Período {formatDate(l.period_start)} a {formatDate(l.period_end)}
                          </p>
                        </div>
                        <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
                          <button
                            type="button"
                            onClick={() => setLineDecision(l.schedule_line_id, 'keep')}
                            className={`h-8 px-3 text-[12px] font-medium transition-colors ${
                              !marcada ? 'bg-surface-2 text-fg' : 'text-fg-mute hover:bg-surface-2'
                            }`}
                          >
                            Manter
                          </button>
                          <button
                            type="button"
                            onClick={() => setLineDecision(l.schedule_line_id, 'cancel')}
                            className={`h-8 px-3 text-[12px] font-medium transition-colors ${
                              marcada ? 'bg-danger-bg text-danger' : 'text-fg-mute hover:bg-surface-2'
                            }`}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {multaAplicavel && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Multa por rescisão antecipada</h2>
                <div className="rounded-xl border border-divider bg-surface p-4">
                  <p className="text-[12px] leading-relaxed text-fg-mute">
                    Esta locação está dentro do prazo mínimo configurado — multa de{' '}
                    <strong className="font-medium text-fg-soft">{formatCurrency(multaValor)}</strong> aplicável.
                  </p>

                  <div className="mt-3 flex flex-col gap-1">
                    <label
                      className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                        multaDecisao === 'charge' ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                      }`}
                    >
                      <input
                        type="radio"
                        name="multa_decisao"
                        checked={multaDecisao === 'charge'}
                        onChange={() => setMultaDecisao('charge')}
                        className="accent-primary"
                      />
                      Cobrar a multa
                    </label>
                    <label
                      className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                        multaDecisao === 'skip' ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                      }`}
                    >
                      <input
                        type="radio"
                        name="multa_decisao"
                        checked={multaDecisao === 'skip'}
                        onChange={() => setMultaDecisao('skip')}
                        className="accent-primary"
                      />
                      Não cobrar a multa
                    </label>
                  </div>

                  {/* RN-007: a multa não tem mais um fluxo de abatimento só dela —
                      quanto de caução e crédito ela recebe se decide na lista de
                      dívidas, como em qualquer outra. */}
                  {multaDecisao === 'charge' && (
                    <p className="mt-3 border-t border-divider pt-3 text-[12px] leading-relaxed text-fg-mute">
                      {temSaldo
                        ? 'A multa entra na lista de dívidas abaixo, com as demais — é lá que você decide quanto de caução e crédito aplicar nela. O que não for alocado vira cobrança em aberto.'
                        : 'A multa vira uma cobrança em aberto do cliente.'}
                    </p>
                  )}
                </div>
              </section>
            )}

            {temSaldo && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Distribuição de caução e crédito</h2>
                <div className="overflow-hidden rounded-xl border border-divider bg-surface">
                  <p className="border-b border-divider px-4 py-3 text-[12px] leading-relaxed text-fg-mute">
                    O dinheiro do cliente quita a dívida que você escolher, valor a valor. Nada é aplicado
                    antes de <strong className="font-medium text-fg-soft">Confirmar Encerramento</strong> — e o que
                    você não distribuir aqui continua em aberto.
                  </p>

                  {debts.length === 0 ? (
                    <div className="px-4 py-3 text-[13px] leading-relaxed text-fg-mute">
                      Não há dívida em aberto para receber caução ou crédito.
                      {depositBalance > 0 && (
                        <>
                          {' '}Para reter por avaria ou diária em aberto, lance a despesa em{' '}
                          <Link href="/despesas" className="underline underline-offset-2">Despesas</Link>{' '}
                          com rateio ao cliente: isso emite a cobrança, e aí há o que distribuir.
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="h-9 border-b border-divider text-left text-fg-mute">
                          <th className="px-4 font-medium">Dívida</th>
                          <th className="px-2 text-right font-medium">Devido</th>
                          {depositBalance > 0 && <th className="px-2 text-right font-medium">Caução</th>}
                          {creditBalance > 0 && <th className="px-2 text-right font-medium">Crédito</th>}
                          <th className="px-4 text-right font-medium">Resta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {distribution.lines.map((line) => {
                          const meta = debtMeta.get(line.id)
                          const label = meta?.label ?? 'Dívida'
                          return (
                            <tr key={line.id} className="h-9 border-b border-divider last:border-0">
                              {/* Uma linha só (h-9): o vencimento fica no `title` — quem precisa
                                  da data por dívida a tem na ficha da cobrança, e "atrasada" já
                                  diz o que importa para decidir onde aplicar o dinheiro. */}
                              <td
                                className="whitespace-nowrap px-4 text-fg"
                                title={`${label} · ${meta?.origin ?? ''}${meta?.dueDate ? ` · vence ${formatDate(meta.dueDate)}` : ''}`}
                              >
                                <span className="font-medium">{label}</span>
                                <span className="ml-1.5 text-fg-mute">· {meta?.origin}</span>
                                {meta?.overdue && (
                                  <span className="ml-1.5 text-[12px] font-medium text-danger">atrasada</span>
                                )}
                              </td>
                              <td className="px-2 text-right tabular-nums text-fg">{formatCurrency(line.amount_due)}</td>
                              {depositBalance > 0 && (
                                <td className="px-2 text-right">
                                  <input
                                    id={`caucao-${line.id}`}
                                    type="number"
                                    inputMode="decimal"
                                    step="0.01"
                                    min="0"
                                    max={line.max_deposit}
                                    aria-label={`Caução em ${label}`}
                                    value={depositInputs[line.id] ?? ''}
                                    onChange={(e) => setAllocation('deposit', line.id, e.target.value)}
                                    placeholder="0,00"
                                    className="h-7 w-24 rounded-lg border border-border bg-bg px-2 text-right text-[13px] tabular-nums text-fg outline-none focus:border-primary"
                                  />
                                </td>
                              )}
                              {creditBalance > 0 && (
                                <td className="px-2">
                                  <div className="flex items-center justify-end gap-1">
                                    {/* Atalho: aplica nesta dívida o máximo de crédito que cabe
                                        nela agora — o menor entre o que ela ainda deve depois
                                        da caução e o saldo que as outras linhas deixaram. É
                                        ação do operador numa linha, não sugestão automática. */}
                                    <button
                                      type="button"
                                      id={`credito-max-${line.id}`}
                                      onClick={() => setAllocation('credit', line.id, formatAllocationInput(line.max_credit))}
                                      disabled={line.max_credit <= 0 || line.credit >= line.max_credit}
                                      title={line.max_credit > 0
                                        ? `Aplicar ${formatCurrency(line.max_credit)} de crédito em ${label}`
                                        : 'Não há crédito ou dívida disponível nesta linha'}
                                      aria-label={`Aplicar o máximo de crédito em ${label}`}
                                      className="h-7 shrink-0 rounded-lg border border-border px-2 text-[12px] font-medium text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-fg-mute disabled:opacity-50 disabled:hover:bg-transparent"
                                    >
                                      Máx.
                                    </button>
                                    <input
                                      id={`credito-${line.id}`}
                                      type="number"
                                      inputMode="decimal"
                                      step="0.01"
                                      min="0"
                                      max={line.max_credit}
                                      aria-label={`Crédito em ${label}`}
                                      value={creditInputs[line.id] ?? ''}
                                      onChange={(e) => setAllocation('credit', line.id, e.target.value)}
                                      placeholder="0,00"
                                      className="h-7 w-24 rounded-lg border border-border bg-bg px-2 text-right text-[13px] tabular-nums text-fg outline-none focus:border-primary"
                                    />
                                  </div>
                                </td>
                              )}
                              <td className={`px-4 text-right tabular-nums ${line.remaining > 0 ? 'text-fg' : 'text-success'}`}>
                                {formatCurrency(line.remaining)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    </div>
                  )}

                  {/* RF-002: quanto de cada saldo já foi alocado e quanto ainda resta. */}
                  <div className="border-t border-divider">
                    {depositBalance > 0 && (
                      <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]">
                        <span className="text-fg-mute">Caução</span>
                        <span className="tabular-nums text-fg">
                          {formatCurrency(distribution.deposit_allocated)} de {formatCurrency(depositBalance)} alocados
                          {' · '}resta <strong className="font-semibold">{formatCurrency(sobraCaucao)}</strong>
                        </span>
                      </div>
                    )}
                    {creditBalance > 0 && (
                      <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]">
                        <span className="text-fg-mute">Crédito</span>
                        <span className="tabular-nums text-fg">
                          {formatCurrency(distribution.credit_allocated)} de {formatCurrency(creditBalance)} alocados
                          {' · '}resta <strong className="font-semibold">{formatCurrency(sobraCredito)}</strong>
                        </span>
                      </div>
                    )}
                  </div>

                  {violationMessages.length > 0 && (
                    <ul role="alert" className="space-y-1 border-t border-danger bg-danger-bg px-4 py-2.5 text-[12px] text-danger">
                      {violationMessages.map((m) => <li key={m}>{m}</li>)}
                    </ul>
                  )}

                  {caucaoEmDividasReais > 0 && (
                    <div className="border-t border-divider px-4 py-3">
                      <label className="text-[12px] text-fg-mute" htmlFor="motivo">Motivo do abatimento da caução</label>
                      <input
                        id="motivo"
                        value={depositReason}
                        onChange={(e) => setDepositReason(e.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-primary"
                        placeholder="Avaria no para-choque, diária em aberto…"
                      />
                      <p className="mt-1.5 text-[12px] text-fg-mute">
                        Um motivo para toda a caução distribuída acima — ele explica ao cliente por que o dinheiro dele virou pagamento.
                      </p>
                    </div>
                  )}

                  {/* RF-008: o que sobrou da caução. Reter já aconteceu, dívida a dívida,
                      na lista acima — aqui só resta devolver ou deixar. */}
                  {sobraCaucao > 0 && (
                    <div className="border-t border-divider px-4 py-3">
                      <p className="text-[13px] font-medium text-fg">
                        Sobra de caução: <span className="tabular-nums">{formatCurrency(sobraCaucao)}</span>
                      </p>
                      <div className="mt-2 flex flex-col gap-1">
                        {([
                          ['return', `Devolver ${formatCurrency(sobraCaucao)} ao cliente`],
                          ['keep', 'Deixar em custódia (não devolver agora)'],
                        ] as [LeftoverChoice, string][]).map(([valor, rotulo]) => (
                          <label
                            key={valor}
                            className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                              depositLeftoverEfetivo === valor ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                            }`}
                          >
                            <input
                              type="radio"
                              name="deposit_leftover"
                              value={valor}
                              checked={depositLeftoverEfetivo === valor}
                              onChange={() => setDepositLeftover(valor)}
                              className="accent-primary"
                            />
                            {rotulo}
                          </label>
                        ))}
                      </div>
                      {depositLeftoverEfetivo === null && (
                        <p className="mt-2 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] leading-relaxed text-warning">
                          O cliente ainda deve {formatCurrency(restanteTotal)}. Distribua a caução nas dívidas acima,
                          ou decida aqui o que fazer com a sobra.
                        </p>
                      )}
                      {depositLeftoverEfetivo === 'return' && restanteTotal > 0 && (
                        <p className="mt-2 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] leading-relaxed text-warning">
                          Você vai devolver {formatCurrency(sobraCaucao)} a um cliente que ainda deve{' '}
                          {formatCurrency(restanteTotal)}. É escolha válida — só raramente é a intenção.
                        </p>
                      )}
                      {depositLeftoverEfetivo === 'keep' && (
                        <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                          O saldo continua registrado como passivo da locação encerrada.
                        </p>
                      )}
                    </div>
                  )}

                  {/* RF-009: o que sobrou do crédito. Diferente da caução, o crédito é
                      do CLIENTE e sobrevive ao contrato — deixar é o padrão. */}
                  {sobraCredito > 0 && (
                    <div className="border-t border-divider px-4 py-3">
                      <p className="text-[13px] font-medium text-fg">
                        Sobra de crédito: <span className="tabular-nums">{formatCurrency(sobraCredito)}</span>
                      </p>
                      <div className="mt-2 flex flex-col gap-1">
                        {([
                          ['keep', 'Deixar como crédito do cliente'],
                          ['return', `Devolver ${formatCurrency(sobraCredito)} em dinheiro`],
                        ] as [LeftoverChoice, string][]).map(([valor, rotulo]) => (
                          <label
                            key={valor}
                            className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                              creditLeftoverEfetivo === valor ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                            }`}
                          >
                            <input
                              type="radio"
                              name="credit_leftover"
                              value={valor}
                              checked={creditLeftoverEfetivo === valor}
                              onChange={() => setCreditLeftover(valor)}
                              className="accent-primary"
                            />
                            {rotulo}
                          </label>
                        ))}
                      </div>
                      {creditLeftoverEfetivo === 'keep' && restanteTotal > 0 && (
                        <p className="mt-2 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] leading-relaxed text-warning">
                          O cliente fica devendo {formatCurrency(restanteTotal)} e credor de{' '}
                          {formatCurrency(sobraCredito)} ao mesmo tempo. É escolha válida — só raramente é a intenção.
                        </p>
                      )}
                      {creditLeftoverEfetivo === 'keep' && restanteTotal === 0 && (
                        <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                          Sem dívida a abater, o crédito fica no saldo do cliente. Se ele não tem outra
                          locação, considere devolver — ou ele vai embora credor.{' '}
                          <Link href={`/clientes/${rental.customer_id}`} className="underline underline-offset-2">
                            Ficha do cliente
                          </Link>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {openAmount > 0 && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Confirmação</h2>
                {/* Consentimento, não alerta: o operador está autorizando encerrar
                    com dívida em aberto, e isso é uma DECISÃO dele — por isso o
                    bloco tem a mesma forma dos outros controles, e não a de um
                    aviso que se lê e ignora. */}
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-danger bg-danger-bg p-4 text-[13px] text-danger">
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={e => setForce(e.target.checked)}
                    className="mt-0.5 accent-current"
                  />
                  <span className="leading-relaxed">
                    Encerrar mesmo com <strong>{formatCurrency(openAmount)}</strong> em aberto.
                    {/* O restante tem de ser o MESMO do bloco Acerto final. Na fase 1
                        esta frase só descontava a caução; quando o crédito passou a
                        abater, a tela ficou com dois números para a mesma coisa —
                        R$ 300 aqui, R$ 50 ao lado. */}
                    {(caucaoEmDividasReais > 0 || creditoEmDividasReais > 0) && (
                      <> Depois do acerto desta tela ficam <strong>{formatCurrency(restanteReal)}</strong>.</>
                    )}
                    {' '}As cobranças continuam cobráveis após o encerramento.
                  </span>
                </label>
              </section>
            )}

          </div>

          {/* Apuração + consequências */}
          <div className="space-y-6 lg:sticky lg:top-20">

            <section>
              <h2 className="mb-3 text-[14px] font-bold text-primary">Apuração financeira</h2>
              <div className="overflow-hidden rounded-xl border border-divider bg-surface">

                {/* O `div` por linha carrega rótulo E valor: é assim que o E2E
                    lê "Cobranças em aberto" com o total, e é assim que a linha
                    continua legível quando a abertura aparece embaixo. */}
                <div className="border-b border-divider px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-fg-mute">Cobranças em aberto</span>
                    <span className={`text-[13px] font-semibold tabular-nums ${openAmount > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                      {formatCurrency(openAmount)}
                    </span>
                  </div>
                  {openCharges.length > 0 && (
                    <p className="mt-1 text-[12px] text-fg-mute">
                      {[
                        emAberto.vencidas.count > 0
                          && `${emAberto.vencidas.count} vencida${emAberto.vencidas.count !== 1 ? 's' : ''} ${formatCurrency(emAberto.vencidas.total)}`,
                        emAberto.aVencer.count > 0
                          && `${emAberto.aVencer.count} a vencer ${formatCurrency(emAberto.aVencer.total)}`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>

                <div className="border-b border-divider px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-fg-mute">Saldo de caução</span>
                    <span className={`text-[13px] font-semibold tabular-nums ${depositBalance > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                      {formatCurrency(depositBalance)}
                    </span>
                  </div>
                  {/* Sem saldo, a seção "Destino da caução" não aparece — e o
                      operador que veio decidir o destino ficava procurando um
                      bloco que a tela não tinha razão para mostrar, sem nada
                      dizendo por quê. */}
                  <p className="mt-1 text-[12px] text-fg-mute">
                    {depositBalance > 0
                      ? 'decida o destino ao lado antes de encerrar'
                      : 'sem caução nesta locação — nada a devolver ou reter'}
                  </p>
                </div>

                <div className="flex items-baseline justify-between gap-3 border-b border-divider px-4 py-3">
                  <span className="text-[13px] text-fg-mute">Crédito do cliente</span>
                  <span className={`text-[13px] font-semibold tabular-nums ${creditBalance > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                    {formatCurrency(creditBalance)}
                  </span>
                </div>

                <div className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-fg-mute">Parcelas ainda não emitidas a cancelar</span>
                    <span className={`text-[13px] font-semibold tabular-nums ${willCancel.planejadas.total > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                      {formatCurrency(willCancel.planejadas.total)}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-fg-mute">
                    {willCancel.planejadas.count > 0
                      ? `${willCancel.planejadas.count} parcela${willCancel.planejadas.count !== 1 ? 's' : ''}`
                      : 'nenhuma'}
                  </p>
                </div>

                <div className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] text-fg-mute">Cobranças já emitidas a cancelar</span>
                    <span className={`text-[13px] font-semibold tabular-nums ${willCancel.emitidas.total > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                      {formatCurrency(willCancel.emitidas.total)}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-fg-mute">
                    {willCancel.emitidas.count > 0
                      ? `${willCancel.emitidas.count} cobrança${willCancel.emitidas.count !== 1 ? 's' : ''}`
                      : 'nenhuma'}
                  </p>
                </div>
              </div>
            </section>

            {/* O ACERTO — ADR 0026. A apuração acima diz o que existe; este bloco
                diz no que isso resulta, com a distribuição que o operador montou.
                Sem ele, "encerrar mesmo com R$ 1.200,00 em aberto" era o único
                número da tela, de um cliente cujo dinheiro a empresa está segurando. */}
            {debts.length > 0 && temSaldo && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Acerto final</h2>
                <div className="overflow-hidden rounded-xl border border-divider bg-surface">

                  <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                    <span className="text-[13px] text-fg-mute">Dívida do cliente</span>
                    <span className="text-[13px] tabular-nums text-fg">{formatCurrency(distribution.debt_total)}</span>
                  </div>

                  {depositBalance > 0 && (
                    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                      <span className="text-[13px] text-fg-mute">Caução abatida</span>
                      <span className={`text-[13px] tabular-nums ${distribution.deposit_allocated > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                        − {formatCurrency(distribution.deposit_allocated)}
                      </span>
                    </div>
                  )}

                  {creditBalance > 0 && (
                    <div className="flex items-baseline justify-between gap-3 border-t border-divider px-4 py-2.5">
                      <span className="text-[13px] text-fg-mute">Crédito abatido</span>
                      <span className={`text-[13px] tabular-nums ${distribution.credit_allocated > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                        − {formatCurrency(distribution.credit_allocated)}
                      </span>
                    </div>
                  )}

                  <div className="flex items-baseline justify-between gap-3 border-t border-divider bg-surface-2 px-4 py-2.5">
                    <span className="text-[13px] font-medium text-fg">Restante a receber</span>
                    <span className={`text-[13px] font-bold tabular-nums ${restanteTotal > 0 ? 'text-fg' : 'text-success'}`}>
                      {formatCurrency(restanteTotal)}
                    </span>
                  </div>

                  {/* Devolução é a única linha que tira dinheiro do caixa — e o
                      encerramento pode fazer as duas de uma vez. */}
                  {(caucaoParaDevolver > 0 || creditoParaDevolver > 0) && (
                    <div className="border-t border-divider px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[13px] text-fg-mute">Sai do caixa</span>
                        <span className="text-[13px] font-semibold tabular-nums text-danger">
                          {formatCurrency(round2(caucaoParaDevolver + creditoParaDevolver))}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] text-fg-mute">
                        {[
                          caucaoParaDevolver > 0 && `caução ${formatCurrency(caucaoParaDevolver)}`,
                          creditoParaDevolver > 0 && `crédito ${formatCurrency(creditoParaDevolver)}`,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Uma lista de consequências no lugar de quatro caixas coloridas
                empilhadas. O muro de avisos dava o mesmo peso a tudo e repetia
                números que a apuração já mostra; aqui a cor fica no ícone e cada
                linha diz uma coisa que só ela diz. */}
            <section>
              <h2 className="mb-3 text-[14px] font-bold text-primary">Ao confirmar</h2>
              <ul className="divide-y divide-divider overflow-hidden rounded-xl border border-divider bg-surface">

                <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-fg-soft">
                  <Bike className="mt-0.5 h-4 w-4 shrink-0 text-fg-mute" />
                  <span>
                    A moto <strong className="font-semibold text-fg">{rental.vehicle?.license_plate}</strong>{' '}
                    volta para <strong className="font-semibold text-fg">disponível</strong>.
                  </span>
                </li>

                {willCancel.planejadas.count > 0 && (
                  <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-fg-soft">
                    <CalendarX2 className="mt-0.5 h-4 w-4 shrink-0 text-fg-mute" />
                    <span>
                      {willCancel.planejadas.count} parcela{willCancel.planejadas.count !== 1 ? 's' : ''} ainda não emitida
                      {willCancel.planejadas.count !== 1 ? 's' : ''} ser{willCancel.planejadas.count !== 1 ? 'ão' : 'á'} cancelada
                      {willCancel.planejadas.count !== 1 ? 's' : ''}.
                    </span>
                  </li>
                )}

                {willCancel.emitidas.count > 0 && (
                  <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-danger">
                    <ReceiptText className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {willCancel.emitidas.count} cobrança{willCancel.emitidas.count !== 1 ? 's' : ''} já emitida
                      {willCancel.emitidas.count !== 1 ? 's' : ''} ser{willCancel.emitidas.count !== 1 ? 'ão' : 'á'} cancelada
                      {willCancel.emitidas.count !== 1 ? 's' : ''} — o cliente deixa de dever esse período.
                    </span>
                  </li>
                )}

                {openCharges.length > 0 && (
                  <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-fg-soft">
                    <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span>
                      {openCharges.length} cobrança{openCharges.length !== 1 ? 's' : ''} já emitida
                      {openCharges.length !== 1 ? 's' : ''} continua{openCharges.length !== 1 ? 'm' : ''}{' '}
                      {openCharges.length !== 1 ? 'cobráveis' : 'cobrável'}.
                    </span>
                  </li>
                )}

                {multaAplicavel && (
                  <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-warning">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Rescisão dentro do prazo mínimo configurado — multa de{' '}
                      <strong>
                        {formatCurrency(multaValor)}{' '}
                        {multaDecisao === 'charge'
                          ? 'será cobrada'
                          : multaDecisao === 'skip'
                            ? 'não será cobrada'
                            : 'aplicável — decida ao lado'}
                      </strong>.
                    </span>
                  </li>
                )}

                {newStatus === 'transferred' && (
                  <li className="flex items-start gap-3 px-4 py-3 text-[13px] text-info">
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Compra Programada cumprida — o contrato passa a <strong>Transferida</strong>.</span>
                  </li>
                )}
              </ul>
            </section>

          </div>
        </div>

        {error && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-danger bg-danger-bg p-4 text-[13px] text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}
