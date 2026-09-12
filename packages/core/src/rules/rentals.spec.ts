import { describe, it, expect } from 'vitest'
import {
  generateCycleCharges,
  calculateProRataValue,
  isRentalTerminationWithinMinimum,
  calculateMinimumEndDateForRental,
  getEarlyTerminationImpact,
  calculateAdjustedBillingAmount,
  previewRentalAdjustment,
  computeScheduleRegenerationCutoff,
  previewScheduleRegeneration,
  RENTAL_MINIMUM_DURATION,
  rentalPeriodsOverlap,
  displayPeriodEnd,
} from './rentals'
import { RentalSchema, RenewRentalSchema, TerminateRentalSchema } from '../schemas/rentals'
import type { CycleCharge } from './rentals'

// ---------------------------------------------------------------------------
// calculateProRataValue
// ---------------------------------------------------------------------------

describe('calculateProRataValue', () => {
  it('retorna valor proporcional (3 de 7 dias)', () => {
    expect(calculateProRataValue(350, 3, 7)).toBeCloseTo(150, 2)
  })

  it('retorna valor cheio quando dias === cycleDays', () => {
    expect(calculateProRataValue(200, 30, 30)).toBeCloseTo(200, 2)
  })

  it('arredonda para 2 casas decimais', () => {
    const result = calculateProRataValue(100, 1, 3)
    expect(result).toBeCloseTo(33.33, 2)
  })
})

// ---------------------------------------------------------------------------
// generateCycleCharges — ciclo mensal
// ---------------------------------------------------------------------------

describe('generateCycleCharges — mensal', () => {
  it('gera 3 cobranças mensais sem pro rata', () => {
    const charges = generateCycleCharges({
      start_date:   '2025-01-01',
      end_date:     '2025-04-01',
      cycle:        'monthly',
      due_day:      10,
      cycle_amount: 600,
      use_pro_rata: false,
    })
    expect(charges).toHaveLength(3)
    expect(charges.every((c) => c.amount === 600)).toBe(true)
    expect(charges.every((c) => c.billing_type === 'cycle')).toBe(true)
  })

  it('vencimentos caem no dia correto do mês', () => {
    const charges = generateCycleCharges({
      start_date:   '2025-01-01',
      end_date:     '2025-04-01',
      cycle:        'monthly',
      due_day:      15,
      cycle_amount: 600,
      use_pro_rata: false,
    })
    expect(charges.map((c) => c.due_date)).toEqual(['2025-01-15', '2025-02-15', '2025-03-15'])
  })

  it('aplica pro rata na primeira cobrança quando início != vencimento', () => {
    const charges = generateCycleCharges({
      start_date:   '2025-01-05',  // 5 dias depois do início
      end_date:     '2025-03-10',
      cycle:        'monthly',
      due_day:      10,
      cycle_amount: 300,
      use_pro_rata: true,
    })
    // Primeira cobrança (10/jan) deve ser pro rata: 5 dias / 31 dias do ciclo
    expect(charges[0]?.due_date).toBe('2025-01-10')
    expect(charges[0]?.amount).toBeLessThan(300)
    // Intermediária deve ser integral
    expect(charges[1]?.amount).toBe(300)
  })

  it('não perde ciclo quando há ponta no início E no fim', () => {
    // Regressão: com ponta nos dois lados, os períodos são um a mais que os
    // vencimentos. O laço antigo emitia uma cobrança por vencimento e dava à
    // última o valor da ponta final — o ciclo cheio que ela deveria representar
    // desaparecia. 01/09→01/12 a R$600 saía com 3 cobranças e R$1.200.
    const charges = generateCycleCharges({
      start_date:   '2026-09-01',  // antes do dia 10
      end_date:     '2026-12-01',  // depois do último dia 10
      cycle:        'monthly',
      due_day:      10,
      cycle_amount: 600,
      use_pro_rata: true,
    })

    expect(charges).toHaveLength(4)

    const total = charges.reduce((s, c) => s + c.amount, 0)
    expect(total).toBe(1800)

    // Dois ciclos cheios no meio, pontas proporcionais nas bordas.
    expect(charges.map((c) => c.amount)).toEqual([180, 600, 600, 420])

    // E os períodos cobrem a locação inteira, sem buraco entre eles.
    expect(charges[0]?.period_start).toBe('2026-09-01')
    expect(charges[charges.length - 1]?.period_end).toBe('2026-12-01')
    for (let i = 1; i < charges.length; i++) {
      expect(charges[i]?.period_start).toBe(charges[i - 1]?.period_end)
    }
  })

  it('aplica pro rata na última cobrança quando fim != vencimento', () => {
    const charges = generateCycleCharges({
      start_date:   '2025-01-10',
      end_date:     '2025-03-05',  // antes do dia 10
      cycle:        'monthly',
      due_day:      10,
      cycle_amount: 300,
      use_pro_rata: true,
    })
    const last = charges[charges.length - 1]
    // Última cobrança deve ser pro rata (cobrir apenas até 05/mar)
    expect(last?.amount).toBeLessThan(300)
  })

  it('retorna uma cobrança quando não há vencimento no período', () => {
    // Jan 11 a Jan 25 — o próximo dia 10 é Feb 10, fora do período
    const charges = generateCycleCharges({
      start_date:   '2025-01-11',
      end_date:     '2025-01-25',
      cycle:        'monthly',
      due_day:      10,
      cycle_amount: 300,
      use_pro_rata: true,
    })
    expect(charges).toHaveLength(1)
    expect(charges[0]?.amount).toBeLessThan(300)
  })
})

