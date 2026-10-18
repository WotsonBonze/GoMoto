import { describe, expect, it } from 'vitest'
import { groupByMonth } from './shared'

const row = (due_date: string, amount: number) => ({ due_date, amount })

describe('groupByMonth', () => {
  it('agrupa por mês com quantidade e subtotal, na ordem de entrada', () => {
    const groups = groupByMonth(
      [row('2026-11-25', 450), row('2026-10-07', 450), row('2026-10-14', 450.5)],
      r => r.due_date,
      r => r.amount,
    )
    expect(groups.map(g => [g.label, g.rows.length, g.total])).toEqual([
      ['nov/2026', 1, 450],
      ['out/2026', 2, 900.5],
    ])
  })

  it('aceita timestamp e valor numérico vindo como string do banco', () => {
    const [g] = groupByMonth(
      [{ at: '2026-01-31T23:00:00Z', v: '10.25' }],
      r => r.at,
      r => Number(r.v),
    )
    expect(g).toMatchObject({ key: '2026-01', label: 'jan/2026', total: 10.25 })
  })

  it('lista vazia não gera grupo', () => {
    expect(groupByMonth([], () => '', () => 0)).toEqual([])
  })
})
