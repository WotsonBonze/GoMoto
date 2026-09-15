import { describe, it, expect } from 'vitest'
import {
  generateSchedule,
  selectIssuableLines,
  selectAdjustableLines,
  contractedBacklog,
  planPeriodAdjustment,
  type ScheduleStatus,
  type ScheduleLineRow,
  type ScheduleLineChargeRow,
  type PeriodAdjustmentInput,
  type PeriodAdjustmentPlan,
} from './schedule'

const HOJE = new Date(2026, 7, 12) // 2026-08-12 local

function line(period_start: string, status: ScheduleStatus, amount = 250) {
  return { period_start, status, amount }
}

describe('generateSchedule', () => {
  const base = {
    start_date: '2026-08-01',
    end_date: '2026-08-29',
    cycle: 'weekly' as const,
    due_day: 6, // sábado
    cycle_amount: 250,
    use_pro_rata: false,
  }

  it('numera as linhas a partir de 1, em sequência', () => {
    const linhas = generateSchedule(base)
    expect(linhas.length).toBeGreaterThan(0)
    expect(linhas.map((l) => l.sequence_number)).toEqual(
      linhas.map((_, i) => i + 1),
    )
  })

  it('cada linha tem período coerente: fim não antecede o início', () => {
    for (const l of generateSchedule(base)) {
      expect(l.period_end >= l.period_start).toBe(true)
    }
  })

  it('os períodos não se sobrepõem e avançam no tempo', () => {
    const linhas = generateSchedule(base)
    for (let i = 1; i < linhas.length; i++) {
      expect(linhas[i]!.period_start >= linhas[i - 1]!.period_start).toBe(true)
      expect(linhas[i]!.due_date > linhas[i - 1]!.due_date).toBe(true)
    }
  })

  it('sem pro rata, todas as parcelas têm o valor do ciclo', () => {
    for (const l of generateSchedule(base)) {
      expect(l.amount).toBe(250)
    }
  })

  it('com pro rata, a primeira parcela pode ser proporcional', () => {
    const linhas = generateSchedule({ ...base, use_pro_rata: true })
    expect(linhas[0]!.amount).toBeLessThanOrEqual(250)
  })

  it('cobre o ciclo mensal', () => {
    const linhas = generateSchedule({
      ...base,
      cycle: 'monthly',
      due_day: 10,
      start_date: '2026-01-01',
      end_date: '2026-06-30',
    })
    expect(linhas.length).toBeGreaterThanOrEqual(5)
  })

  it('fim anterior ao início não gera cronograma', () => {
    expect(generateSchedule({ ...base, start_date: '2026-08-29', end_date: '2026-08-01' })).toEqual([])
  })

  it('é determinístico: mesma entrada, mesma saída', () => {
    expect(generateSchedule(base)).toEqual(generateSchedule(base))
  })
})

describe('selectIssuableLines', () => {
  it('emite apenas o que já começou', () => {
    const linhas = [
      line('2026-08-01', 'scheduled'),
      line('2026-08-08', 'scheduled'),
      line('2026-08-12', 'scheduled'),  // começa hoje: entra
      line('2026-08-19', 'scheduled'),  // futuro: fica
    ]
    const emitir = selectIssuableLines(linhas, HOJE)
    expect(emitir).toHaveLength(3)
    expect(emitir.every((l) => l.period_start <= '2026-08-12')).toBe(true)
  })

  it('ignora linha já emitida — é o que torna o job idempotente', () => {
    const linhas = [
      line('2026-08-01', 'issued'),
      line('2026-08-08', 'scheduled'),
    ]
    expect(selectIssuableLines(linhas, HOJE)).toHaveLength(1)
  })

  it('ignora linha cancelada ou substituída', () => {
    const linhas = [
      line('2026-08-01', 'cancelled'),
      line('2026-08-01', 'superseded'),
    ]
    expect(selectIssuableLines(linhas, HOJE)).toHaveLength(0)
  })

  it('lead time antecipa a emissão', () => {
    const linhas = [line('2026-08-19', 'scheduled')]
    expect(selectIssuableLines(linhas, HOJE, 0)).toHaveLength(0)
    expect(selectIssuableLines(linhas, HOJE, 7)).toHaveLength(1)
  })

  it('rodar duas vezes seguidas não muda o conjunto', () => {
    const linhas = [line('2026-08-01', 'scheduled'), line('2026-09-01', 'scheduled')]
    expect(selectIssuableLines(linhas, HOJE)).toEqual(selectIssuableLines(linhas, HOJE))
  })
})

