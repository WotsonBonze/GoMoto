import { describe, it, expect } from 'vitest'
import {
  deductPassThrough,
  summarizeVehicleIncome,
  type IncomeCharge,
} from './vehicle-income'

const rent = { amount: 300, kind: 'revenue' as const, account_label: 'Receita de locação', source_key: null }
const lateCharge = (amount: number) => ({ amount, kind: 'revenue' as const, account_label: 'Receita de encargos', source_key: null })
const fine = (amount: number, key = 'fine:f1') => ({ amount, kind: 'reimbursement' as const, account_label: 'Repasse de multa', source_key: key })
const deposit = (amount: number) => ({ amount, kind: 'other' as const, account_label: 'Cauções a devolver', source_key: null })

/** Alocação em dinheiro (pix, cartão, retenção de caução...) — o padrão dos testes. */
function pay(charge_id: string, date: string, amount: number) {
  return { charge_id, date, amount, is_cash: true }
}

describe('summarizeVehicleIncome', () => {
  it('caução cobrada não é recebido nem repasse: cobrança 100% dela fica de fora inteira', () => {
    const charges: IncomeCharge[] = [
      { id: 'c-deposit', status: 'paid', items: [deposit(500)] },
      { id: 'c-rent', status: 'paid', items: [rent] },
    ]
    const r = summarizeVehicleIncome(charges, [
      pay('c-deposit', '2026-09-23', 500),
      pay('c-rent', '2026-09-23', 300),
    ])

    expect(r.own_receipts).toEqual([{ date: '2026-09-23', amount: 300 }])
    expect([...r.received_by_source.entries()]).toEqual([['Receita de locação', 300]])
  })

  it('multa paga pelo cliente é repasse: não vira recebido próprio, mas aparece na composição', () => {
    const charges: IncomeCharge[] = [
      { id: 'c-fine', status: 'paid', items: [fine(1000)] },
      { id: 'c-rent', status: 'paid', items: [rent] },
    ]
    const r = summarizeVehicleIncome(charges, [
      pay('c-fine', '2026-09-23T10:00:00Z', 1000),
      pay('c-rent', '2026-09-23T11:00:00Z', 300),
    ])

    expect(r.passthrough_billed).toBe(1000)
    expect(r.passthrough_received).toBe(1000)
    expect(r.passthrough_pending).toBe(0)
    expect(r.own_receipts).toEqual([{ date: '2026-09-23T11:00:00Z', amount: 300 }])
    expect(r.received_by_source.get('Repasse de multa')).toBe(1000)
    expect(r.received_by_source.get('Receita de locação')).toBe(300)
  })

  it('repasse cobrado e ainda não pago fica como saldo a devolver', () => {
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'open', items: [fine(400)] }],
      [pay('c', '2026-09-01', 100)],
    )

    expect(r.passthrough_billed).toBe(400)
    expect(r.passthrough_received).toBe(100)
    expect(r.passthrough_pending).toBe(300)
    expect(r.own_receipts).toEqual([])
  })

  it('cobrança mista reparte o pagamento por categoria, proporcional ao peso de cada item', () => {
    // 300 de aluguel + 100 de multa = 400; cliente pagou 200 → 3/4 aluguel, 1/4 multa.
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'open', items: [rent, fine(100)] }],
      [pay('c', '2026-09-01', 200)],
    )

    expect(r.own_receipts).toEqual([{ date: '2026-09-01', amount: 150 }])
    expect(r.passthrough_received).toBe(50)
    expect(r.received_by_source.get('Receita de locação')).toBe(150)
    expect(r.received_by_source.get('Repasse de multa')).toBe(50)
  })

  it('cobrança cancelada sai de tudo, inclusive o pagamento alocado a ela', () => {
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'cancelled', items: [fine(500)] }],
      [pay('c', '2026-09-01', 500)],
    )

    expect(r.passthrough_billed).toBe(0)
    expect(r.own_receipts).toEqual([])
    expect(r.received_by_source.size).toBe(0)
  })

  it('agrupa o repasse emitido por despesa de origem, para abater a despesa depois', () => {
    const r = summarizeVehicleIncome(
      [
        { id: 'a', status: 'open', items: [fine(300, 'fine:f1')] },
        { id: 'b', status: 'open', items: [fine(150, 'expense:p2')] },
        { id: 'c', status: 'open', items: [fine(50, 'fine:f1')] },
      ],
      [],
    )

    expect(r.billed_by_source.get('fine:f1')).toBe(350)
    expect(r.billed_by_source.get('expense:p2')).toBe(150)
  })

  it('duas categorias de receita na mesma cobrança somam na composição', () => {
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'paid', items: [rent, lateCharge(20)] }],
      [pay('c', '2026-09-01', 320)],
    )

    expect(r.received_by_source.get('Receita de locação')).toBe(300)
    expect(r.received_by_source.get('Receita de encargos')).toBe(20)
  })

  it('não acumula erro de ponto flutuante', () => {
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'paid', items: [rent] }],
      Array.from({ length: 3 }, () => pay('c', '2026-09-01', 0.1)),
    )

    expect(r.own_receipts.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(0.3, 2)
  })

  it('quitação por crédito do cliente não conta como recebido: já foi contado quando o crédito nasceu', () => {
    // Cenário real: manutenção de R$234, dividida ao meio, gera crédito de
    // R$234 ao cliente (ele pagou o total à oficina). Meses depois, esse
    // crédito é usado para abater uma cobrança de aluguel de R$380 — só
    // R$146 entram em dinheiro; os R$234 restantes não são recebimento novo.
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'open', items: [{ amount: 380, kind: 'revenue', account_label: 'Receita de locação', source_key: null }] }],
      [
        { charge_id: 'c', date: '2025-12-31', amount: 146, is_cash: true },
        { charge_id: 'c', date: '2026-09-22', amount: 234, is_cash: false },
      ],
    )

    expect(r.own_receipts).toEqual([{ date: '2025-12-31', amount: 146 }])
    expect(r.received_by_source.get('Receita de locação')).toBe(146)
  })

  it('retenção de caução conta normalmente: é dinheiro que a empresa deixa de devolver', () => {
    const r = summarizeVehicleIncome(
      [{ id: 'c', status: 'open', items: [rent] }],
      [pay('c', '2026-09-23', 300)], // is_cash: true, como qualquer pix/cartão
    )

    expect(r.own_receipts).toEqual([{ date: '2026-09-23', amount: 300 }])
  })
})

