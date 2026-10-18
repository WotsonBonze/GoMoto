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
  /**
   * A vigência só existe pra decidir "a partir de quando" um REPREÇO ou
   * REDESENHO de ciclo passa a valer — não pra decidir SE um período existe.
   * Isso já é resposta pura de `start_date`/`end_date`: um período que não
   * cabe mais na janela nova é substituído de qualquer forma, vigência
   * nenhuma muda isso. Por isso ela só entra em jogo quando `cycle`,
   * `due_day`, `cycle_amount` ou `use_pro_rata` mudam — mudar só as datas
   * não deveria (e não deve mais) reabrir cobrança já emitida que continua
   * cabendo no contrato novo. A tela usa este campo pra decidir se mostra o
   * controle "Aplicar a partir de".
   */
  effective_from_applies: boolean
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
  const effective_from_applies = changed_fields.some((k) => k !== 'start_date' && k !== 'end_date')

  const liveLines = lines.filter(isLive)
  const min_effective_from     = minEffectiveFrom(liveLines, charges)
  const default_effective_from = defaultEffectiveFrom(liveLines, next.start_date)
  const effective_from = input.effective_from || default_effective_from

  const empty: PeriodAdjustmentPlan = {
    changed_fields, effective_from, min_effective_from, default_effective_from, effective_from_applies,
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
  if (effective_from_applies && effective_from < min_effective_from) {
    blockers.push({
      code: 'EFFECTIVE_BEFORE_PAID',
      message: `Há período já pago até ${formatBrDate(min_effective_from)}. A vigência do ajuste não pode ser anterior a essa data — desfazer recebimento é estorno de pagamento.`,
    })
    return empty
  }

  // Uma linha SOBREVIVE quando continua cabendo na janela nova. Isso sozinho
  // já impede período órfão: mover o início do contrato para depois de uma
  // parcela deixaria essa parcela cobrando um período que o contrato passou a
  // dizer que não existiu — e isso vale INDEPENDENTE de vigência, porque é
  // resposta pura de `next.start_date`/`next.end_date`.
  //
  // A vigência só entra quando `effective_from_applies`: aí uma linha que
  // ainda cabe na janela pode mesmo assim ser riscada, se estiver do lado
  // "futuro" da fronteira — é o mecanismo que permite reprecificar cobrança
  // já emitida ao mudar ciclo/vencimento/valor/pro-rata. Sem isso mudando,
  // não existe motivo pra tocar numa linha que já cabe.
  const survives = (l: ScheduleLineRow) =>
    (!effective_from_applies || l.period_end <= effective_from) &&
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

  // `keep_lines` sempre forma UM ÚNICO trecho contínuo: as três condições de
  // `survives` são monótonas na posição do período (data de início barra as
  // mais antigas, `effective_from` barra as mais novas), então não há como um
  // período do meio falhar enquanto os vizinhos sobrevivem. Um buraco só pode
  // se abrir nas DUAS pontas desse trecho — e é aí que ele se abria em
  // silêncio: mover o início para dentro de um período já emitido invalidava
  // a linha inteira (linha esquerda), e uma `effective_from` digitada no meio
  // de um período fazia o mesmo do outro lado (linha direita) — nos dois
  // casos a cobrança cancelada nunca ganhava substituta para o trecho que
  // continua dentro do contrato novo.
  const keptStarts = keep_lines.map((l) => l.period_start)
  const keptEnds    = keep_lines.map((l) => l.period_end)
  const firstKeptStart = keptStarts.length ? keptStarts.reduce((a, b) => (a < b ? a : b)) : null
  const lastKeptEnd    = keptEnds.length    ? keptEnds.reduce((a, b) => (a > b ? a : b))    : null

  // A regeneração retoma exatamente onde o trecho mantido termina — não mais
  // sempre em `effective_from`: quando a fronteira cai no meio de um período
  // (em vez de bater numa borda), o pedaço entre o fim do último mantido e a
  // fronteira é exatamente o buraco da ponta direita.
  const regenFrom = lastKeptEnd ?? next.start_date

  // `regenFrom` alcançando `next.end_date` sozinho não é problema: pode ser
  // só cobertura completa (ex.: início avança até bater exatamente na borda
  // de um período que já existia — fim não mudou, não sobra nem falta nada).
  // O sinal de "isso devia ser Encerrar" é mais específico: o FIM encurtou
  // em relação ao que o contrato já prometia (`current.end_date`) E, mesmo
  // assim, não nasce nenhuma parcela nova — nem a ponta esquerda (quando
  // `next.start_date` abre um buraco antes do primeiro período mantido) nem
  // a regeneração principal. Sem o encurtamento, "nada novo" é só dizer que
  // o trecho mantido já cobre a janela inteira sozinho — normal.
  const hasLeftGap = firstKeptStart !== null && next.start_date < firstKeptStart
  const contractShortened = next.end_date < current.end_date
  if (contractShortened && !hasLeftGap && next.end_date <= regenFrom) {
    blockers.push({
      code: 'NOTHING_LEFT',
      message: `A nova data de fim não deixa nenhuma parcela após ${formatBrDate(regenFrom)}. Encerrar o contrato é outra operação — use Encerrar.`,
    })
  }

  const maxSequence = lines.reduce((m, l) => (l.sequence_number > m ? l.sequence_number : m), 0)

  // Candidatas a REAPROVEITAR: linhas que seriam substituídas, mas ainda não
  // viraram documento. Uma linha `issued` só cai na zona de substituição
  // quando o operador escolhe deliberadamente puxar a vigência para trás do
  // padrão sugerido (que já protege o que foi emitido) — aí cancelar é o ato
  // explícito que ele pediu, não algo para esta função presumir que pode
  // pular só porque os valores bateram.
  const reusable = new Map(
    supersede_lines.filter((l) => !l.was_issued).map((l) => [l.period_start, l]),
  )
  const reusedIds = new Set<string>()

  // A numeração CONTINUA em vez de reiniciar quando a linha É recriada:
  // `UNIQUE (rental_id, sequence_number)` proíbe reuso, e o histórico do
  // plano precisa continuar legível ao lado das linhas novas.
  //
  // Regenerar tudo sobre o corte é o modelo simples e robusto da ADR 0035:
  // sem diff, qualquer combinação dos seis parâmetros sai correta. O custo é
  // recriar, byte a byte, o que não mudou — comum quando só o prazo
  // (início/fim) é ajustado e ciclo/valor/vencimento seguem iguais: cada
  // período do meio regenera idêntico ao que já existia. Quando a linha nova
  // bate EXATAMENTE com uma candidata (mesmo período, mesmo vencimento, mesmo
  // valor), a original é reaproveitada em vez de riscada e recriada — sem
  // efeito nenhum no dinheiro, porque nenhuma das duas nunca virou documento.
  const new_lines: PlannedScheduleLine[] = []
  if (blockers.length === 0) {
    // Buraco da ponta ESQUERDA: `next.start_date` cai antes do primeiro
    // período mantido — seja porque o início avançou para dentro dele
    // (invalidando-o), seja porque recuou para antes de qualquer período
    // existente. Gerar esse trecho como seu próprio cronograma
    // ([next.start_date, firstKeptStart)) reaproveita a mesma lógica de ciclo
    // cheio/pro rata de `generateCycleCharges` — nenhuma regra nova, só o
    // alcance de onde ela já roda.
    const toGenerate: ScheduleLine[] = []
    if (firstKeptStart !== null && next.start_date < firstKeptStart) {
      toGenerate.push(...generateSchedule({ ...next, start_date: next.start_date, end_date: firstKeptStart }))
    }
    toGenerate.push(...generateSchedule({ ...next, start_date: regenFrom }))

    // Numeração é um contador único sobre a lista combinada — cada chamada a
    // `generateSchedule` reinicia sua própria em 1, e usar o índice de cada
    // uma isoladamente colidiria (a primeira linha do buraco e a primeira da
    // regeneração principal cairiam no mesmo `sequence_number`).
    let seq = maxSequence
    for (const l of toGenerate) {
      seq += 1
      const candidate = reusable.get(l.period_start)
      if (
        candidate &&
        candidate.period_end === l.period_end &&
        candidate.due_date   === l.due_date &&
        candidate.amount     === l.amount
      ) {
        reusedIds.add(candidate.id)
        continue
      }
      new_lines.push({
        ...l,
        sequence_number: seq,
        emits_now:    l.period_start <= today,
        born_overdue: l.due_date     <  today,
      })
    }
  }

  // Linhas reaproveitadas voltam para `keep_lines` e saem de `supersede_lines`
  // — mutação em vez de reatribuição porque as duas constantes já circulam
  // por referência (inclusive no `return` mais abaixo).
  if (reusedIds.size > 0) {
    const aindaSubstituidas: typeof supersede_lines = []
    for (const l of supersede_lines) {
      if (reusedIds.has(l.id)) keep_lines.push(l)
      else aindaSubstituidas.push(l)
    }
    supersede_lines.length = 0
    supersede_lines.push(...aindaSubstituidas)
  }

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
    changed_fields, effective_from, min_effective_from, default_effective_from, effective_from_applies,
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

// ---------------------------------------------------------------------------
// Encerramento retroativo — o que acontece com cada linha do cronograma
// (Spec 0016, revisão de 2026-09-17)
// ---------------------------------------------------------------------------

/** Charge com o dado extra que só a view `charge_balances` sabe. */
export type TerminationChargeInfo = ScheduleLineChargeRow & { is_overdue: boolean }

/**
 * O que este encerramento faz com uma linha do cronograma (emitida ou não):
 *
 * - `cancel_auto`   — fora do período (RN-002) e elegível: sempre cancelada,
 *   sem escolha do operador. É o mesmo tratamento que `rental_billing_schedules`
 *   já dava a linha `scheduled` fora do período; agora vale também para
 *   `issued`.
 * - `blocked`       — fora do período, mas com valor já reduzido (RN-001):
 *   não pode ser cancelada por este fluxo. Só existe para linha emitida —
 *   linha ainda não emitida nunca tem pagamento.
 * - `keep_optional` — dentro do período e elegível: mantida por padrão, com
 *   opção de o operador marcar para cancelar mesmo assim.
 * - `keep_locked`   — dentro do período, mas com valor já reduzido: mantida,
 *   sem opção (nada a decidir).
 */
export type TerminationAction = 'cancel_auto' | 'blocked' | 'keep_optional' | 'keep_locked'

export type TerminationLine = {
  schedule_line_id: string
  /** `null` quando a linha ainda não virou documento (planejada). */
  charge_id: string | null
  charge_number: number | null
  period_start: string
  period_end: string
  total_amount: number
  paid_amount: number
  is_issued: boolean
  is_overdue: boolean
  is_outside_period: boolean
  /** `false` quando há pagamento OU crédito já aplicado (RN-001). */
  is_eligible: boolean
  action: TerminationAction
}

/**
 * Classifica TODA linha viva do cronograma (`scheduled` ou `issued`) em
 * relação a uma data de encerramento retroativa — emitida ou não, vencida ou
 * não, dentro ou fora do período que sobrevive ao encerramento (PRD 0016).
 *
 * `is_eligible` replica a regra de `cancelCharge` (RN-001): qualquer valor já
 * reduzido — pagamento ou crédito do cliente aplicado — torna a cobrança
 * imune. Os dois caem na mesma conta porque `fn_apply_customer_credit` grava
 * o abatimento como um pagamento de método `credit`, então `paid_amount` já
 * soma os dois. Linha ainda não emitida nunca tem cobrança, logo é sempre
 * elegível.
 *
 * A MESMA função alimenta a prévia da tela e a revalidação server-side da
 * Action — prévia e persistência não podem divergir, mesmo motivo de
 * `planPeriodAdjustment`.
 */
export function planRetroactiveTermination(
  lines: ReadonlyArray<ScheduleLineRow>,
  charges: ReadonlyArray<TerminationChargeInfo>,
  terminationDate: string,
): TerminationLine[] {
  const chargeByLine = new Map(charges.map((c) => [c.schedule_line_id, c]))

  const rows: TerminationLine[] = []
  for (const line of lines) {
    if (line.status !== 'scheduled' && line.status !== 'issued') continue

    const charge = chargeByLine.get(line.id) ?? null
    const isOutside  = line.period_start > terminationDate
    const paidAmount = charge?.paid_amount ?? 0
    const isEligible = paidAmount === 0

    let action: TerminationAction
    if (isOutside) action = isEligible ? 'cancel_auto' : 'blocked'
    else           action = isEligible ? 'keep_optional' : 'keep_locked'

    rows.push({
      schedule_line_id: line.id,
      charge_id:         charge?.charge_id ?? null,
      charge_number:     charge?.charge_number ?? null,
      period_start:      line.period_start,
      period_end:        line.period_end,
      total_amount:      charge?.total_amount ?? line.amount,
      paid_amount:       paidAmount,
      is_issued:         line.status === 'issued',
      is_overdue:        charge?.is_overdue ?? false,
      is_outside_period: isOutside,
      is_eligible:       isEligible,
      action,
    })
  }
  return rows.sort((a, b) => a.period_start.localeCompare(b.period_start))
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