describe('selectAdjustableLines — Princípio 5', () => {
  it('reajusta apenas linhas ainda não emitidas', () => {
    const linhas = [
      line('2026-07-01', 'issued'),
      line('2026-08-01', 'issued'),
      line('2026-09-01', 'scheduled'),
      line('2026-10-01', 'scheduled'),
    ]
    const ajustaveis = selectAdjustableLines(linhas, '2026-01-01')
    expect(ajustaveis).toHaveLength(2)
    expect(ajustaveis.every((l) => l.status === 'scheduled')).toBe(true)
  })

  it('respeita a data de vigência do reajuste', () => {
    const linhas = [
      line('2026-09-01', 'scheduled'),
      line('2026-10-01', 'scheduled'),
    ]
    expect(selectAdjustableLines(linhas, '2026-10-01')).toHaveLength(1)
  })

  it('período já emitido NUNCA é ajustável, mesmo dentro da vigência', () => {
    const linhas = [line('2026-12-01', 'issued')]
    expect(selectAdjustableLines(linhas, '2026-01-01')).toHaveLength(0)
  })
})

describe('contractedBacklog — separa carteira de contas a receber (F-10)', () => {
  it('soma apenas o que ainda não virou documento', () => {
    const linhas = [
      line('2026-07-01', 'issued', 250),
      line('2026-08-01', 'issued', 250),
      line('2026-09-01', 'scheduled', 250),
      line('2026-10-01', 'scheduled', 250),
    ]
    // Carteira contratada = 500. Contas a receber vem de charge_balances,
    // e olha só as duas emitidas.
    expect(contractedBacklog(linhas)).toBe(500)
  })

  it('cronograma inteiramente emitido tem carteira zero', () => {
    expect(contractedBacklog([line('2026-07-01', 'issued', 250)])).toBe(0)
  })

  it('ignora linhas canceladas', () => {
    const linhas = [line('2026-09-01', 'cancelled', 250), line('2026-10-01', 'scheduled', 250)]
    expect(contractedBacklog(linhas)).toBe(250)
  })

  it('contrato de 2 anos semanal: a carteira é grande, mas não é recebível', () => {
    const linhas = Array.from({ length: 104 }, (_, i) =>
      line(`2026-${String((i % 12) + 1).padStart(2, '0')}-01`, 'scheduled', 250),
    )
    // No modelo antigo, esses R$ 26.000 entravam em "Total a receber" no dia
    // da assinatura.
    expect(contractedBacklog(linhas)).toBe(26_000)
  })
})

