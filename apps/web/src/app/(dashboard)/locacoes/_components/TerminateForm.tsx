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
} from '@gomoto/core'
import type { Rental } from '@gomoto/core'
import { formatCurrency, formatDate } from '@/lib/utils'
import { terminateRental, closeRentalFinancial, applyCreditToRentalDebt } from '../actions'
import { settleCustomerCredit } from '../../clientes/[id]/actions'

interface TerminateFormProps {
  rental: Rental
}

type CreditAction  = 'keep' | 'apply' | 'apply_and_settle' | 'settle'
type DepositAction = 'full_return' | 'partial_return' | 'full_retention'

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

  function handleTerminationDateChange(value: string) {
    setTerminationDate(value)
    setExtraSelected(new Set())
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
  // Destino da caução. A locação encerra e o dinheiro do cliente precisa ir a
  // algum lugar — sem isto o passivo fica em aberto para sempre, sem caminho
  // no produto para devolver nem para reter.
  /**
   * `null` = ainda não escolhido; o default sai dos saldos (ADR 0026: abater vem
   * antes de devolver). Derivado pelo mesmo motivo do crédito — os saldos vêm de
   * hook e chegam depois do primeiro render, então um estado inicializado no
   * mount travaria em "devolver" e o default nunca apareceria.
   */
  const [depositEscolhido, setDepositAction] = useState<DepositAction | null>(null)
  const [retainedAmount, setRetainedAmount] = useState('')
  const [retentionReason, setRetentionReason] = useState('')

  /**
   * Destino do crédito (ADR 0026, fase 2). Mesma forma da caução: quanto abater
   * e o que fazer com a sobra.
   *
   * `keep` é o default seguro e continua sendo a decisão certa em boa parte dos
   * casos — crédito é do CLIENTE e sobrevive ao contrato. O que muda é ele
   * deixar de ser a única saída: antes a tela só informava e mandava o operador
   * para outra tela, onde o abatimento nem existia.
   */
  const [creditEscolhido, setCreditAction] = useState<CreditAction | null>(null)

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
  const [multaCaucaoAmount, setMultaCaucaoAmount] = useState('')
  const [multaCreditoAmount, setMultaCreditoAmount] = useState('')

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
   * Reter só existe contra dívida (ADR 0026, fase 3): sem dívida a caução é
   * devolvida, e a opção de abater nem é oferecida. Quem precisa reter por
   * avaria lança a despesa com rateio, que emite a cobrança.
   */
  const podeAbaterCaucao = openAmount > 0
  const depositAction: DepositAction =
    depositEscolhido && (podeAbaterCaucao || depositEscolhido === 'full_return')
      ? depositEscolhido
      : podeAbaterCaucao ? 'full_retention' : 'full_return'

  /**
   * O ACERTO, na ordem que a ADR 0026 fixou: abater vem antes de devolver.
   *
   * Fase 1 é só leitura — nenhuma escrita mudou aqui. O que muda é a tela parar
   * de pedir "encerrar mesmo com R$ 1.200,00 em aberto" de um cliente cujo
   * dinheiro a empresa está segurando: a conta que importa é quanto sobra
   * DEPOIS de usar o que já está em custódia, e ela era feita de cabeça.
   *
   * Duas quantias, dois status diferentes nesta fase:
   *  - caução: esta tela já abate, quando o operador escolhe abater;
   *  - crédito: ainda não — hoje se abate cobrança por cobrança. Por isso ele
   *    aparece como "disponível", não como já descontado. Prometer abatimento
   *    que a tela não faz seria pior que não mostrar.
   */
  const caucaoParaAbater = useMemo(() => {
    if (depositAction === 'full_return') return 0
    const escolhido = depositAction === 'full_retention'
      ? depositBalance
      : Math.round((Number(retainedAmount.replace(',', '.')) || 0) * 100) / 100
    // O que EXCEDE a dívida não vira abatimento: não há cobrança para alocar.
    return Math.max(0, Math.min(escolhido, openAmount))
  }, [depositAction, retainedAmount, depositBalance, openAmount])

  const emAbertoDepoisDaCaucao = Math.round(Math.max(0, openAmount - caucaoParaAbater) * 100) / 100

  /** Quanto da caução sai do caixa como devolução, conforme a escolha. */
  const caucaoParaDevolver = useMemo(() => {
    if (depositAction === 'full_return') return depositBalance
    if (depositAction === 'full_retention') return 0
    const retido = Math.round((Number(retainedAmount.replace(',', '.')) || 0) * 100) / 100
    return Math.round(Math.max(0, depositBalance - retido) * 100) / 100
  }, [depositAction, retainedAmount, depositBalance])
  const creditoAbativel       = Math.min(creditBalance, emAbertoDepoisDaCaucao)
  const sobraDoCredito        = Math.round(Math.max(0, creditBalance - creditoAbativel) * 100) / 100

  /**
   * Default: havendo dívida, abater (ADR 0026 — abater vem antes de devolver).
   *
   * Derivado, não em `useState`: os saldos vêm de hooks e chegam depois do
   * primeiro render. Um estado inicializado no mount travaria em "deixar" e o
   * default nunca apareceria. `null` significa "o operador ainda não escolheu".
   */
  const creditAction: CreditAction = creditEscolhido ?? (creditoAbativel > 0 ? 'apply' : 'keep')

  /** Quanto o crédito abate de fato, conforme a escolha. */
  const creditoParaAbater = creditAction === 'apply' || creditAction === 'apply_and_settle'
    ? creditoAbativel
    : 0

  /** Quanto sai do caixa como devolução de crédito. */
  const creditoParaDevolver =
    creditAction === 'settle'           ? creditBalance :
    creditAction === 'apply_and_settle' ? sobraDoCredito : 0

  const emAbertoFinal = Math.round(Math.max(0, emAbertoDepoisDaCaucao - creditoParaAbater) * 100) / 100

  /**
   * Destino da multa (Spec 0015, RF-006/RN-005/RN-006) — decisão PRÓPRIA,
   * independente da dívida existente acima, mas compartilhando o mesmo saldo
   * físico de caução/crédito: o que sobrou depois do que já foi destinado à
   * dívida é o que fica disponível para a multa (a RPC confirma os dois
   * abatimentos na mesma transação do encerramento; o que a dívida já
   * reservou não pode ser contado de novo aqui).
   */
  const caucaoDisponivelParaMulta  = Math.max(0, Math.round((depositBalance - caucaoParaAbater) * 100) / 100)
  const creditoDisponivelParaMulta = Math.max(0, Math.round((creditBalance - creditoParaAbater) * 100) / 100)

  const multaCaucaoParaAbater = multaDecisao === 'charge'
    ? Math.max(0, Math.min(
        Math.round((Number(multaCaucaoAmount.replace(',', '.')) || 0) * 100) / 100,
        caucaoDisponivelParaMulta,
        multaValor,
      ))
    : 0
  const multaCreditoParaAbater = multaDecisao === 'charge'
    ? Math.max(0, Math.min(
        Math.round((Number(multaCreditoAmount.replace(',', '.')) || 0) * 100) / 100,
        creditoDisponivelParaMulta,
        Math.round((multaValor - multaCaucaoParaAbater) * 100) / 100,
      ))
    : 0
  const multaEmAberto = Math.round(Math.max(0, multaValor - multaCaucaoParaAbater - multaCreditoParaAbater) * 100) / 100

  function handleConfirm() {
    setError('')

    // `max` no input fecha o seletor, não o teclado — dá para digitar uma data
    // à frente e enviar. A trava precisa existir aqui também, pelo mesmo motivo
    // que a política de encargo recusa vigência retroativa nos dois lugares.
    if (terminationDate > hoje) {
      setError('A data de encerramento não pode ser futura — a locação é encerrada e o veículo liberado no ato. Para registrar uma devolução combinada, encerre no dia.')
      return
    }

    // Abater caução exige justificativa — `CloseRentalFinancialSchema` recusa
    // com menos de 5 caracteres. Sem esta guarda a locação encerrava e a caução
    // ficava por liquidar, com o erro chegando depois do fato consumado: o
    // encerramento é irreversível, a liquidação não aconteceu, e o operador
    // descobre pela mensagem.
    if (depositBalance > 0 && depositAction !== 'full_return' && retentionReason.trim().length < 5) {
      setError('Informe o motivo do abatimento da caução — ele explica ao cliente por que o dinheiro dele virou pagamento.')
      return
    }

    if (kmFinalInvalido || kmFinalNumero === null) {
      setError(`Informe o km final — não pode ser menor que ${pisoKm.toLocaleString('pt-BR')} km.`)
      return
    }

    // RF-004: a decisão de cobrar ou não a multa é explícita — sem default,
    // sem silêncio (RN-004: não pode ser desfeita depois de confirmada).
    if (multaAplicavel && multaDecisao === null) {
      setError('Decida se a multa por rescisão antecipada será cobrada.')
      return
    }

    startTransition(async () => {
      const result = await terminateRental({
        lease_id:         rental.id,
        termination_date: terminationDate,
        new_status:       newStatus,
        force,
        km_final:         kmFinalNumero,
        charge_fine:          multaAplicavel && multaDecisao === 'charge',
        fine_deposit_amount:  multaCaucaoParaAbater,
        fine_credit_amount:   multaCreditoParaAbater,
        extra_charge_ids_to_cancel: terminationPlan
          .filter((l) => l.charge_id && l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id))
          .map((l) => l.charge_id!),
        extra_schedule_line_ids_to_cancel: terminationPlan
          .filter((l) => !l.charge_id && l.action === 'keep_optional' && extraSelected.has(l.schedule_line_id))
          .map((l) => l.schedule_line_id),
      })
      if (!result.ok) { setError(result.error.message); return }

      // Liquidação da caução, quando há saldo. `closeRentalFinancial` já existia
      // com toda a lógica — e sem nenhum chamador: a tela mostrava o saldo e
      // não oferecia como resolvê-lo.
      if (depositBalance > 0) {
        const retido = Number(retainedAmount.replace(',', '.')) || 0

        const payload =
          depositAction === 'full_return'
            ? { rental_id: rental.id, deposit_action: 'full_return' as const, return_date: terminationDate }
            : depositAction === 'full_retention'
              ? { rental_id: rental.id, deposit_action: 'full_retention' as const, retention_reason: retentionReason }
              : {
                  rental_id: rental.id,
                  deposit_action: 'partial_return' as const,
                  retained_amount: retido,
                  returned_amount: Math.round((depositBalance - retido) * 100) / 100,
                  retention_reason: retentionReason,
                  return_date: terminationDate,
                }

        const dep = await closeRentalFinancial(payload)
        if (!dep.ok) { setError(`Locação encerrada, mas a caução não foi liquidada: ${dep.error.message}`); return }
      }

      // Crédito DEPOIS da caução: a ordem da ADR 0026 é caução primeiro, e o
      // abatimento do crédito precisa ver a dívida já reduzida por ela — senão
      // consumiria crédito numa dívida que a caução acabou de cobrir.
      if (creditoParaAbater > 0) {
        const ap = await applyCreditToRentalDebt({
          rental_id:   rental.id,
          customer_id: rental.customer_id,
          amount:      creditoParaAbater,
        })
        if (!ap.ok) { setError(`Locação encerrada, mas o crédito não foi abatido: ${ap.error.message}`); return }
      }

      if (creditoParaDevolver > 0) {
        const dev = await settleCustomerCredit({
          customer_id: rental.customer_id,
          amount:      creditoParaDevolver,
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
          disabled={isPending || !terminationDate || kmFinalInvalido || (openAmount > 0 && !force) || (multaAplicavel && multaDecisao === null)}
          className="inline-flex h-8 items-center rounded-full bg-danger-bg px-5 text-[13px] font-bold text-danger transition-opacity hover:opacity-80 disabled:opacity-60"
        >
          {isPending ? 'Encerrando…' : 'Confirmar Encerramento'}
        </button>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-8">

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
                  {outsidePeriod.map((l) => (
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

                  {multaDecisao === 'charge' && (
                    <div className="mt-3 space-y-3 border-t border-divider pt-3">
                      {caucaoDisponivelParaMulta > 0 && (
                        <div>
                          <label className="text-[12px] text-fg-mute" htmlFor="multa_caucao">
                            Abater da caução (disponível {formatCurrency(caucaoDisponivelParaMulta)})
                          </label>
                          <input
                            id="multa_caucao"
                            type="number"
                            step="0.01"
                            min="0"
                            max={Math.min(caucaoDisponivelParaMulta, multaValor)}
                            value={multaCaucaoAmount}
                            onChange={(e) => setMultaCaucaoAmount(e.target.value)}
                            className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-primary"
                            placeholder="0,00"
                          />
                        </div>
                      )}
                      {creditoDisponivelParaMulta > 0 && (
                        <div>
                          <label className="text-[12px] text-fg-mute" htmlFor="multa_credito">
                            Abater do crédito (disponível {formatCurrency(creditoDisponivelParaMulta)})
                          </label>
                          <input
                            id="multa_credito"
                            type="number"
                            step="0.01"
                            min="0"
                            max={Math.min(creditoDisponivelParaMulta, Math.round((multaValor - multaCaucaoParaAbater) * 100) / 100)}
                            value={multaCreditoAmount}
                            onChange={(e) => setMultaCreditoAmount(e.target.value)}
                            className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-primary"
                            placeholder="0,00"
                          />
                        </div>
                      )}
                      <p className="text-[12px] text-fg-mute">
                        Restante vira cobrança em aberto: <strong className="font-medium text-fg-soft">{formatCurrency(multaEmAberto)}</strong>
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {depositBalance > 0 && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Destino da caução</h2>
                <div className="rounded-xl border border-divider bg-surface p-4">
                  <p className="text-[12px] leading-relaxed text-fg-mute">
                    O dinheiro do cliente está em custódia. Encerrar sem decidir o destino
                    deixaria o passivo em aberto.
                  </p>

                  <div className="mt-3 flex flex-col gap-1">
                    {/* "Reter" some do rótulo: reter É abater a dívida do cliente
                        (`deposit_retained` + `allocateWithoutCash`). O nome antigo
                        soava como "a empresa fica com o dinheiro" — ADR 0026. */}
                    {([
                      podeAbaterCaucao && [
                        'full_retention', `Abater da dívida (${formatCurrency(Math.min(depositBalance, openAmount))})`,
                      ],
                      podeAbaterCaucao && [
                        'partial_return', 'Abater parte da dívida e devolver o resto',
                      ],
                      ['full_return', `Devolver tudo (${formatCurrency(depositBalance)})`],
                    ].filter(Boolean) as [DepositAction, string][]).map(([valor, rotulo]) => (
                      <label
                        key={valor}
                        className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                          depositAction === valor ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                        }`}
                      >
                        <input
                          type="radio"
                          name="deposit_action"
                          value={valor}
                          checked={depositAction === valor}
                          onChange={() => setDepositAction(valor)}
                          className="accent-primary"
                        />
                        {rotulo}
                      </label>
                    ))}
                  </div>

                  {/* Reter é abater, e abater exige dívida. Sem ela a única saída é
                      devolver — e a tela diz qual é o caminho para reter de fato,
                      em vez de deixar o operador procurar uma opção que sumiu. */}
                  {!podeAbaterCaucao && (
                    <p className="mt-3 text-[12px] leading-relaxed text-fg-mute">
                      Sem dívida em aberto, a caução só pode ser devolvida. Para reter por avaria ou
                      diária em aberto, lance a despesa em{' '}
                      <Link href="/despesas" className="underline underline-offset-2">Despesas</Link>{' '}
                      com rateio ao cliente: isso emite a cobrança, e aí a caução tem o que abater.
                    </p>
                  )}

                  {depositAction === 'full_retention' && depositBalance > openAmount && (
                    <p className="mt-3 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] leading-relaxed text-warning">
                      A caução é maior que a dívida: abater tudo seria reter {formatCurrency(depositBalance - openAmount)}
                      {' '}sem cobrança onde alocar, e o encerramento vai recusar.
                      Use <strong>abater parte e devolver o resto</strong>, retendo no máximo{' '}
                      {formatCurrency(openAmount)}.
                    </p>
                  )}

                  {depositAction === 'partial_return' && (
                    <div className="mt-3">
                      <label className="text-[12px] text-fg-mute" htmlFor="retido">Valor retido (R$)</label>
                      <input
                        id="retido"
                        type="number"
                        step="0.01"
                        min="0"
                        max={Math.min(depositBalance, openAmount)}
                        value={retainedAmount}
                        onChange={(e) => setRetainedAmount(e.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-primary"
                        placeholder="0,00"
                      />
                      <p className="mt-1.5 text-[12px] text-fg-mute">
                        Devolve {formatCurrency(Math.max(0, depositBalance - (Number(retainedAmount.replace(',', '.')) || 0)))} ao cliente.
                      </p>
                    </div>
                  )}

                  {depositAction !== 'full_return' && (
                    <div className="mt-3">
                      <label className="text-[12px] text-fg-mute" htmlFor="motivo">Motivo da retenção</label>
                      <input
                        id="motivo"
                        value={retentionReason}
                        onChange={(e) => setRetentionReason(e.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:border-primary"
                        placeholder="Avaria no para-choque, diária em aberto…"
                      />
                    </div>
                  )}
                </div>
              </section>
            )}

            {creditBalance > 0 && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Destino do crédito</h2>
                <div className="rounded-xl border border-divider bg-surface p-4">
                  <p className="text-[12px] leading-relaxed text-fg-mute">
                    O cliente tem <strong className="font-medium text-fg-soft">{formatCurrency(creditBalance)}</strong>{' '}
                    de crédito — dívida da empresa com ele. Diferente da caução, o crédito é do CLIENTE
                    e sobrevive ao contrato: pode ficar para abater a próxima locação.
                  </p>

                  <div className="mt-3 flex flex-col gap-1">
                    {([
                      creditoAbativel > 0 && sobraDoCredito === 0 && [
                        'apply', `Abater a dívida (${formatCurrency(creditoAbativel)})`,
                      ],
                      creditoAbativel > 0 && sobraDoCredito > 0 && [
                        'apply', `Abater a dívida (${formatCurrency(creditoAbativel)}) e manter o resto como crédito`,
                      ],
                      creditoAbativel > 0 && sobraDoCredito > 0 && [
                        'apply_and_settle', `Abater a dívida e devolver a sobra (${formatCurrency(sobraDoCredito)})`,
                      ],
                      ['settle', `Devolver tudo em dinheiro (${formatCurrency(creditBalance)})`],
                      ['keep', 'Deixar como crédito do cliente'],
                    ].filter(Boolean) as [typeof creditAction, string][]).map(([valor, rotulo]) => (
                      <label
                        key={valor}
                        className={`flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                          creditAction === valor ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2'
                        }`}
                      >
                        <input
                          type="radio"
                          name="credit_action"
                          value={valor}
                          checked={creditAction === valor}
                          onChange={() => setCreditAction(valor)}
                          className="accent-primary"
                        />
                        {rotulo}
                      </label>
                    ))}
                  </div>

                  {creditAction === 'keep' && emAbertoDepoisDaCaucao > 0 && (
                    <p className="mt-3 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[12px] leading-relaxed text-warning">
                      O cliente fica devendo {formatCurrency(emAbertoDepoisDaCaucao)} e credor de{' '}
                      {formatCurrency(creditBalance)} ao mesmo tempo. É escolha válida — só raramente
                      é a intenção.
                    </p>
                  )}

                  {creditAction === 'keep' && emAbertoDepoisDaCaucao === 0 && (
                    <p className="mt-3 text-[12px] leading-relaxed text-fg-mute">
                      Sem dívida a abater, o crédito fica no saldo do cliente. Se ele não tem outra
                      locação, considere devolver — ou ele vai embora credor.{' '}
                      <Link href={`/clientes/${rental.customer_id}`} className="underline underline-offset-2">
                        Ficha do cliente
                      </Link>
                    </p>
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
                    {(caucaoParaAbater > 0 || creditoParaAbater > 0) && (
                      <> Depois do acerto desta tela ficam <strong>{formatCurrency(emAbertoFinal)}</strong>.</>
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
                diz no que isso resulta. Sem ele, "encerrar mesmo com R$ 1.200,00
                em aberto" era o único número da tela, de um cliente cujo dinheiro
                a empresa está segurando. */}
            {openAmount > 0 && (depositBalance > 0 || creditBalance > 0) && (
              <section>
                <h2 className="mb-3 text-[14px] font-bold text-primary">Acerto final</h2>
                <div className="overflow-hidden rounded-xl border border-divider bg-surface">

                  <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                    <span className="text-[13px] text-fg-mute">Dívida do cliente</span>
                    <span className="text-[13px] tabular-nums text-fg">{formatCurrency(openAmount)}</span>
                  </div>

                  {depositBalance > 0 && (
                    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                      <span className="text-[13px] text-fg-mute">
                        Caução abatida
                        {caucaoParaAbater === 0 && <span className="ml-1 text-[12px]">(escolheu devolver)</span>}
                      </span>
                      <span className={`text-[13px] tabular-nums ${caucaoParaAbater > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                        − {formatCurrency(caucaoParaAbater)}
                      </span>
                    </div>
                  )}

                  {creditBalance > 0 && (
                    <div className="flex items-baseline justify-between gap-3 border-t border-divider px-4 py-2.5">
                      <span className="text-[13px] text-fg-mute">
                        Crédito abatido
                        {creditoParaAbater === 0 && creditoAbativel > 0 && (
                          <span className="ml-1 text-[12px]">(disponível {formatCurrency(creditoAbativel)})</span>
                        )}
                      </span>
                      <span className={`text-[13px] tabular-nums ${creditoParaAbater > 0 ? 'text-fg' : 'text-fg-mute'}`}>
                        − {formatCurrency(creditoParaAbater)}
                      </span>
                    </div>
                  )}

                  <div className="flex items-baseline justify-between gap-3 border-t border-divider bg-surface-2 px-4 py-2.5">
                    <span className="text-[13px] font-medium text-fg">Restante a receber</span>
                    <span className={`text-[13px] font-bold tabular-nums ${emAbertoFinal > 0 ? 'text-fg' : 'text-success'}`}>
                      {formatCurrency(emAbertoFinal)}
                    </span>
                  </div>

                  {/* Devolução é a única linha que tira dinheiro do caixa — e o
                      encerramento passou a poder fazer as duas de uma vez. */}
                  {(caucaoParaDevolver > 0 || creditoParaDevolver > 0) && (
                    <div className="border-t border-divider px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[13px] text-fg-mute">Sai do caixa</span>
                        <span className="text-[13px] font-semibold tabular-nums text-danger">
                          {formatCurrency(Math.round((caucaoParaDevolver + creditoParaDevolver) * 100) / 100)}
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
