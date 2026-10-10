import { describe, it, expect } from 'vitest'
import { calculateAmountDue, type LateChargePolicy } from '@gomoto/core'
import { representsDebt } from './intent-reuse'

const POLICY: LateChargePolicy = {
  fee_type: 'percentage', fee_value: 0.02, daily_interest_rate: 0.00033, grace_period_days: 0, min_amount: 0,
}

const saldo = { open_amount: 100, paid_amount: 0, late_charge_amount: 0, due_date: '2026-10-01' }
const dia10 = calculateAmountDue(saldo, POLICY, new Date(2026, 9, 10))
const dia15 = calculateAmountDue(saldo, POLICY, new Date(2026, 9, 15))

describe('representsDebt — valor congelado (MP, Cora, InfinitePay)', () => {
  it('código do dia 10 NÃO serve no dia 15: os juros cresceram (ADR 0038, P1)', () => {
    const row = { provider: 'cora', amount: dia10.amount_due, payload: {} }
    expect(dia15.amount_due).toBeGreaterThan(dia10.amount_due)
    expect(representsDebt(row, dia15)).toBe(false)
  })

  it('mesmo dia, mesmo valor: reaproveita', () => {
    const row = { provider: 'infinitepay', amount: dia10.amount_due, payload: {} }
    expect(representsDebt(row, dia10)).toBe(true)
  })

  it('valor vindo do banco como texto numérico também compara', () => {
    const row = { provider: 'mercadopago', amount: String(dia10.amount_due) as unknown as number, payload: {} }
    expect(representsDebt(row, dia10)).toBe(true)
  })
})

describe('representsDebt — encargo embutido (Asaas)', () => {
  const terms = { principal: dia10.principal, realized: dia10.late_charge_realized }

  it('o código soma os dias sozinho: serve no dia 15 com a mesma base', () => {
    const row = { provider: 'asaas', amount: dia10.amount_due, payload: { late_charge_terms: terms } }
    expect(representsDebt(row, dia15)).toBe(true)
  })

  it('pagamento parcial muda o principal: não serve', () => {
    const parcial = calculateAmountDue({ ...saldo, open_amount: 60, paid_amount: 40 }, POLICY, new Date(2026, 9, 15))
    const row = { provider: 'asaas', amount: dia10.amount_due, payload: { late_charge_terms: terms } }
    expect(representsDebt(row, parcial)).toBe(false)
  })

  it('encargo realizado depois da emissão (estorno) muda a base: não serve', () => {
    const estornado = calculateAmountDue({ ...saldo, open_amount: 102.5, late_charge_amount: 2.5 }, POLICY, new Date(2026, 9, 15))
    const row = { provider: 'asaas', amount: dia10.amount_due, payload: { late_charge_terms: terms } }
    expect(representsDebt(row, estornado)).toBe(false)
  })

  it('sem os termos gravados, não arrisca: descarta', () => {
    const row = { provider: 'asaas', amount: dia10.amount_due, payload: {} }
    expect(representsDebt(row, dia10)).toBe(false)
  })
})