describe('data impossível não vira cronograma', () => {
  // `<input type="date">` aceita ano de cinco dígitos, e digitar no segmento do
  // ano com algo já preenchido produz esse estado sem esforço. `parseIsoDate`
  // devolvia Invalid Date em silêncio; como comparação com NaN é sempre falsa,
  // o `if (end <= start) return []` não barrava, e saía uma linha com
  // `due_date: "NaN-NaN-NaN"`.
  //
  // Na tela isso derrubava a página inteira (o formatador lança RangeError);
  // na gravação, iria para uma coluna `date`. E como a função RETORNA lixo em
  // vez de lançar, o `try/catch` de quem chama não protegia de nada.
  const base = {
    cycle: 'monthly' as const, due_day: 10, cycle_amount: 750, use_pro_rata: true,
  }

  it('ano de cinco dígitos no início devolve lista vazia', () => {
    expect(generateSchedule({ ...base, start_date: '82026-12-16', end_date: '82027-03-16' })).toEqual([])
  })

  it('ano de cinco dígitos no fim devolve lista vazia', () => {
    expect(generateSchedule({ ...base, start_date: '2026-08-16', end_date: '82026-11-16' })).toEqual([])
  })

  it('data vazia ou sem sentido devolve lista vazia', () => {
    expect(generateSchedule({ ...base, start_date: '', end_date: '2026-11-16' })).toEqual([])
    expect(generateSchedule({ ...base, start_date: '2026-08-16', end_date: 'abc' })).toEqual([])
    expect(generateSchedule({ ...base, start_date: '2026-02-30', end_date: '2026-11-16' })).toEqual([])
  })

  it('nenhuma linha válida carrega data não parseável', () => {
    const linhas = generateSchedule({ ...base, start_date: '2026-08-16', end_date: '2026-11-16' })
    expect(linhas.length).toBeGreaterThan(0)
    for (const l of linhas) {
      expect(l.due_date, 'due_date fora do formato ISO').toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(new Date(`${l.due_date}T00:00:00`).getTime())).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// planPeriodAdjustment — ADR 0035
// ---------------------------------------------------------------------------

const HOJE_ISO = '2026-08-12'

const PARAMS = {
  start_date:   '2026-06-01',
  end_date:     '2026-12-01',
  cycle:        'monthly' as const,
  due_day:      1,
  cycle_amount: 1000,
  use_pro_rata: true,
}

/** Cronograma mensal de 01/06 a 01/12, com as N primeiras já emitidas. */
function cronograma(issuedCount = 0, params = PARAMS): ScheduleLineRow[] {
  return generateSchedule(params).map((l, i) => ({
    id: `linha-${i + 1}`,
    sequence_number: l.sequence_number,
    period_start: l.period_start,
    period_end: l.period_end,
    due_date: l.due_date,
    amount: l.amount,
    status: (i < issuedCount ? 'issued' : 'scheduled') as ScheduleStatus,
  }))
}

function cobranca(
  linha: ScheduleLineRow,
  over: Partial<ScheduleLineChargeRow> = {},
): ScheduleLineChargeRow {
  return {
    schedule_line_id: linha.id,
    charge_id: `cob-${linha.id}`,
    charge_number: linha.sequence_number,
    due_date: linha.due_date,
    total_amount: linha.amount,
    paid_amount: 0,
    status: 'open',
    ...over,
  }
}

function planejar(over: Partial<PeriodAdjustmentInput> = {}): PeriodAdjustmentPlan {
  const lines = over.lines ?? cronograma()
  return planPeriodAdjustment({
    current: PARAMS,
    next: PARAMS,
    contract_type: 'rental',
    lines,
    charges: [],
    effective_from: '',
    today: HOJE_ISO,
    ...over,
  })
}

describe('planPeriodAdjustment — nada emitido', () => {
  it('início muda: só a ponta regenera, o resto é reaproveitado', () => {
    // due_day/cycle/valor/pro-rata ficam iguais — mover só o início muda o
    // PRIMEIRO período (a ponta pro rata desloca), mas 07/01, 08/01... até
    // 12/01 são exatamente os mesmos vencimentos de antes. Regerar tudo do
    // zero recriaria 5 linhas idênticas à toa; o reaproveitamento evita isso.
    const lines = cronograma(0)
    const plano = planejar({ lines, next: { ...PARAMS, start_date: '2026-06-15' } })

    expect(plano.blockers).toEqual([])
    expect(plano.new_lines.length).toBeGreaterThan(0)
    expect(plano.new_lines[0]!.period_start).toBe('2026-06-15')

    // A ponta nova é criada; o restante do cronograma é reaproveitado.
    expect(plano.keep_lines.length).toBeGreaterThan(0)
    expect(plano.supersede_lines.length).toBeLessThan(lines.length)
    expect(plano.cancel_charges).toHaveLength(0)

    // Toda linha reaproveitada continua tendo o MESMO id de antes — não é uma
    // cópia, é a linha original que não foi tocada.
    for (const kept of plano.keep_lines) {
      expect(lines.some((l) => l.id === kept.id)).toBe(true)
    }
  })

  it('a vigência sugerida é o início do contrato — regeneração total', () => {
    const plano = planejar({ next: { ...PARAMS, cycle_amount: 1200 } })
    expect(plano.default_effective_from).toBe('2026-06-01')
    // Sem NENHUMA cobrança paga, não há piso: '' nunca bloqueia (é sempre
    // "menor" que qualquer data ISO real). Bug real corrigido aqui — o piso
    // chegou a usar `next.start_date` como fallback, e como isso é a própria
    // data que o operador está digitando, "Há período já pago até
    // 24/08/2025" aparecia para uma vigência sem nenhum centavo pago.
    expect(plano.min_effective_from).toBe('')
  })

  it('mudar o início para uma data POSTERIOR, sem nada pago, não trava a vigência na data nova', () => {
    // Reprodução do caso real: início 22/08/2025 → 24/08/2025, nenhuma
    // cobrança de ciclo paga (só caução, que já nem chega a este cálculo —
    // é filtrada antes de gerar `charges`). Escolher vigência = início
    // ANTIGO (22/08) para regerar o cronograma inteiro precisa funcionar.
    const plano = planejar({
      next: { ...PARAMS, start_date: '2026-08-24' },
      effective_from: '2026-08-22',
    })
    expect(plano.min_effective_from).toBe('')
    expect(plano.blockers.map((b) => b.code)).not.toContain('EFFECTIVE_BEFORE_PAID')
  })

  it('nenhuma cobrança é cancelada: linha do plano nunca foi documento', () => {
    const plano = planejar({ next: { ...PARAMS, due_day: 20 } })
    expect(plano.cancel_charges).toHaveLength(0)
    expect(plano.totals.cancelled).toBe(0)
  })
})

describe('planPeriodAdjustment — com período já emitido', () => {
  it('a vigência sugerida preserva tudo que já virou documento', () => {
    const lines = cronograma(3)
    const plano = planejar({ lines, charges: lines.slice(0, 3).map((l) => cobranca(l)) })

    expect(plano.default_effective_from).toBe(lines[2]!.period_end)
    expect(plano.cancel_charges).toHaveLength(0)
    // Nenhum dos 6 parâmetros muda neste teste (`next` cai no default =
    // `current`) — as 3 linhas emitidas sobrevivem por estarem antes da
    // fronteira, e as 3 ainda-não-emitidas são reaproveitadas por saírem
    // idênticas ao regenerar. O ajuste inteiro vira um no-op de verdade.
    expect(plano.keep_lines).toHaveLength(6)
    expect(plano.supersede_lines).toHaveLength(0)
    expect(plano.new_lines).toHaveLength(0)
  })

  it('puxar a vigência para trás cancela a cobrança emitida e aberta', () => {
    const lines = cronograma(3)
    const charges = lines.slice(0, 3).map((l) => cobranca(l))
    const plano = planejar({
      lines, charges,
      effective_from: lines[1]!.period_end,
      next: { ...PARAMS, cycle_amount: 1200 },
    })

    expect(plano.blockers).toEqual([])
    expect(plano.keep_lines).toHaveLength(2)
    expect(plano.cancel_charges.map((c) => c.charge_id)).toEqual(['cob-linha-3'])
    expect(plano.totals.cancelled).toBe(charges[2]!.total_amount)
  })

  it('a fronteira barra a vigência que alcançaria período com pagamento parcial', () => {
    // Pagamento parcial conta como dinheiro que entrou: `minEffectiveFrom` puxa
    // a fronteira para o fim desse período, e o impedimento vem de lá — não do
    // laço, que nunca chega a olhar a linha.
    const lines = cronograma(3)
    const charges = [
      cobranca(lines[0]!), cobranca(lines[1]!),
      cobranca(lines[2]!, { paid_amount: 500 }),
    ]
    const plano = planejar({ lines, charges, effective_from: lines[1]!.period_end })

    expect(plano.min_effective_from).toBe(lines[2]!.period_end)
    expect(plano.blockers.map((b) => b.code)).toContain('EFFECTIVE_BEFORE_PAID')
    expect(plano.cancel_charges).toHaveLength(0)
    expect(plano.new_lines).toHaveLength(0)
  })

  it('cobrança baixada por inadimplência que sai da vigência é impedimento', () => {
    // Aqui a linha não cai pela fronteira (a vigência está no mínimo permitido),
    // e sim porque o novo início a deixa fora da janela do contrato.
    const lines = cronograma(3)
    const charges = [
      cobranca(lines[0]!), cobranca(lines[1]!),
      cobranca(lines[2]!, { status: 'written_off' }),
    ]
    const plano = planejar({
      lines, charges,
      effective_from: lines[2]!.period_end,
      next: { ...PARAMS, start_date: lines[2]!.period_end },
    })

    expect(plano.blockers.map((b) => b.code)).toContain('WRITTEN_OFF_IN_RANGE')
    expect(plano.new_lines).toHaveLength(0)
  })

  it('a vigência não pode ser anterior ao fim do último período pago', () => {
    const lines = cronograma(3)
    const charges = [
      cobranca(lines[0]!), cobranca(lines[1]!, { paid_amount: 1000, status: 'paid' }),
      cobranca(lines[2]!),
    ]
    const plano = planejar({ lines, charges, effective_from: '2026-06-01' })

    expect(plano.min_effective_from).toBe(lines[1]!.period_end)
    expect(plano.blockers.map((b) => b.code)).toContain('EFFECTIVE_BEFORE_PAID')
  })

  it('cobrança já cancelada não entra na lista de cancelamentos', () => {
    const lines = cronograma(3)
    const charges = lines.slice(0, 3).map((l) => cobranca(l, { status: 'cancelled' }))
    const plano = planejar({ lines, charges, effective_from: lines[1]!.period_end })

    expect(plano.cancel_charges).toHaveLength(0)
    // lines[2] é `issued` (mesmo com a cobrança cancelada) e por isso NUNCA é
    // reaproveitada — mantê-la travaria o período em status 'issued' apontando
    // pra um documento morto, e `issue_due_charges` só emite linha
    // 'scheduled'. Ela é riscada e uma linha nova ocupa o lugar. As linhas
    // seguintes (nunca emitidas) saem idênticas ao regenerar e são
    // reaproveitadas.
    expect(plano.supersede_lines).toHaveLength(1)
    expect(plano.supersede_lines[0]!.id).toBe(lines[2]!.id)
    expect(plano.new_lines).toHaveLength(1)
    // As 2 que sobreviveram por estarem antes da fronteira (lines[0],[1]) +
    // as 3 depois dela que saíram idênticas ao regenerar (lines[3],[4],[5]).
    // Só lines[2] — a `issued` com cobrança cancelada — fica de fora.
    expect(plano.keep_lines).toHaveLength(lines.length - 1)
  })

  it('mover o início para depois de um período pago é impedimento, não silêncio', () => {
    const lines = cronograma(2)
    const charges = lines.slice(0, 2).map((l) => cobranca(l, { paid_amount: l.amount, status: 'paid' }))
    const plano = planejar({
      lines, charges,
      effective_from: lines[1]!.period_end,
      next: { ...PARAMS, start_date: '2026-09-01' },
    })

    expect(plano.blockers.map((b) => b.code)).toContain('PAID_CHARGE_IN_RANGE')
  })
})

describe('planPeriodAdjustment — continuidade do cronograma', () => {
  it('a numeração continua de onde parou: a UNIQUE proíbe reuso', () => {
    const lines = cronograma(2)
    const maxAtual = Math.max(...lines.map((l) => l.sequence_number))
    const plano = planejar({
      lines,
      charges: lines.slice(0, 2).map((l) => cobranca(l)),
      next: { ...PARAMS, cycle_amount: 1200 },
    })

    expect(plano.new_lines[0]!.sequence_number).toBe(maxAtual + 1)
    const nums = plano.new_lines.map((l) => l.sequence_number)
    expect(new Set(nums).size).toBe(nums.length)
    expect(Math.min(...nums)).toBeGreaterThan(maxAtual)
  })

  it('não há buraco nem sobreposição entre o mantido e o criado', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, due_day: 15 },
    })

    const ultimoMantido = plano.keep_lines[plano.keep_lines.length - 1]!
    expect(plano.new_lines[0]!.period_start).toBe(ultimoMantido.period_end)
  })

  it('linha já substituída ou cancelada é inerte: não é tocada de novo', () => {
    const lines = cronograma(0).map((l, i) =>
      i === 0 ? { ...l, status: 'superseded' as ScheduleStatus } : l,
    )
    const plano = planejar({ lines, next: { ...PARAMS, cycle_amount: 1200 } })
    expect(plano.supersede_lines.some((l) => l.id === 'linha-1')).toBe(false)
  })
})

