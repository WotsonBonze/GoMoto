import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { calculateAmountDue, type LateChargePolicy } from '@gomoto/core'
import { endOfTenantDayIso, tenantToday } from './business-time'

describe('tenantToday', () => {
  it('22h em Brasília ainda é hoje, mesmo com o UTC já no dia seguinte', () => {
    const t = tenantToday('America/Sao_Paulo', new Date('2026-10-11T01:00:00Z'))
    expect([t.getFullYear(), t.getMonth() + 1, t.getDate()]).toEqual([2026, 10, 10])
  })

  it('fuso ausente cai em America/Sao_Paulo', () => {
    const t = tenantToday(null, new Date('2026-10-11T01:00:00Z'))
    expect(t.getDate()).toBe(10)
  })
})

describe('endOfTenantDayIso', () => {
  it('23:59:59 do dia da locadora, com deslocamento', () => {
    expect(endOfTenantDayIso('America/Sao_Paulo', new Date('2026-10-10T15:00:00Z')))
      .toBe('2026-10-10T23:59:59.000-03:00')
  })

  it('perto da meia-noite respeita o prazo mínimo do provedor', () => {
    const now = new Date('2026-10-11T02:50:00Z') // 23:50 em Brasília
    const iso = endOfTenantDayIso('America/Sao_Paulo', now, 30 * 60 * 1000)
    expect(Date.parse(iso) - now.getTime()).toBe(30 * 60 * 1000)
  })

  it('longe da meia-noite o prazo mínimo não interfere', () => {
    const iso = endOfTenantDayIso('America/Sao_Paulo', new Date('2026-10-10T12:00:00Z'), 30 * 60 * 1000)
    expect(iso).toBe('2026-10-10T23:59:59.000-03:00')
  })
})

// Caso real de 2026-10-14: cobrança de R$ 10 vencendo no dia, política com
// multa fixa de R$ 35, consultada às 23:22 de Brasília. O servidor da Vercel
// roda em UTC, onde já era dia 15 — a tela de detalhe mostrava R$ 45.
describe('encargo com o relógio do servidor em UTC', () => {
  const balance = { open_amount: 10, paid_amount: 0, late_charge_amount: 0, due_date: '2026-10-14', status: 'open' }
  const policy = {
    fee_type: 'fixed', fee_value: 35, daily_interest_rate: 0.000333,
    grace_period_days: 0, min_amount: 0, version: 1, effective_from: '2026-10-13',
  } as unknown as LateChargePolicy
  const agora = new Date('2026-10-15T02:22:00Z') // 23:22 em Brasília, 14/10
  const tzOriginal = process.env.TZ

  beforeAll(() => { process.env.TZ = 'UTC' })
  afterAll(() => { process.env.TZ = tzOriginal })

  it('o dia do servidor já virou — é por isso que `new Date()` não serve', () => {
    expect(calculateAmountDue(balance, policy, agora).amount_due).toBe(45)
  })

  it('no dia da locadora a cobrança ainda não venceu', () => {
    const due = calculateAmountDue(balance, policy, tenantToday('America/Sao_Paulo', agora))
    expect(due.accrued.days_overdue).toBe(0)
    expect(due.amount_due).toBe(10)
  })
})
