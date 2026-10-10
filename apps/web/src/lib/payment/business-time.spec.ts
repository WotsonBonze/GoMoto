import { describe, it, expect } from 'vitest'
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