describe('planPeriodAdjustment — impedimentos de forma', () => {
  it('fim anterior ao início', () => {
    const plano = planejar({ next: { ...PARAMS, end_date: '2026-05-01' } })
    expect(plano.blockers.map((b) => b.code)).toContain('END_BEFORE_START')
  })

  it('data impossível não vira plano vazio silencioso', () => {
    const plano = planejar({ next: { ...PARAMS, start_date: '82026-06-01' } })
    expect(plano.blockers.map((b) => b.code)).toContain('INVALID_DATE')
    expect(plano.new_lines).toHaveLength(0)
  })

  it('encurtar até não sobrar parcela é encerramento, não ajuste', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, end_date: lines[2]!.period_end },
    })
    expect(plano.blockers.map((b) => b.code)).toContain('NOTHING_LEFT')
  })
})

describe('planPeriodAdjustment — avisos', () => {
  it('parcela cujo período já começou é marcada como emissão imediata', () => {
    const plano = planejar({
      lines: cronograma(0),
      next: { ...PARAMS, due_day: 20 },
      today: HOJE_ISO,
    })
    const imediatas = plano.new_lines.filter((l) => l.emits_now)
    expect(imediatas.length).toBeGreaterThan(0)
    expect(plano.warnings.map((w) => w.code)).toContain('EMITS_NOW')
  })

  it('parcela com vencimento no passado avisa que nasce vencida', () => {
    const plano = planejar({ lines: cronograma(0), next: { ...PARAMS, cycle_amount: 1200 } })
    expect(plano.new_lines.some((l) => l.born_overdue)).toBe(true)
    expect(plano.warnings.map((w) => w.code)).toContain('BORN_OVERDUE')
  })

  it('antecipar o início deixa um trecho sem parcela e avisa', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, start_date: '2026-05-01' },
    })
    expect(plano.warnings.map((w) => w.code)).toContain('START_BEFORE_ISSUED')
  })

  it('mudar de mensal para semanal avisa que o valor passa a ser de outro período', () => {
    const plano = planejar({
      lines: cronograma(0),
      next: { ...PARAMS, cycle: 'weekly', due_day: 1 },
    })
    expect(plano.warnings.map((w) => w.code)).toContain('CYCLE_CHANGED')
    expect(plano.new_lines.length).toBeGreaterThan(cronograma(0).length)
  })

  it('contrato assinado anexado + datas alteradas vira aviso de aditivo', () => {
    const plano = planejar({
      next: { ...PARAMS, end_date: '2027-06-01' },
      has_signed_contract: true,
    })
    expect(plano.warnings.map((w) => w.code)).toContain('SIGNED_CONTRACT_DIVERGES')
  })

  it('compra programada: mover o início move a data de transferência', () => {
    const plano = planejar({
      contract_type: 'rent_to_own',
      next: { ...PARAMS, start_date: '2026-07-01' },
    })
    expect(plano.warnings.map((w) => w.code)).toContain('RENT_TO_OWN_TRANSFER_MOVED')
  })

  it('sem mudança de data, nenhum aviso de janela', () => {
    const plano = planejar({ next: { ...PARAMS, cycle_amount: 1200 } })
    expect(plano.warnings.map((w) => w.code)).not.toContain('PERIOD_WINDOW_CHANGED')
    expect(plano.changed_fields).toEqual(['cycle_amount'])
  })
})

