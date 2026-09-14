/**
 * Cronograma de cobrança da locação.
 *
 * Spec 0014 / ADR 0024, Princípio 5. Reversão da ADR 0009: em vez de emitir
 * 104 documentos na assinatura, a locação grava um PLANO. A cobrança nasce
 * quando o período chega, e a partir daí é imutável.
 *
 * A geração reaproveita `generateCycleCharges` — a lógica de pro rata,
 * primeiro/último ciclo e dia de vencimento é a mesma já testada, e continua
 * com uma única fonte de verdade. Este módulo só a adapta para linhas de
 * `rental_billing_schedules`.
 */

import {
  generateCycleCharges,
  isParseableIsoDate,
  rentalPeriodsOverlap,
  type CycleChargeInput,
  type RentalType,
} from './rentals'

export type ScheduleStatus = 'scheduled' | 'issued' | 'cancelled' | 'superseded'

export type ScheduleLine = {
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
  /** Só para exibição no preview; não é persistido no cronograma. */
  description: string
}

/**
 * Gera o cronograma completo da locação.
 *
 * É a MESMA função consumida pelo preview antes da confirmação (RF-036) e
 * pela RPC `create_rental_with_schedule`. Preview e persistência não podem
 * divergir — por isso não existe uma segunda implementação.
 */
export function generateSchedule(input: CycleChargeInput): ScheduleLine[] {
  return generateCycleCharges(input).map((charge, index) => ({
    sequence_number: index + 1,
    period_start: charge.period_start,
    period_end: charge.period_end,
    due_date: charge.due_date,
    amount: charge.amount,
    description: charge.description,
  }))
}

/**
 * Linhas que o job de emissão deve transformar em cobrança.
 *
 * Espelha o filtro da RPC `issue_due_charges`: período já começou (com
 * antecedência opcional) e a linha ainda não virou documento.
 *
 * @param leadDays Emitir com N dias de antecedência ao início do período.
 */
export function selectIssuableLines<T extends { period_start: string; status: ScheduleStatus }>(
  lines: T[],
  asOf: Date = new Date(),
  leadDays = 0,
): T[] {
  const cutoff = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() + leadDays)
  const cutoffIso = toIsoDate(cutoff)

  return lines
    .filter((l) => l.status === 'scheduled')
    .filter((l) => l.period_start <= cutoffIso)
}

/**
 * Reajuste: quais linhas podem ter o valor alterado.
 *
 * Apenas as ainda não emitidas, a partir da data de vigência. Período já
 * emitido é documento imutável — ajustá-lo exige cobrança complementar ou
 * renegociação. Antes, `adjust_rental` reescrevia `billings` já emitidos.
 */
export function selectAdjustableLines<T extends { period_start: string; status: ScheduleStatus }>(
  lines: T[],
  effectiveFrom: string,
): T[] {
  return lines
    .filter((l) => l.status === 'scheduled')
    .filter((l) => l.period_start >= effectiveFrom)
}

/**
 * Total ainda não emitido de uma locação.
 *
 * É a "carteira contratada" — métrica legítima, mas que NÃO é contas a receber.
 * Confundir as duas é o defeito F-10: hoje o dashboard soma todas as cobranças
 * pendentes sem recorte, e um rent-to-own de 2 anos entra inteiro no indicador.
 */
export function contractedBacklog(
  lines: Array<{ amount: number; status: ScheduleStatus }>,
): number {
  return round2(
    lines
      .filter((l) => l.status === 'scheduled')
      .reduce((sum, l) => sum + l.amount, 0),
  )
}

function toIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Ajuste de período e condições da locação (ADR 0035)
// ---------------------------------------------------------------------------

/**
 * Os seis parâmetros que definem o cronograma. É exatamente `CycleChargeInput`
 * — não um tipo paralelo — porque quem os consome é `generateSchedule`.
 */
export type RentalScheduleParams = CycleChargeInput

/** Linha de `rental_billing_schedules` como ela chega do banco. */
export type ScheduleLineRow = {
  id: string
  sequence_number: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
  status: ScheduleStatus
}

