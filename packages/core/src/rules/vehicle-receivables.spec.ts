import { describe, it, expect } from 'vitest'
import {
  summarizeVehicleReceivables,
  summarizeExpenseResponsibility,
  type ReceivableCharge,
} from './vehicle-receivables'

function charge(over: Partial<ReceivableCharge>): ReceivableCharge {
  return {
    status: 'open',
    due_date: '2026-10-01',
    total_amount: 300,
    paid_amount: 0,
    open_amount: 300,
    is_overdue: false,
    days_overdue: 0,
    ...over,
  }
}

describe('summarizeVehicleReceivables', () => {
  it('soma o recebido sem contar cobrança cancelada e mede o % sobre o previsto', () => {
    const r = summarizeVehicleReceivables([
      charge({ status: 'paid', total_amount: 300, paid_amount: 300, open_amount: 0 }),
      charge({ status: 'open', total_amount: 300, paid_amount: 100, open_amount: 200 }),
      charge({ status: 'cancelled', total_amount: 999, paid_amount: 50, open_amount: 949 }),
    ], [])

    expect(r.received).toBe(400)
    expect(r.expected_total).toBe(600)
    expect(r.received_pct).toBe(66.67)
  })

  it('separa em atraso de a vencer e guarda a mais antiga e a próxima', () => {
    const r = summarizeVehicleReceivables([
      charge({ is_overdue: true, days_overdue: 10, open_amount: 300, due_date: '2026-09-10' }),
      charge({ is_overdue: true, days_overdue: 40, open_amount: 150.5, due_date: '2026-08-10' }),
      charge({ open_amount: 300, due_date: '2026-10-20' }),
      charge({ open_amount: 300, due_date: '2026-10-05' }),
    ], [])

    expect(r.overdue).toEqual({ amount: 450.5, count: 2, oldest_days: 40 })
    expect(r.upcoming).toEqual({ amount: 600, count: 2, next_due_date: '2026-10-05' })
  })

  it('cobrança baixada como prejuízo e paga não entram como recebível', () => {
    const r = summarizeVehicleReceivables([
      charge({ status: 'written_off', is_overdue: true, days_overdue: 90, open_amount: 300 }),
      charge({ status: 'paid', paid_amount: 300, open_amount: 0, total_amount: 300 }),
    ], [])

    expect(r.overdue.count).toBe(0)
    expect(r.upcoming.count).toBe(0)
    expect(r.expected_total).toBe(300)
  })

  it('cronograma a emitir soma ao futuro e informa o intervalo de vencimentos', () => {
    const r = summarizeVehicleReceivables(
      [charge({ open_amount: 300, due_date: '2026-10-05' })],
      [
        { due_date: '2026-11-05', amount: 300 },
        { due_date: '2026-12-05', amount: 300 },
        { due_date: '2026-10-25', amount: 250 },
      ],
    )

    expect(r.to_issue).toEqual({ amount: 850, count: 3, first_due_date: '2026-10-25', last_due_date: '2026-12-05' })
    expect(r.future_total).toBe(1150)
    expect(r.expected_total).toBe(1150)
  })

  it('sem cobrança nem cronograma devolve zeros e percentual nulo', () => {
    const r = summarizeVehicleReceivables([], [])

    expect(r.expected_total).toBe(0)
    expect(r.received_pct).toBeNull()
    expect(r.overdue).toEqual({ amount: 0, count: 0, oldest_days: 0 })
    expect(r.upcoming.next_due_date).toBeNull()
    expect(r.to_issue.first_due_date).toBeNull()
    expect(r.future_total).toBe(0)
  })

  it('não acumula erro de ponto flutuante em centavos', () => {
    const r = summarizeVehicleReceivables(
      Array.from({ length: 3 }, () => charge({ open_amount: 0.1, total_amount: 0.1 })),
      [],
    )

    expect(r.upcoming.amount).toBe(0.3)
    expect(r.future_total).toBe(0.3)
  })
})

describe('summarizeExpenseResponsibility', () => {
  it('multa repassada ao cliente é dele no fim', () => {
    // Multa de R$ 300: lançada como despesa da empresa, repassada em cobrança.
    const r = summarizeExpenseResponsibility([{ status: 'open', amount: 300 }], 300)

    expect(r.total).toBe(300)
    expect(r.customer).toBe(300)
    expect(r.company).toBe(0)
    expect(r.customer_pct).toBe(100)
  })

  it('empresa é o total menos o repassado, e a soma fecha', () => {
    const r = summarizeExpenseResponsibility(
      [
        { status: 'paid', amount: 500 },
        { status: 'open', amount: 400 },
        { status: 'paid', amount: 1000 },
      ],
      483.33,
    )

    expect(r.count).toBe(3)
    expect(r.total).toBe(1900)
    expect(r.customer).toBe(483.33)
    expect(r.company).toBe(1416.67)
    expect(r.company + r.customer).toBeCloseTo(r.total, 2)
    expect(r.customer_pct).toBe(25.44)
  })

  it('ignora conta a pagar cancelada', () => {
    const r = summarizeExpenseResponsibility(
      [
        { status: 'cancelled', amount: 800 },
        { status: 'open', amount: 100 },
      ],
      0,
    )

    expect(r).toEqual({ count: 1, total: 100, company: 100, customer: 0, customer_pct: 0 })
  })

  it('repasse acima do custo é limitado ao custo; negativo vira zero', () => {
    const list = [{ status: 'open' as const, amount: 100 }]

    expect(summarizeExpenseResponsibility(list, 250).customer).toBe(100)
    expect(summarizeExpenseResponsibility(list, 250).company).toBe(0)
    expect(summarizeExpenseResponsibility(list, -5).customer).toBe(0)
  })

  it('sem despesa o percentual é nulo', () => {
    expect(summarizeExpenseResponsibility([], 0)).toEqual({
      count: 0, total: 0, company: 0, customer: 0, customer_pct: null,
    })
  })
})