describe('planPeriodAdjustment — totais', () => {
  it('delta é o quanto o contrato passa a valer a mais', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, cycle_amount: 2000 },
    })

    const substituido = plano.supersede_lines
      .filter((l) => !l.was_issued)
      .reduce((s, l) => s + l.amount, 0)
    const criado = plano.new_lines.reduce((s, l) => s + l.amount, 0)

    expect(plano.totals.superseded).toBeCloseTo(substituido, 2)
    expect(plano.totals.created).toBeCloseTo(criado, 2)
    expect(plano.totals.delta).toBeCloseTo(criado - substituido - plano.totals.cancelled, 2)
  })

  it('é determinístico: mesma entrada, mesma saída', () => {
    const lines = cronograma(2)
    const args = { lines, charges: lines.slice(0, 2).map((l) => cobranca(l)), next: { ...PARAMS, due_day: 5 } }
    expect(planejar(args)).toEqual(planejar(args))
  })
})

describe('planPeriodAdjustment — um veículo, uma locação (ADR 0036)', () => {
  it('antecipar o início para antes da devolução anterior é impedimento', () => {
    const plano = planejar({
      next: { ...PARAMS, start_date: '2026-05-01' },
      other_rentals: [{ start_date: '2026-03-01', end_date: '2026-05-20' }],
    })
    expect(plano.blockers.map((b) => b.code)).toContain('VEHICLE_PERIOD_OVERLAP')
    expect(plano.blockers[0]!.message).toContain('20/05/2026')
    expect(plano.new_lines).toHaveLength(0)
  })

  it('começar no dia em que a anterior devolveu é permitido', () => {
    const plano = planejar({
      next: { ...PARAMS, start_date: '2026-05-20' },
      other_rentals: [{ start_date: '2026-03-01', end_date: '2026-05-20' }],
    })
    expect(plano.blockers.map((b) => b.code)).not.toContain('VEHICLE_PERIOD_OVERLAP')
  })

  it('sem outra locação no veículo, nada muda', () => {
    const plano = planejar({ next: { ...PARAMS, start_date: '2026-05-01' }, other_rentals: [] })
    expect(plano.blockers.map((b) => b.code)).not.toContain('VEHICLE_PERIOD_OVERLAP')
  })
})

