import { describe, it, expect } from 'vitest'
import { calculateVehiclePayback, nextMonth, type VehiclePaybackInput } from './vehicle-payback'

function input(over: Partial<VehiclePaybackInput> = {}): VehiclePaybackInput {
  return {
    acquisition_amount: 10000,
    sale_amount: 0,
    sold_on: null,
    start_date: '2026-01-10',
    today: '2026-04-20',
    receipts: [],
    expenses: [],
    ...over,
  }
}

describe('calculateVehiclePayback', () => {
  it('acumula recebido e despesa mês a mês, incluindo meses sem movimento', () => {
    const r = calculateVehiclePayback(input({
      receipts: [
        { date: '2026-01-15T12:00:00Z', amount: 1000 },
        { date: '2026-03-02', amount: 500 },
      ],
      expenses: [{ date: '2026-02-10', amount: 200 }],
    }))

    expect(r.points.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    expect(r.points.map((p) => p.recovered)).toEqual([1000, 1000, 1500, 1500])
    expect(r.points.map((p) => p.invested)).toEqual([10000, 10200, 10200, 10200])
  })

  it('investido é aquisição + despesas, recuperado é o recebido; falta a diferença', () => {
    const r = calculateVehiclePayback(input({
      receipts: [{ date: '2026-02-01', amount: 2500 }],
      expenses: [{ date: '2026-02-05', amount: 900 }],
    }))

    expect(r.invested_total).toBe(10900)
    expect(r.recovered_total).toBe(2500)
    expect(r.remaining).toBe(8400)
    expect(r.profit).toBe(0)
    expect(r.progress_pct).toBe(22.94)
    expect(r.reached_month).toBeNull()
  })

  it('detecta o mês do payback e o lucro depois dele', () => {
    const r = calculateVehiclePayback(input({
      receipts: [
        { date: '2026-01-20', amount: 6000 },
        { date: '2026-03-20', amount: 5000 },
      ],
      expenses: [{ date: '2026-02-01', amount: 500 }],
    }))

    expect(r.reached_month).toBe('2026-03')
    expect(r.remaining).toBe(0)
    expect(r.profit).toBe(500)
    expect(r.progress_pct).toBe(100)
    expect(r.roi_pct).toBe(5)
  })

  it('a venda entra no recuperado a partir do mês da venda e pode fechar o payback', () => {
    const r = calculateVehiclePayback(input({
      receipts: [{ date: '2026-01-20', amount: 4000 }],
      sale_amount: 7000,
      sold_on: '2026-03-15',
    }))

    expect(r.points.map((p) => p.recovered)).toEqual([4000, 4000, 11000, 11000])
    expect(r.reached_month).toBe('2026-03')
    expect(r.recovered_total).toBe(11000)
    expect(r.profit).toBe(1000)
  })

  it('sem aquisição cadastrada não há progresso, ROI nem payback (RN-044)', () => {
    const r = calculateVehiclePayback(input({
      acquisition_amount: 0,
      receipts: [{ date: '2026-02-01', amount: 900 }],
    }))

    expect(r.progress_pct).toBeNull()
    expect(r.roi_pct).toBeNull()
    expect(r.reached_month).toBeNull()
    expect(r.recovered_total).toBe(900)
  })

  it('estende a série para trás e para frente conforme os movimentos', () => {
    const r = calculateVehiclePayback(input({
      start_date: '2026-03-01',
      today: '2026-03-31',
      receipts: [{ date: '2026-01-05', amount: 100 }],
      expenses: [{ date: '2026-05-01', amount: 50 }],
    }))

    expect(r.points[0].month).toBe('2026-01')
    expect(r.points.at(-1)?.month).toBe('2026-05')
    expect(r.invested_total).toBe(10050)
  })

  it('não acumula erro de ponto flutuante', () => {
    const r = calculateVehiclePayback(input({
      receipts: Array.from({ length: 3 }, () => ({ date: '2026-02-01', amount: 0.1 })),
    }))

    expect(r.recovered_total).toBe(0.3)
  })
})

describe('nextMonth', () => {
  it('vira o ano em dezembro', () => {
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(nextMonth('2026-03')).toBe('2026-04')
  })
})