/**
 * Cobrança emitida a partir de uma linha do cronograma.
 *
 * O vínculo é `charges.source_module='rental'` + `charges.source_id = <id da
 * linha>` (migration `charge_single_origin`), não uma coluna `charge_id` na
 * linha — essa foi derrubada justamente porque a origem do documento é o
 * PERÍODO, não o contrato.
 */
export type ScheduleLineChargeRow = {
  schedule_line_id: string
  charge_id: string
  charge_number: number
  due_date: string
  total_amount: number
  paid_amount: number
  status: 'open' | 'paid' | 'cancelled' | 'written_off'
}

export type PeriodAdjustmentInput = {
  current: RentalScheduleParams
  next: RentalScheduleParams
  contract_type: RentalType
  lines: ReadonlyArray<ScheduleLineRow>
  charges: ReadonlyArray<ScheduleLineChargeRow>
  /** Fronteira entre história e futuro. Ver `defaultEffectiveFrom`. */
  effective_from: string
  /** Data de negócio do tenant (`fn_business_today`), nunca o relógio do browser. */
  today: string
  /** Há PDF assinado anexado? Só alimenta um aviso. */
  has_signed_contract?: boolean
  /**
   * As OUTRAS locações do mesmo veículo (ADR 0036). O período desta não pode
   * cruzar o de nenhuma delas — a moto não fica com dois clientes ao mesmo
   * tempo. O banco recusa de qualquer forma; isto é o que deixa a prévia dizer
   * o motivo antes do clique.
   */
  other_rentals?: ReadonlyArray<{ start_date: string; end_date: string | null }>
}

export type AdjustmentNotice = { code: string; message: string }

export type PlannedScheduleLine = ScheduleLine & {
  /** O período já começou: o job de emissão pega esta linha na próxima rodada. */
  emits_now: boolean
  /** Vai nascer vencida, com encargo por atraso correndo desde o vencimento. */
  born_overdue: boolean
}

export type PeriodAdjustmentPlan = {
  changed_fields: Array<keyof RentalScheduleParams>
  effective_from: string
  /** '' quando nada foi pago — sem piso nenhum. Ver `minEffectiveFrom`. */
  min_effective_from: string
  default_effective_from: string
  /** Impedimentos: enquanto houver um, a operação não pode ser confirmada. */
  blockers: AdjustmentNotice[]
  /** Consequências que o operador precisa ver, mas que não impedem nada. */
  warnings: AdjustmentNotice[]
  /** Linhas anteriores à fronteira e ainda dentro da vigência — intocadas. */
  keep_lines: ScheduleLineRow[]
  /** Linhas que serão marcadas `superseded`. */
  supersede_lines: Array<ScheduleLineRow & { was_issued: boolean }>
  /** Cobranças emitidas que precisam ser canceladas para o plano mudar. */
  cancel_charges: ScheduleLineChargeRow[]
  new_lines: PlannedScheduleLine[]
  totals: {
    superseded: number
    cancelled: number
    created: number
    /** Criado − (substituído + cancelado). O quanto o contrato passa a valer a mais. */
    delta: number
  }
}

const PARAM_KEYS: Array<keyof RentalScheduleParams> = [
  'start_date', 'end_date', 'cycle', 'due_day', 'cycle_amount', 'use_pro_rata',
]

const PARAM_LABEL: Record<keyof RentalScheduleParams, string> = {
  start_date:   'data de início',
  end_date:     'data de fim',
  cycle:        'ciclo',
  due_day:      'dia de vencimento',
  cycle_amount: 'valor do ciclo',
  use_pro_rata: 'pro rata',
}

/** Rótulo em português do parâmetro, para montar mensagens sem duplicar mapa na UI. */
export function scheduleParamLabel(key: keyof RentalScheduleParams): string {
  return PARAM_LABEL[key]
}

/** Linha que ainda conta: `cancelled` e `superseded` são inertes. */
function isLive(l: ScheduleLineRow): boolean {
  return l.status === 'scheduled' || l.status === 'issued'
}