describe('planPeriodAdjustment — reaproveitamento de linha idêntica', () => {
  it('só a data muda: reaproveita o que não foi tocado, cria só a ponta nova', () => {
    // Estender o fim (renovação) é o caso mais comum: ciclo/dia/valor/pro-rata
    // continuam iguais, só end_date avança. Todo o cronograma já existente
    // (inclusive além da fronteira padrão) deveria sobreviver intacto.
    const lines = cronograma(3) // 3 emitidas, 3 no plano
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, end_date: '2027-06-01' },
    })

    expect(plano.blockers).toEqual([])
    // As 6 linhas antigas inteiras sobrevivem (3 emitidas + 3 reaproveitadas).
    expect(plano.keep_lines).toHaveLength(6)
    expect(plano.supersede_lines).toHaveLength(0)
    expect(plano.cancel_charges).toHaveLength(0)
    // E só a extensão de fato nova aparece em new_lines.
    expect(plano.new_lines.length).toBeGreaterThan(0)
    expect(plano.new_lines[0]!.period_start).toBe(lines[5]!.period_end)
  })

  it('mudar o valor NÃO reaproveita — cada linha do meio sai com o valor novo', () => {
    const lines = cronograma(0)
    const plano = planejar({ lines, next: { ...PARAMS, cycle_amount: 1200 } })

    // Ciclo cheio de 1000 nunca bate com o regenerado de 1200: nada reaproveita.
    expect(plano.keep_lines).toHaveLength(0)
    expect(plano.supersede_lines).toHaveLength(lines.length)
    expect(plano.new_lines.every((l) => l.amount === 1200 || l.amount < 1200)).toBe(true)
  })

  it('mudar o dia de vencimento NÃO reaproveita — as fronteiras dos períodos mudam todas', () => {
    const lines = cronograma(0)
    const plano = planejar({ lines, next: { ...PARAMS, due_day: 15 } })

    expect(plano.keep_lines).toHaveLength(0)
    expect(plano.supersede_lines).toHaveLength(lines.length)
  })

  it('linha reaproveitada preserva id e sequence_number originais — não é uma cópia', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, end_date: '2027-06-01' },
    })

    const reaproveitada = plano.keep_lines.find((l) => l.id === lines[4]!.id)
    expect(reaproveitada).toBeDefined()
    expect(reaproveitada!.sequence_number).toBe(lines[4]!.sequence_number)
    expect(reaproveitada!.period_start).toBe(lines[4]!.period_start)
    expect(reaproveitada!.amount).toBe(lines[4]!.amount)
  })

  it('linha issued nunca é reaproveitada, mesmo com valor idêntico — vira new_lines com status scheduled', () => {
    // Uma linha `issued` cuja cobrança foi cancelada NÃO pode ficar "mantida":
    // `issue_due_charges` só emite linha `scheduled`, e mantê-la travaria o
    // período em `issued` apontando pra um documento morto — nunca mais
    // seria cobrado automaticamente.
    const lines = cronograma(1)
    const charges = [cobranca(lines[0]!, { status: 'cancelled' })]
    const plano = planejar({ lines, charges, effective_from: PARAMS.start_date })

    expect(plano.keep_lines.some((l) => l.id === lines[0]!.id)).toBe(false)
    expect(plano.supersede_lines.map((l) => l.id)).toContain(lines[0]!.id)
    const recriada = plano.new_lines.find((l) => l.period_start === lines[0]!.period_start)
    expect(recriada).toBeDefined()
    expect(recriada!.amount).toBe(lines[0]!.amount)
  })

  it('reaproveitar não altera os totais: substituído/criado só contam o que de fato mudou', () => {
    const lines = cronograma(3)
    const plano = planejar({
      lines,
      charges: lines.slice(0, 3).map((l) => cobranca(l)),
      next: { ...PARAMS, end_date: '2027-06-01' },
    })

    // Nada do cronograma existente foi substituído — só a extensão é criada.
    expect(plano.totals.superseded).toBe(0)
    expect(plano.totals.created).toBe(plano.new_lines.reduce((s, l) => s + l.amount, 0))
    expect(plano.totals.delta).toBeCloseTo(plano.totals.created, 2)
  })
})
