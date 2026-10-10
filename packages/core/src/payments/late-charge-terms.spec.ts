import { describe, it, expect } from 'vitest'
import { embeddedLateChargeTerms } from './late-charge-terms'
import { calculateAmountDue, type LateChargePolicy } from '../rules/allocation'

// 2% de multa, 0,033%/dia (≈ 0,99%/mês), 2 dias de carência.
const POLICY: LateChargePolicy = {
  fee_type: 'percentage',
  fee_value: 0.02,
  daily_interest_rate: 0.00033,
  grace_period_days: 2,
  min_amount: 0,
}

const HOJE = new Date(2026, 9, 9) // 2026-10-09

function saldo(open: number, dueDate: string, extra: Partial<{ paid: number; late: number }> = {}) {
  return {
    open_amount: open,
    paid_amount: extra.paid ?? 0,
    late_charge_amount: extra.late ?? 0,
    due_date: dueDate,
  }
}

describe('embeddedLateChargeTerms', () => {
  it('cobrança a vencer: valor cheio, vencimento + carência, multa e juros traduzidos', () => {
    const t = embeddedLateChargeTerms(saldo(100, '2026-10-20'), POLICY, HOJE)
    expect(t).toEqual({
      value: 100,
      dueDate: '2026-10-22',
      fine: { kind: 'percent', value: 2 },
      monthlyInterestPercent: 0.99,
      accruedIncluded: 0,
      path: 'before_overdue',
    })
  })

  it('vencida mas dentro da carência: ainda é "antes do atraso", vencimento no fim da carência', () => {
    // Venceu ontem; carência de 2 dias termina amanhã.
    const t = embeddedLateChargeTerms(saldo(100, '2026-10-08'), POLICY, HOJE)
    expect(t.path).toBe('before_overdue')
    expect(t.dueDate).toBe('2026-10-10')
    expect(t.value).toBe(100)
    expect(t.fine).toEqual({ kind: 'percent', value: 2 })
  })

  it('último dia da carência: vencimento é hoje, não no passado', () => {
    const t = embeddedLateChargeTerms(saldo(100, '2026-10-07'), POLICY, HOJE)
    expect(t.path).toBe('before_overdue')
    expect(t.dueDate).toBe('2026-10-09')
  })

  it('já em atraso: valor de hoje pelo GoMoto, vencimento hoje, SEM multa (já está dentro)', () => {
    // Venceu 01/10; carência até 03/10; 6 dias de atraso em 09/10.
    const t = embeddedLateChargeTerms(saldo(100, '2026-10-01'), POLICY, HOJE)
    const esperado = calculateAmountDue(saldo(100, '2026-10-01'), POLICY, HOJE)

    expect(t.path).toBe('already_overdue')
    expect(t.dueDate).toBe('2026-10-09')
    expect(t.fine).toBeNull()
    expect(t.monthlyInterestPercent).toBe(0.99)
    expect(t.value).toBe(esperado.amount_due)
    expect(t.accruedIncluded).toBe(esperado.accrued_pending)
    expect(t.value).toBe(round2(100 + t.accruedIncluded))
  })

  it('encargo já realizado: multa não viaja de novo, mesmo sem dia novo de atraso', () => {
    // Estorno de um pagamento que já tinha realizado o encargo (ADR 0028).
    const t = embeddedLateChargeTerms(
      saldo(102.5, '2026-10-01', { late: 2.5 }),
      POLICY,
      new Date(2026, 9, 2), // ainda dentro da carência
    )
    expect(t.path).toBe('already_overdue')
    expect(t.fine).toBeNull()
  })

  it('multa fixa passa em reais', () => {
    const t = embeddedLateChargeTerms(
      saldo(350, '2026-10-20'),
      { ...POLICY, fee_type: 'fixed', fee_value: 15 },
      HOJE,
    )
    expect(t.fine).toEqual({ kind: 'fixed', value: 15 })
  })

  it('política sem multa nem juros não declara nenhum dos dois', () => {
    const t = embeddedLateChargeTerms(
      saldo(100, '2026-10-20'),
      { ...POLICY, fee_value: 0, daily_interest_rate: 0 },
      HOJE,
    )
    expect(t.fine).toBeNull()
    expect(t.monthlyInterestPercent).toBeNull()
  })

  it('sem política: valor do saldo, vencimento nunca no passado', () => {
    const t = embeddedLateChargeTerms(saldo(100, '2026-09-01'), null, HOJE)
    expect(t).toMatchObject({ value: 100, dueDate: '2026-10-09', fine: null, monthlyInterestPercent: null })
  })

  it('juro mensal viaja com 2 casas — divergência de centavos aceita (ADR 0037)', () => {
    const t = embeddedLateChargeTerms(
      saldo(100, '2026-10-20'),
      { ...POLICY, daily_interest_rate: 0.000329 },
      HOJE,
    )
    // 0,000329 × 30 = 0,987% → 0,99%: o provedor arredondaria igual.
    expect(t.monthlyInterestPercent).toBe(0.99)
  })

  it('min_amount não é representável: o código declara só multa e juros (cobra menos, nunca mais)', () => {
    const t = embeddedLateChargeTerms(
      saldo(100, '2026-10-20'),
      { ...POLICY, min_amount: 10 },
      HOJE,
    )
    expect(t.fine).toEqual({ kind: 'percent', value: 2 })
    expect(t).not.toHaveProperty('minAmount')
  })

  it('cobrança encerrada não tem o que cobrar', () => {
    const t = embeddedLateChargeTerms({ ...saldo(100, '2026-10-01'), status: 'paid' }, POLICY, HOJE)
    expect(t.value).toBe(0)
  })
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
