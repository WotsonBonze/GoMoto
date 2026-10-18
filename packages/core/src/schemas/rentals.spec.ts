import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { RentalSchema, TerminateRentalSchema, ReturnRemainingDepositSchema } from './rentals'

const base = {
  vehicle_id: randomUUID(),
  customer_id: randomUUID(),
  cycle: 'monthly' as const,
  due_day: 10,
  cycle_amount: 500,
  start_date: '2026-01-01',
  end_date: '2026-12-01',
  km_initial: 12000,
}

describe('RentalSchema — vínculo de Vistoria Periódica (RN-005)', () => {
  it('perfil periódico sem frequência → erro no campo periodic_inspection_frequency_days', () => {
    const result = RentalSchema.safeParse({
      ...base,
      periodic_inspection_profile_id: randomUUID(),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('periodic_inspection_frequency_days'))
      expect(issue).toBeDefined()
    }
  })

  it('perfil + frequência juntos → válido', () => {
    const result = RentalSchema.safeParse({
      ...base,
      periodic_inspection_profile_id: randomUUID(),
      periodic_inspection_frequency_days: 30,
    })
    expect(result.success).toBe(true)
  })

  it('nenhum vínculo → válido', () => {
    const result = RentalSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('vínculo de check-in/check-out independe do periódico', () => {
    const result = RentalSchema.safeParse({
      ...base,
      checkin_checkout_inspection_profile_id: randomUUID(),
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Registro de KM (Spec 0014, RN-004)
// ---------------------------------------------------------------------------

describe('RentalSchema — km_initial obrigatório (RN-004)', () => {
  it('rejeita payload sem km_initial', () => {
    const { km_initial: _omit, ...semKm } = base
    const result = RentalSchema.safeParse(semKm)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('km_initial'))).toBe(true)
    }
  })

  it('rejeita km_initial negativo', () => {
    const result = RentalSchema.safeParse({ ...base, km_initial: -1 })
    expect(result.success).toBe(false)
  })

  it('aceita km_initial zero', () => {
    const result = RentalSchema.safeParse({ ...base, km_initial: 0 })
    expect(result.success).toBe(true)
  })
})

describe('TerminateRentalSchema — km_final obrigatório (RN-004)', () => {
  const baseTermination = {
    lease_id: randomUUID(),
    termination_date: '2026-06-01',
  }

  it('rejeita payload sem km_final', () => {
    const result = TerminateRentalSchema.safeParse(baseTermination)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('km_final'))).toBe(true)
    }
  })

  it('rejeita km_final negativo', () => {
    const result = TerminateRentalSchema.safeParse({ ...baseTermination, km_final: -1 })
    expect(result.success).toBe(false)
  })

  it('aceita com km_final informado', () => {
    const result = TerminateRentalSchema.safeParse({ ...baseTermination, km_final: 15000 })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multa por rescisão antecipada (Spec 0015)
// ---------------------------------------------------------------------------

describe('RentalSchema — multa/prazo mínimo opcionais (RF-001)', () => {
  it('aceita payload sem early_termination_fine_amount/minimum_term_days', () => {
    const result = RentalSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('aceita ambos configurados', () => {
    const result = RentalSchema.safeParse({
      ...base, early_termination_fine_amount: 1000, minimum_term_days: 90,
    })
    expect(result.success).toBe(true)
  })

  it('rejeita early_termination_fine_amount <= 0', () => {
    const result = RentalSchema.safeParse({ ...base, early_termination_fine_amount: 0 })
    expect(result.success).toBe(false)
  })

  it('rejeita minimum_term_days <= 0', () => {
    const result = RentalSchema.safeParse({ ...base, minimum_term_days: 0 })
    expect(result.success).toBe(false)
  })
})

describe('TerminateRentalSchema — decisão da multa (RF-004/RF-006/RN-005)', () => {
  const baseTermination = {
    lease_id: randomUUID(),
    termination_date: '2026-06-01',
    km_final: 15000,
  }

  it('charge_fine default é false, sem abatimentos', () => {
    const result = TerminateRentalSchema.safeParse(baseTermination)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.charge_fine).toBe(false)
      expect(result.data.fine_deposit_amount).toBe(0)
      expect(result.data.fine_credit_amount).toBe(0)
    }
  })

  it('rejeita abatimento de caução/crédito quando charge_fine = false', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination, charge_fine: false, fine_deposit_amount: 100,
    })
    expect(result.success).toBe(false)
  })

  it('aceita abatimentos quando charge_fine = true', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination, charge_fine: true, fine_deposit_amount: 400, fine_credit_amount: 100,
    })
    expect(result.success).toBe(true)
  })
})