/**
 * Data mínima de vigência: o fim do último período cujo dinheiro já entrou.
 *
 * Antes dela não há ajuste possível — mexer no plano exigiria cancelar uma
 * cobrança com pagamento alocado, e `cancelCharge` recusa (com razão: desfazer
 * recebimento é estorno de pagamento, operação própria e com tela própria).
 *
 * Sem NENHUMA cobrança de ciclo paga, não há piso nenhum: devolve `''`. Um
 * `fallback` aqui já foi `next.start_date` — a data nova que o operador está
 * digitando — e isso produzia um piso que coincidia, por acidente, com o
 * próprio valor sendo escolhido. O sintoma: "Há período já pago até
 * 24/08/2025" para uma vigência de 24/08/2025 sem nenhum centavo pago,
 * porque o fallback nunca foi alcançado por dinheiro nenhum — só pela mesma
 * data que o usuário tinha acabado de digitar. `''` é sempre "menor" que
 * qualquer data ISO real na comparação lexicográfica, então não bloqueia.
 */
export function minEffectiveFrom(
  lines: ReadonlyArray<ScheduleLineRow>,
  charges: ReadonlyArray<ScheduleLineChargeRow>,
): string {
  const paidLineIds = new Set(
    charges.filter((c) => c.paid_amount > 0 || c.status === 'written_off')
      .map((c) => c.schedule_line_id),
  )

  let max: string | null = null
  for (const l of lines) {
    if (!paidLineIds.has(l.id)) continue
    if (!max || l.period_end > max) max = l.period_end
  }
  return max ?? ''
}

/**
 * Vigência sugerida: o fim do último período JÁ EMITIDO.
 *
 * Escolha conservadora de propósito — com ela nenhuma cobrança é cancelada, e o
 * ajuste só alcança o que ainda é plano. Cancelar documento passa a ser um ato
 * deliberado do operador, que precisa puxar a data para trás e ver a lista do
 * que vai cair.
 */
export function defaultEffectiveFrom(
  lines: ReadonlyArray<ScheduleLineRow>,
  fallback: string,
): string {
  let max: string | null = null
  for (const l of lines) {
    if (l.status !== 'issued') continue
    if (!max || l.period_end > max) max = l.period_end
  }
  return max ?? fallback
}

/**
 * Planeja a mudança de período/condições de uma locação.
 *
 * É a MESMA função usada pela prévia na tela e pela Server Action que grava —
 * pelo mesmo motivo que `generateSchedule` é única: prévia e persistência não
 * podem divergir. O que o operador confere é literalmente o que vai acontecer.
 *
 * O modelo é uma fronteira (`effective_from`) separando história de futuro:
 * antes dela, nada muda; depois, o cronograma é regerado com os parâmetros
 * novos. Linha `scheduled` do lado do futuro é substituída sem consequência
 * financeira — nunca virou documento. Linha `issued` exige cancelar a cobrança,
 * e cobrança com dinheiro alocado não é cancelável: vira impedimento.
 */