describe('deductPassThrough', () => {
  it('multa 100% repassada não sobra como despesa da empresa', () => {
    const r = deductPassThrough(
      [{ date: '2026-09-10', amount: 1000, source_key: 'fine:f1' }],
      new Map([['fine:f1', 1000]]),
    )

    expect(r).toEqual([{ date: '2026-09-10', amount: 0 }])
  })

  it('rateio: a empresa fica com a parte que não foi repassada', () => {
    const r = deductPassThrough(
      [{ date: '2026-09-10', amount: 400, source_key: 'expense:p1' }],
      new Map([['expense:p1', 150]]),
    )

    expect(r[0].amount).toBe(250)
  })

  it('repasse acima da despesa nunca deixa negativo nem escorre para outra despesa', () => {
    const r = deductPassThrough(
      [
        { date: '2026-09-01', amount: 100, source_key: 'k' },
        { date: '2026-09-02', amount: 100, source_key: 'outra' },
      ],
      new Map([['k', 250]]),
    )

    expect(r.map((x) => x.amount)).toEqual([0, 100])
  })

  it('despesa sem repasse fica inteira com a empresa', () => {
    const r = deductPassThrough([{ date: '2026-09-01', amount: 500, source_key: 'expense:p9' }], new Map())

    expect(r[0].amount).toBe(500)
  })
})