describe('TerminateRentalSchema — cancelamento opcional dentro do período (Spec 0016)', () => {
  const baseTermination = {
    lease_id: randomUUID(),
    termination_date: '2026-06-01',
    km_final: 15000,
  }

  it('extra_charge_ids_to_cancel e extra_schedule_line_ids_to_cancel default é lista vazia', () => {
    const result = TerminateRentalSchema.safeParse(baseTermination)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extra_charge_ids_to_cancel).toEqual([])
      expect(result.data.extra_schedule_line_ids_to_cancel).toEqual([])
    }
  })

  it('aceita listas de uuids nos dois campos', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      extra_charge_ids_to_cancel: [randomUUID()],
      extra_schedule_line_ids_to_cancel: [randomUUID(), randomUUID()],
    })
    expect(result.success).toBe(true)
  })

  it('rejeita id que não é uuid em qualquer um dos campos', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination, extra_charge_ids_to_cancel: ['nao-e-um-uuid'],
    })
    expect(result.success).toBe(false)
  })
})

describe('TerminateRentalSchema — distribuição dirigida (Spec 0017)', () => {
  const baseTermination = {
    lease_id: randomUUID(),
    termination_date: '2026-06-01',
    km_final: 15000,
  }
  const chargeA = randomUUID()
  const chargeB = randomUUID()

  it('operador não distribui nada: os dois arrays default são vazios (A3)', () => {
    const result = TerminateRentalSchema.safeParse(baseTermination)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.deposit_allocations).toEqual([])
      expect(result.data.credit_allocations).toEqual([])
    }
  })

  it('aceita crédito sem motivo — o motivo só é exigido para caução', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      credit_allocations: [{ charge_id: chargeA, amount: 100 }],
    })
    expect(result.success).toBe(true)
  })

  it('aceita caução em várias dívidas com motivo único', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      deposit_allocations: [
        { charge_id: chargeA, amount: 300 },
        { charge_id: chargeB, amount: 200 },
      ],
      deposit_reason: 'Avaria no para-choque',
    })
    expect(result.success).toBe(true)
  })

  it('rejeita caução alocada sem motivo', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      deposit_allocations: [{ charge_id: chargeA, amount: 300 }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('deposit_reason'))).toBe(true)
    }
  })

  it('rejeita caução alocada com motivo curto demais (< 5 caracteres)', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      deposit_allocations: [{ charge_id: chargeA, amount: 300 }],
      deposit_reason: '  ok ',
    })
    expect(result.success).toBe(false)
  })

  it('rejeita a mesma dívida duas vezes na caução', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      deposit_allocations: [
        { charge_id: chargeA, amount: 100 },
        { charge_id: chargeA, amount: 50 },
      ],
      deposit_reason: 'Avaria no para-choque',
    })
    expect(result.success).toBe(false)
  })

  it('rejeita a mesma dívida duas vezes no crédito', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      credit_allocations: [
        { charge_id: chargeA, amount: 100 },
        { charge_id: chargeA, amount: 50 },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('a mesma dívida pode receber caução E crédito (arrays independentes, RN-004)', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination,
      deposit_allocations: [{ charge_id: chargeA, amount: 100 }],
      credit_allocations: [{ charge_id: chargeA, amount: 50 }],
      deposit_reason: 'Diária em aberto',
    })
    expect(result.success).toBe(true)
  })

  it('rejeita valor zero, negativo e charge_id que não é uuid', () => {
    for (const bad of [
      { charge_id: chargeA, amount: 0 },
      { charge_id: chargeA, amount: -10 },
      { charge_id: 'fine', amount: 10 },
    ]) {
      const result = TerminateRentalSchema.safeParse({
        ...baseTermination,
        credit_allocations: [bad],
      })
      expect(result.success).toBe(false)
    }
  })

  it('a multa continua nos campos escalares, sem motivo exigido (Spec 0015)', () => {
    const result = TerminateRentalSchema.safeParse({
      ...baseTermination, charge_fine: true, fine_deposit_amount: 400,
    })
    expect(result.success).toBe(true)
  })
})

describe('ReturnRemainingDepositSchema (Spec 0017)', () => {
  it('aceita o payload mínimo', () => {
    const result = ReturnRemainingDepositSchema.safeParse({
      rental_id: randomUUID(), amount: 100, return_date: '2026-06-01',
    })
    expect(result.success).toBe(true)
  })

  it('rejeita valor zero ou negativo', () => {
    for (const amount of [0, -5]) {
      const result = ReturnRemainingDepositSchema.safeParse({
        rental_id: randomUUID(), amount, return_date: '2026-06-01',
      })
      expect(result.success).toBe(false)
    }
  })

  it('rejeita data fora do formato e rental_id que não é uuid', () => {
    expect(ReturnRemainingDepositSchema.safeParse({
      rental_id: randomUUID(), amount: 10, return_date: '01/06/2026',
    }).success).toBe(false)
    expect(ReturnRemainingDepositSchema.safeParse({
      rental_id: 'x', amount: 10, return_date: '2026-06-01',
    }).success).toBe(false)
  })
})