// ---------------------------------------------------------------------------
// generateCycleCharges — ciclo semanal
// ---------------------------------------------------------------------------

describe('generateCycleCharges — semanal', () => {
  // Estes dois casos contavam VENCIMENTOS ("4 segundas dentro do período"),
  // não PERÍODOS. O contrato começa numa segunda e vence na segunda, então o
  // primeiro vencimento coincide com o início: a cobrança que ele gerava
  // cobria de 06/01 a 06/01 — zero dia — pelo valor cheio. Eram R$ 400 por
  // 3 semanas de uso. A unidade é o período entre dois vencimentos, e é assim
  // que o ramo com pro rata sempre contou.

  it('gera cobranças semanais sem pro rata', () => {
    // due_day 1 = Segunda. Início: 2025-01-06 (Seg), fim: 2025-01-28 (Ter)
    const charges = generateCycleCharges({
      start_date:   '2025-01-06',
      end_date:     '2025-01-28',
      cycle:        'weekly',
      due_day:      1,  // segunda
      cycle_amount: 100,
      use_pro_rata: false,
    })
    // Períodos fechados: 06→13, 13→20, 20→27. A ponta 27→28 é ignorada (RN-011).
    expect(charges).toHaveLength(3)
    expect(charges.every((c) => c.amount === 100)).toBe(true)
    expect(charges.every((c) => c.period_end > c.period_start)).toBe(true)
  })

  it('vencimentos são todas as segundas-feiras', () => {
    const charges = generateCycleCharges({
      start_date:   '2025-01-06',
      end_date:     '2025-01-28',
      cycle:        'weekly',
      due_day:      1,
      cycle_amount: 100,
      use_pro_rata: false,
    })
    const expectedDates = ['2025-01-13', '2025-01-20', '2025-01-27']
    expect(charges.map((c) => c.due_date)).toEqual(expectedDates)
  })

  it('os dois ramos cobram os mesmos ciclos cheios', () => {
    const base = {
      start_date: '2025-01-06', end_date: '2025-01-28',
      cycle: 'weekly' as const, due_day: 1, cycle_amount: 100,
    }
    const semProRata = generateCycleCharges({ ...base, use_pro_rata: false })
    const comProRata = generateCycleCharges({ ...base, use_pro_rata: true })

    // A diferença entre os dois é só a ponta final proporcional — antes era
    // também uma cobrança inteira a mais no começo.
    expect(comProRata.filter((c) => c.amount === 100)).toHaveLength(semProRata.length)
  })

  it('due_day 7 (domingo) funciona corretamente', () => {
    // due_day 7 = Domingo
    const charges = generateCycleCharges({
      start_date:   '2025-01-05',  // Domingo
      end_date:     '2025-01-20',
      cycle:        'weekly',
      due_day:      7,
      cycle_amount: 150,
      use_pro_rata: false,
    })
    // Domingos: 05, 12, 19 — todos dentro do período
    expect(charges.every((c) => c.amount === 150)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isRentalTerminationWithinMinimum
// ---------------------------------------------------------------------------

describe('isRentalTerminationWithinMinimum', () => {
  it('rental: retorna true se dentro de 3 meses', () => {
    const startDate = '2025-01-01'
    const today = new Date('2025-02-15')  // 45 dias após início
    expect(isRentalTerminationWithinMinimum({ start_date: startDate, rental_type: 'rental' }, today)).toBe(true)
  })

  it('rental: retorna false se além de 3 meses', () => {
    const startDate = '2025-01-01'
    const today = new Date('2025-04-15')  // > 3 meses
    expect(isRentalTerminationWithinMinimum({ start_date: startDate, rental_type: 'rental' }, today)).toBe(false)
  })

  it('rent_to_own: retorna true se dentro de 2 anos', () => {
    const startDate = '2024-01-01'
    const today = new Date('2025-06-01')  // ~17 meses
    expect(isRentalTerminationWithinMinimum({ start_date: startDate, rental_type: 'rent_to_own' }, today)).toBe(true)
  })

  it('rent_to_own: retorna false se além de 2 anos', () => {
    const startDate = '2023-01-01'
    const today = new Date('2025-02-01')  // >2 anos
    expect(isRentalTerminationWithinMinimum({ start_date: startDate, rental_type: 'rent_to_own' }, today)).toBe(false)
  })

  it('rental_type padrão é rental', () => {
    const startDate = '2025-01-01'
    const today = new Date('2025-02-15')
    expect(isRentalTerminationWithinMinimum({ start_date: startDate }, today)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// calculateMinimumEndDateForRental
// ---------------------------------------------------------------------------

describe('calculateMinimumEndDateForRental', () => {
  it('rental: data mínima é 3 meses após início', () => {
    const minDate = calculateMinimumEndDateForRental('2025-01-01', 'rental')
    expect(minDate.toISOString().slice(0, 10)).toBe('2025-04-01')
  })

  it('rent_to_own: data mínima é 2 anos após início', () => {
    const minDate = calculateMinimumEndDateForRental('2025-01-01', 'rent_to_own')
    expect(minDate.toISOString().slice(0, 10)).toBe('2027-01-01')
  })

  it('RENTAL_MINIMUM_DURATION é coerente com os cálculos', () => {
    expect(RENTAL_MINIMUM_DURATION.rental.months).toBe(3)
    expect(RENTAL_MINIMUM_DURATION.rent_to_own.years).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getEarlyTerminationImpact
// ---------------------------------------------------------------------------

describe('getEarlyTerminationImpact', () => {
  const charges = [
    { due_date: '2025-01-10', status: 'overdue' },
    { due_date: '2025-02-10', status: 'pending' },
    { due_date: '2025-03-10', status: 'pending' },
    { due_date: '2025-04-10', status: 'pending' },
  ]

  it('conta cobranças vencidas e futuras corretamente', () => {
    const today = new Date('2025-02-15')
    const impact = getEarlyTerminationImpact(charges, today, '2025-01-01', 'rental')
    // jan/10 e fev/10 são passadas; mar/10 e abr/10 são futuras
    expect(impact.overdue_count).toBe(2)
    expect(impact.future_count).toBe(2)
  })

  it('within_minimum = true se dentro do período mínimo (rental)', () => {
    const today = new Date('2025-02-15')  // 45 dias, < 3 meses
    const impact = getEarlyTerminationImpact(charges, today, '2025-01-01', 'rental')
    expect(impact.within_minimum).toBe(true)
  })

  it('fine_amount > 0 quando within_minimum = true', () => {
    const today = new Date('2025-02-15')
    const impact = getEarlyTerminationImpact(charges, today, '2025-01-01', 'rental')
    expect(impact.fine_amount).toBeGreaterThan(0)
  })

  it('fine_amount = 0 quando beyond minimum period', () => {
    const today = new Date('2025-05-01')  // > 3 meses
    const impact = getEarlyTerminationImpact(charges, today, '2025-01-01', 'rental')
    expect(impact.fine_amount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// RentalSchema
// ---------------------------------------------------------------------------

describe('RentalSchema', () => {
  const validRental = {
    vehicle_id:  '550e8400-e29b-41d4-a716-446655440000',
    customer_id:    '550e8400-e29b-41d4-a716-446655440001',
    contract_type:  'rental',
    cycle:          'monthly',
    due_day:        10,
    cycle_amount:   600,
    start_date:     '2025-01-01',
    end_date:       '2025-12-01',
    use_pro_rata:   true,
  }

  it('valida dados corretos', () => {
    const result = RentalSchema.safeParse(validRental)
    expect(result.success).toBe(true)
  })

  it('rejeita end_date anterior a start_date', () => {
    const result = RentalSchema.safeParse({ ...validRental, end_date: '2024-12-01' })
    expect(result.success).toBe(false)
  })

  it('rejeita due_day fora de [1, 31]', () => {
    const result = RentalSchema.safeParse({ ...validRental, due_day: 0 })
    expect(result.success).toBe(false)
  })

  it('rejeita cycle_amount negativo', () => {
    const result = RentalSchema.safeParse({ ...validRental, cycle_amount: -100 })
    expect(result.success).toBe(false)
  })

  it('rejeita contract_type inválido', () => {
    const result = RentalSchema.safeParse({ ...validRental, contract_type: 'loyalty' })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// calculateAdjustedBillingAmount / previewRentalAdjustment (RF-027–031, RN-027)
// ---------------------------------------------------------------------------

describe('calculateAdjustedBillingAmount', () => {
  it('escala cobrança de valor cheio 1:1 com o novo ciclo', () => {
    expect(calculateAdjustedBillingAmount(500, 500, 600)).toBeCloseTo(600, 2)
  })

  it('escala cobrança pro rata mantendo a mesma fração (RN-027)', () => {
    // 300 de um ciclo de 500 = 60% → deve virar 60% do novo valor (600)
    expect(calculateAdjustedBillingAmount(300, 500, 600)).toBeCloseTo(360, 2)
  })

  it('arredonda para 2 casas decimais', () => {
    expect(calculateAdjustedBillingAmount(100, 300, 200)).toBeCloseTo(66.67, 2)
  })

  it('retorna o novo valor cheio quando previousCycleAmount é zero ou negativo (defensivo)', () => {
    expect(calculateAdjustedBillingAmount(100, 0, 600)).toBe(600)
  })
})

describe('previewRentalAdjustment', () => {
  it('soma corretamente cobranças de valor cheio e pro rata', () => {
    const billings = [{ original_amount: 500 }, { original_amount: 500 }, { original_amount: 300 }]
    const result = previewRentalAdjustment(billings, 500, 600)
    expect(result.affected_count).toBe(3)
    expect(result.total_previous).toBeCloseTo(1300, 2)
    expect(result.total_new).toBeCloseTo(600 + 600 + 360, 2)
  })

  it('retorna zeros quando não há cobranças pendentes (F11 FA)', () => {
    const result = previewRentalAdjustment([], 500, 600)
    expect(result).toEqual({ affected_count: 0, total_previous: 0, total_new: 0 })
  })
})

// ---------------------------------------------------------------------------
// computeScheduleRegenerationCutoff / previewScheduleRegeneration
// ---------------------------------------------------------------------------

describe('computeScheduleRegenerationCutoff', () => {
  const today = new Date(2026, 6, 24) // 24/07/2026

  it('retorna a due_date mais recente entre pagas e pendentes já vencidas', () => {
    const billings = [
      { due_date: '2026-04-10', status: 'paid' },
      { due_date: '2026-05-10', status: 'pending' }, // vencida na prática
      { due_date: '2026-06-10', status: 'pending' }, // vencida na prática
      { due_date: '2026-07-10', status: 'pending' }, // vencida na prática (< 24/07)
      { due_date: '2026-08-10', status: 'pending' }, // ainda não venceu — livre pra regerar
    ]
    expect(computeScheduleRegenerationCutoff(billings, today)).toBe('2026-07-10')
  })

  it('retorna null quando nenhuma cobrança está travada', () => {
    const billings = [
      { due_date: '2026-08-10', status: 'pending' },
      { due_date: '2026-09-10', status: 'pending' },
    ]
    expect(computeScheduleRegenerationCutoff(billings, today)).toBeNull()
  })

  it('retorna null para lista vazia', () => {
    expect(computeScheduleRegenerationCutoff([], today)).toBeNull()
  })

  it('considera cancelada/prejuízo como travada mesmo com due_date futura', () => {
    const billings = [
      { due_date: '2026-12-10', status: 'cancelled' },
      { due_date: '2026-08-10', status: 'pending' },
    ]
    expect(computeScheduleRegenerationCutoff(billings, today)).toBe('2026-12-10')
  })
})

describe('previewScheduleRegeneration', () => {
  it('soma desconto perdido e crédito a estornar das cobranças canceladas', () => {
    const cancelled = [
      { discount_amount: 50, credit_applied: null },
      { discount_amount: null, credit_applied: 100 },
      { discount_amount: null, credit_applied: null },
    ]
    const newCharges = [{ amount: 700 }, { amount: 700 }]
    const result = previewScheduleRegeneration(cancelled, newCharges)
    expect(result).toEqual({
      cancelled_count: 3,
      discount_lost_total: 50,
      credit_to_restore_total: 100,
      new_charges_count: 2,
      new_charges_total: 1400,
    })
  })

  it('retorna zeros quando não há cobranças canceladas nem novas', () => {
    expect(previewScheduleRegeneration([], [])).toEqual({
      cancelled_count: 0,
      discount_lost_total: 0,
      credit_to_restore_total: 0,
      new_charges_count: 0,
      new_charges_total: 0,
    })
  })
})

describe('generateCycleCharges — contrato que começa no dia do vencimento', () => {
  // Sem pro rata, `firstDueDate` devolve o próprio início quando ele cai no
  // dia de vencimento, e a primeira volta do laço montava um período de
  // duração zero cobrando o ciclo inteiro. Arranjo trivial e caro: "vence todo
  // dia 10, o contrato começou dia 10".
  const base = {
    start_date: '2026-10-10',
    end_date:   '2027-03-10',
    cycle:      'monthly' as const,
    due_day:    10,
    cycle_amount: 600,
  }

  it('sem pro rata: não gera cobrança para período de duração zero', () => {
    const charges = generateCycleCharges({ ...base, use_pro_rata: false })
    expect(charges).toHaveLength(5)
    expect(charges.reduce((s, c) => s + c.amount, 0)).toBe(3000)
    for (const c of charges) expect(c.period_end > c.period_start).toBe(true)
  })

  it('com pro rata chega ao mesmo total — os dois ramos concordam', () => {
    const semProRata = generateCycleCharges({ ...base, use_pro_rata: false })
    const comProRata = generateCycleCharges({ ...base, use_pro_rata: true })
    expect(semProRata.reduce((s, c) => s + c.amount, 0))
      .toBe(comProRata.reduce((s, c) => s + c.amount, 0))
  })

  it('início FORA do dia de vencimento segue cobrando o ciclo cheio na ponta (RN-011)', () => {
    const charges = generateCycleCharges({ ...base, start_date: '2026-10-05', use_pro_rata: false })
    expect(charges[0]!.period_start).toBe('2026-10-05')
    expect(charges[0]!.period_end).toBe('2026-10-10')
    expect(charges[0]!.amount).toBe(600)
  })
})

describe('rentalPeriodsOverlap — mesma semântica do trigger (ADR 0036)', () => {
  it('períodos que se cruzam', () => {
    expect(rentalPeriodsOverlap('2026-06-01', '2026-07-01', '2026-06-15', '2026-08-01')).toBe(true)
  })

  it('devolver e retirar no mesmo dia NÃO é sobreposição', () => {
    expect(rentalPeriodsOverlap('2026-06-01', '2026-07-01', '2026-07-01', '2026-08-01')).toBe(false)
    expect(rentalPeriodsOverlap('2026-07-01', '2026-08-01', '2026-06-01', '2026-07-01')).toBe(false)
  })

  it('contrato sem data de fim ocupa tudo dali em diante', () => {
    expect(rentalPeriodsOverlap('2026-06-01', null, '2027-01-01', '2027-02-01')).toBe(true)
    expect(rentalPeriodsOverlap('2026-06-01', null, '2026-01-01', '2026-06-01')).toBe(false)
  })

  it('locação encerrada antes de começar é período vazio', () => {
    // terminate_rental grava a data de encerramento como fim — que pode ser
    // anterior ao início de um contrato futuro cancelado antes da retirada.
    expect(rentalPeriodsOverlap('2026-09-01', '2026-08-20', '2026-08-01', '2026-12-01')).toBe(false)
  })

  it('é simétrica', () => {
    const a = ['2026-06-01', '2026-07-01'] as const
    const b = ['2026-06-20', '2026-09-01'] as const
    expect(rentalPeriodsOverlap(a[0], a[1], b[0], b[1])).toBe(rentalPeriodsOverlap(b[0], b[1], a[0], a[1]))
  })
})

describe('displayPeriodEnd — period_end é fronteira exclusiva, não dia de uso', () => {
  it('ciclo semanal 23/12 a 30/12: o último dia de uso é 29/12', () => {
    expect(displayPeriodEnd('2026-12-30')).toBe('2026-12-29')
  })

  it('atravessa virada de mês', () => {
    expect(displayPeriodEnd('2027-01-01')).toBe('2026-12-31')
  })

  it('atravessa virada de ano', () => {
    expect(displayPeriodEnd('2027-01-01')).not.toBe('2027-01-01')
  })
})

describe('makeCycleDescription (via generateCycleCharges) — semanal mostra o último dia de USO', () => {
  it('ciclo cheio 23/12 a 30/12 descreve "23/12 a 29/12", não "23/12 a 30/12"', () => {
    // Exemplo real que motivou a correção: vencimento 30/12 não é dia cobrado.
    const charges = generateCycleCharges({
      start_date: '2026-12-16', end_date: '2027-01-13',
      cycle: 'weekly', due_day: 3, // quarta-feira
      cycle_amount: 350, use_pro_rata: false,
    })
    const alvo = charges.find((c) => c.period_start === '2026-12-23' && c.period_end === '2026-12-30')
    expect(alvo, 'período 23/12→30/12 não apareceu no cronograma').toBeDefined()
    expect(alvo!.description).toBe('Aluguel semanal — 23/12 a 29/12')
    expect(alvo!.description).not.toContain('a 30/12')
    // O vencimento em si não muda — só o texto do período.
    expect(alvo!.due_date).toBe('2026-12-30')
  })
})
