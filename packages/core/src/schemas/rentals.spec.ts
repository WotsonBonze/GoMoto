import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { RentalSchema, TerminateRentalSchema } from './rentals'

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