export function planPeriodAdjustment(input: PeriodAdjustmentInput): PeriodAdjustmentPlan {
  const { current, next, lines, charges, today } = input

  const blockers: AdjustmentNotice[] = []
  const warnings: AdjustmentNotice[] = []

  const changed_fields = PARAM_KEYS.filter((k) => current[k] !== next[k])

  const liveLines = lines.filter(isLive)
  const min_effective_from     = minEffectiveFrom(liveLines, charges)
  const default_effective_from = defaultEffectiveFrom(liveLines, next.start_date)
  const effective_from = input.effective_from || default_effective_from

  const empty: PeriodAdjustmentPlan = {
    changed_fields, effective_from, min_effective_from, default_effective_from,
    blockers, warnings,
    keep_lines: [], supersede_lines: [], cancel_charges: [], new_lines: [],
    totals: { superseded: 0, cancelled: 0, created: 0, delta: 0 },
  }

  // Data impossível não gera plano. `generateCycleCharges` já se protege
  // devolvendo lista vazia, mas aqui o silêncio seria pior: a tela mostraria
  // "nenhuma cobrança será criada" para um contrato inteiro sendo apagado.
  if (!isParseableIsoDate(next.start_date) || !isParseableIsoDate(next.end_date)) {
    blockers.push({ code: 'INVALID_DATE', message: 'Data de início ou de fim inválida.' })
    return empty
  }
  if (next.end_date <= next.start_date) {
    blockers.push({ code: 'END_BEFORE_START', message: 'A data de fim precisa ser posterior à de início.' })
    return empty
  }

  // Um veículo, uma locação por vez (ADR 0036). O caso que esta tela abre é
  // antecipar o início para antes da devolução da locação ANTERIOR, que já
  // está encerrada — a regra "uma ativa por veículo" não o enxerga.
  const conflito = (input.other_rentals ?? []).find((o) =>
    rentalPeriodsOverlap(next.start_date, next.end_date, o.start_date, o.end_date))
  if (conflito) {
    blockers.push({
      code: 'VEHICLE_PERIOD_OVERLAP',
      message: conflito.end_date
        ? `Este veículo esteve em outra locação de ${formatBrDate(conflito.start_date)} a ${formatBrDate(conflito.end_date)}. O período desta locação não pode cruzar o dela — a moto não fica com dois clientes ao mesmo tempo.`
        : `Este veículo está em outra locação desde ${formatBrDate(conflito.start_date)}, sem data de fim.`,
    })
    return empty
  }
  if (!isParseableIsoDate(effective_from)) {
    blockers.push({ code: 'INVALID_DATE', message: 'Data de vigência inválida.' })
    return empty
  }
  if (effective_from < min_effective_from) {
    blockers.push({
      code: 'EFFECTIVE_BEFORE_PAID',
      message: `Há período já pago até ${formatBrDate(min_effective_from)}. A vigência do ajuste não pode ser anterior a essa data — desfazer recebimento é estorno de pagamento.`,
    })
    return empty
  }

  // Uma linha SOBREVIVE quando está do lado da história E continua coberta pela
  // nova vigência. A segunda parte é o que impede um período órfão: mover o
  // início do contrato para depois de uma parcela deixaria essa parcela
  // cobrando um período que o contrato passou a dizer que não existiu.
  const survives = (l: ScheduleLineRow) =>
    l.period_end   <= effective_from &&
    l.period_start >= next.start_date &&
    l.period_end   <= next.end_date

  const keep_lines: ScheduleLineRow[] = []
  const supersede_lines: Array<ScheduleLineRow & { was_issued: boolean }> = []
  const cancel_charges: ScheduleLineChargeRow[] = []

  const chargeByLine = new Map(charges.map((c) => [c.schedule_line_id, c]))

  for (const l of liveLines) {
    if (survives(l)) { keep_lines.push(l); continue }

    supersede_lines.push({ ...l, was_issued: l.status === 'issued' })
    if (l.status !== 'issued') continue

    const charge = chargeByLine.get(l.id)
    // Linha emitida sem cobrança viva localizável: ou já foi cancelada, ou o
    // vínculo se perdeu. Nos dois casos não há documento a cancelar.
    if (!charge || charge.status === 'cancelled') continue

    if (charge.status === 'written_off') {
      blockers.push({
        code: 'WRITTEN_OFF_IN_RANGE',
        message: `A cobrança #${charge.charge_number} foi baixada por inadimplência. Perda reconhecida não se desfaz por ajuste de período.`,
      })
      continue
    }
    if (charge.paid_amount > 0) {
      blockers.push({
        code: 'PAID_CHARGE_IN_RANGE',
        message: `A cobrança #${charge.charge_number} já tem ${formatBrl(charge.paid_amount)} recebido${charge.status === 'paid' ? '' : ' (parcial)'}. Estorne o pagamento antes, ou adie a vigência do ajuste.`,
      })
      continue
    }
    cancel_charges.push(charge)
  }

  // A regeneração começa onde a sobrevivência termina — sem buraco e sem
  // sobreposição, porque toda linha mantida tem `period_end <= effective_from`.
  const regenFrom = next.start_date > effective_from ? next.start_date : effective_from

  if (next.end_date <= regenFrom) {
    blockers.push({
      code: 'NOTHING_LEFT',
      message: `A nova data de fim não deixa nenhuma parcela após ${formatBrDate(regenFrom)}. Encerrar o contrato é outra operação — use Encerrar.`,
    })
  }

  const maxSequence = lines.reduce((m, l) => (l.sequence_number > m ? l.sequence_number : m), 0)

  // A numeração CONTINUA em vez de reiniciar: `UNIQUE (rental_id,
  // sequence_number)` proíbe reuso, e o histórico do plano precisa continuar
  // legível ao lado das linhas novas.
  const new_lines: PlannedScheduleLine[] =
    blockers.length > 0
      ? []
      : generateSchedule({ ...next, start_date: regenFrom }).map((l) => ({
          ...l,
          sequence_number: maxSequence + l.sequence_number,
          emits_now:    l.period_start <= today,
          born_overdue: l.due_date     <  today,
        }))

  const supersededTotal = round2(supersede_lines.filter(l => !l.was_issued).reduce((s, l) => s + l.amount, 0))
  const cancelledTotal  = round2(cancel_charges.reduce((s, c) => s + c.total_amount, 0))
  const createdTotal    = round2(new_lines.reduce((s, l) => s + l.amount, 0))

  if (blockers.length === 0) {
    const emitsNow    = new_lines.filter((l) => l.emits_now).length
    const bornOverdue = new_lines.filter((l) => l.born_overdue).length

    if (emitsNow > 0) {
      warnings.push({
        code: 'EMITS_NOW',
        message: `${emitsNow} parcela${emitsNow > 1 ? 's' : ''} já ${emitsNow > 1 ? 'têm' : 'tem'} período iniciado e ${emitsNow > 1 ? 'serão emitidas' : 'será emitida'} na próxima rodada de emissão.`,
      })
    }
    if (bornOverdue > 0) {
      warnings.push({
        code: 'BORN_OVERDUE',
        message: `${bornOverdue} cobrança${bornOverdue > 1 ? 's nascerão vencidas' : ' nascerá vencida'}, com encargo por atraso correndo desde o vencimento.`,
      })
    }
    if (next.start_date < current.start_date && keep_lines.length + new_lines.length > 0) {
      const firstCovered = [...keep_lines, ...new_lines]
        .map((l) => l.period_start)
        .sort()[0]
      if (firstCovered && next.start_date < firstCovered) {
        warnings.push({
          code: 'START_BEFORE_ISSUED',
          message: `O período de ${formatBrDate(next.start_date)} a ${formatBrDate(firstCovered)} fica sem parcela no cronograma. Se precisar cobrá-lo, use cobrança avulsa.`,
        })
      }
    }
    if (current.cycle !== next.cycle) {
      warnings.push({
        code: 'CYCLE_CHANGED',
        message: `Mudança de ciclo ${current.cycle === 'weekly' ? 'semanal → mensal' : 'mensal → semanal'}: o número de parcelas muda por completo, e o valor do ciclo passa a se referir a outro período.`,
      })
    }
    if (input.has_signed_contract && (changed_fields.includes('start_date') || changed_fields.includes('end_date'))) {
      warnings.push({
        code: 'SIGNED_CONTRACT_DIVERGES',
        message: 'Há contrato assinado anexado. As datas dele deixam de bater com o registro — isso é aditivo contratual.',
      })
    }
    if (input.contract_type === 'rent_to_own' && changed_fields.includes('start_date')) {
      warnings.push({
        code: 'RENT_TO_OWN_TRANSFER_MOVED',
        message: 'Em compra programada a transferência é sempre início + 2 anos. Mudar o início move a data em que o contrato passa a ser transferível.',
      })
    }
    if (changed_fields.includes('start_date') || changed_fields.includes('end_date')) {
      warnings.push({
        code: 'PERIOD_WINDOW_CHANGED',
        message: 'A janela do contrato muda: manutenções e multas são associadas à locação por data, então a aba Manutenções e a atribuição de multas podem mudar.',
      })
    }
  }

  return {
    changed_fields, effective_from, min_effective_from, default_effective_from,
    blockers, warnings,
    keep_lines, supersede_lines, cancel_charges, new_lines,
    totals: {
      superseded: supersededTotal,
      cancelled:  cancelledTotal,
      created:    createdTotal,
      delta:      round2(createdTotal - supersededTotal - cancelledTotal),
    },
  }
}

/** Formatação mínima para as mensagens desta camada, que não importa UI. */
function formatBrl(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`
}

/** ISO para dd/mm/aaaa. Mensagem que o operador lê não mostra data de banco. */
function formatBrDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}/${m}/${y}` : iso
}
