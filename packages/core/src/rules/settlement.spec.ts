import { describe, it, expect } from 'vitest'
import {
  computeDebtDistribution,
  buildTerminationAllocations,
  clampAllocationInput,
  formatAllocationInput,
  FINE_DEBT_ID,
  type DistributionInput,
} from './settlement'

function input(over: Partial<DistributionInput> = {}): DistributionInput {
  return {
    debts: [
      { id: 'a', amount_due: 300 },
      { id: 'b', amount_due: 200 },
    ],
    deposit_balance: 500,
    credit_balance: 200,
    deposit_allocations: {},
    credit_allocations: {},
    ...over,
  }
}

describe('computeDebtDistribution', () => {
  // CA-002 / RF-002
  it('CA-002: soma alocado e restante por linha e por saldo', () => {
    const r = computeDebtDistribution(input({
      deposit_allocations: { a: 300, b: 100 },
      credit_allocations: { b: 50 },
    }))

    const a = r.lines.find((l) => l.id === 'a')!
    const b = r.lines.find((l) => l.id === 'b')!
    expect(a.remaining).toBe(0)
    expect(b.remaining).toBe(50)

    expect(r.deposit_allocated).toBe(400)
    expect(r.deposit_remaining).toBe(100)
    expect(r.credit_allocated).toBe(50)
    expect(r.credit_remaining).toBe(150)
    expect(r.debt_total).toBe(500)
    expect(r.debt_remaining).toBe(50)
    expect(r.is_valid).toBe(true)
  })

  it('sem nenhuma alocação: tudo em aberto, saldos intactos, válido', () => {
    const r = computeDebtDistribution(input())
    expect(r.debt_remaining).toBe(500)
    expect(r.deposit_remaining).toBe(500)
    expect(r.credit_remaining).toBe(200)
    expect(r.violations).toEqual([])
    expect(r.is_valid).toBe(true)
  })

  // CA-005 / RF-005 / RN-001
  it('RN-001: caução acima do que a dívida deve → LINE_EXCEEDS_DEBT', () => {
    const r = computeDebtDistribution(input({
      debts: [{ id: 'a', amount_due: 100 }],
      deposit_allocations: { a: 150 },
    }))
    expect(r.violations).toEqual([{ code: 'LINE_EXCEEDS_DEBT', id: 'a', excess: 50 }])
    expect(r.is_valid).toBe(false)
  })

  it('RN-001: caução + crédito JUNTOS passam da dívida, cada um sozinho não', () => {
    const r = computeDebtDistribution(input({
      debts: [{ id: 'a', amount_due: 100 }],
      deposit_allocations: { a: 70 },
      credit_allocations: { a: 60 },
    }))
    expect(r.violations).toEqual([{ code: 'LINE_EXCEEDS_DEBT', id: 'a', excess: 30 }])
  })

  it('RN-001: caução + crédito somando exatamente a dívida → válido', () => {
    const r = computeDebtDistribution(input({
      debts: [{ id: 'a', amount_due: 100 }],
      deposit_allocations: { a: 40 },
      credit_allocations: { a: 60 },
    }))
    expect(r.is_valid).toBe(true)
    expect(r.lines[0]!.remaining).toBe(0)
  })

  // CA-006 / RF-006 / RN-002
  it('RN-002: soma de caução acima do saldo → DEPOSIT_EXCEEDS_BALANCE', () => {
    const r = computeDebtDistribution(input({
      deposit_balance: 400,
      deposit_allocations: { a: 300, b: 200 },
    }))
    expect(r.violations).toContainEqual({ code: 'DEPOSIT_EXCEEDS_BALANCE', excess: 100 })
    expect(r.is_valid).toBe(false)
  })

  // CA-007 / RF-007 / RN-003
  it('RN-003: soma de crédito acima do saldo → CREDIT_EXCEEDS_BALANCE', () => {
    const r = computeDebtDistribution(input({
      credit_balance: 100,
      credit_allocations: { a: 80, b: 50 },
    }))
    expect(r.violations).toContainEqual({ code: 'CREDIT_EXCEEDS_BALANCE', excess: 30 })
  })

  // RN-004
  it('RN-004: caução e crédito são independentes — estourar uma não acusa a outra', () => {
    const r = computeDebtDistribution(input({
      credit_balance: 100,
      deposit_allocations: { a: 300 },
      credit_allocations: { b: 150 },
    }))
    expect(r.violations.map((v) => v.code)).toEqual(['CREDIT_EXCEEDS_BALANCE'])
  })

  it('caução numa dívida e crédito em outra: cada uma vale no seu destino', () => {
    const r = computeDebtDistribution(input({
      deposit_allocations: { a: 300 },
      credit_allocations: { b: 150 },
    }))
    const a = r.lines.find((l) => l.id === 'a')!
    const b = r.lines.find((l) => l.id === 'b')!
    expect([a.deposit, a.credit]).toEqual([300, 0])
    expect([b.deposit, b.credit]).toEqual([0, 150])
    expect(r.is_valid).toBe(true)
  })

  describe('teto por linha (max do input)', () => {
    it('desconta o que as OUTRAS linhas já consumiram do saldo', () => {
      const r = computeDebtDistribution(input({
        deposit_balance: 500,
        deposit_allocations: { a: 300 },
      }))
      // sobram 200 de caução no total; a dívida b deve 200 → cabe 200
      expect(r.lines.find((l) => l.id === 'b')!.max_deposit).toBe(200)

      const r2 = computeDebtDistribution(input({
        deposit_balance: 350,
        deposit_allocations: { a: 300 },
      }))
      // sobram só 50 de caução → o teto de b cai para 50
      expect(r2.lines.find((l) => l.id === 'b')!.max_deposit).toBe(50)
    })

    it('desconta o que a OUTRA fonte já cobriu na mesma dívida', () => {
      const r = computeDebtDistribution(input({
        credit_allocations: { a: 250 },
      }))
      // a deve 300 e o crédito já cobriu 250 → só cabem 50 de caução nela
      expect(r.lines.find((l) => l.id === 'a')!.max_deposit).toBe(50)
    })

    it('o teto da própria linha não se desconta a si mesmo', () => {
      const r = computeDebtDistribution(input({
        deposit_allocations: { a: 300 },
      }))
      // editar a mesma linha: os 300 dela não contam contra ela
      expect(r.lines.find((l) => l.id === 'a')!.max_deposit).toBe(300)
    })
  })

  describe('robustez do valor digitado', () => {
    it('negativo, NaN e infinito viram zero', () => {
      const r = computeDebtDistribution(input({
        deposit_allocations: { a: -50, b: Number.NaN },
        credit_allocations: { a: Number.POSITIVE_INFINITY },
      }))
      expect(r.deposit_allocated).toBe(0)
      expect(r.credit_allocated).toBe(0)
      expect(r.is_valid).toBe(true)
    })

    it('ponto flutuante não recusa distribuição exata (0,1 + 0,2 = 0,3)', () => {
      const r = computeDebtDistribution({
        debts: [{ id: 'a', amount_due: 0.3 }],
        deposit_balance: 0.3,
        credit_balance: 0,
        deposit_allocations: { a: 0.1 + 0.2 },
        credit_allocations: {},
      })
      expect(r.is_valid).toBe(true)
      expect(r.lines[0]!.remaining).toBe(0)
    })

    it('alocação para dívida fora da lista é ignorada, não infla o total', () => {
      const r = computeDebtDistribution(input({
        deposit_allocations: { fantasma: 999, a: 100 },
      }))
      expect(r.deposit_allocated).toBe(100)
      expect(r.is_valid).toBe(true)
    })

    it('dívida sem saldo não aceita alocação nenhuma (teto zero)', () => {
      const r = computeDebtDistribution(input({
        debts: [{ id: 'a', amount_due: 0 }],
        deposit_allocations: { a: 10 },
      }))
      expect(r.lines[0]!.max_deposit).toBe(0)
      expect(r.violations).toEqual([{ code: 'LINE_EXCEEDS_DEBT', id: 'a', excess: 10 }])
    })
  })

  // CA-012 / RN-007
  it('CA-012: a linha da multa entra no mesmo cálculo, sem caminho especial', () => {
    const r = computeDebtDistribution(input({
      debts: [
        { id: 'a', amount_due: 300 },
        { id: FINE_DEBT_ID, amount_due: 150 },
      ],
      deposit_allocations: { [FINE_DEBT_ID]: 150 },
    }))
    expect(r.lines.find((l) => l.id === FINE_DEBT_ID)!.remaining).toBe(0)
    expect(r.deposit_allocated).toBe(150)
    expect(r.is_valid).toBe(true)

    // e sofre o mesmo teto por linha
    const over = computeDebtDistribution(input({
      debts: [{ id: FINE_DEBT_ID, amount_due: 150 }],
      deposit_allocations: { [FINE_DEBT_ID]: 200 },
    }))
    expect(over.violations).toEqual([{ code: 'LINE_EXCEEDS_DEBT', id: FINE_DEBT_ID, excess: 50 }])
  })
})

describe('buildTerminationAllocations', () => {
  it('RF-010: só as dívidas reais com valor > 0 vão nos arrays', () => {
    const r = computeDebtDistribution(input({
      debts: [
        { id: 'a', amount_due: 300 },
        { id: 'b', amount_due: 200 },
      ],
      deposit_allocations: { a: 300 },
      credit_allocations: { b: 150 },
    }))
    expect(buildTerminationAllocations(r)).toEqual({
      deposit_allocations: [{ charge_id: 'a', amount: 300 }],
      credit_allocations: [{ charge_id: 'b', amount: 150 }],
      fine_deposit_amount: 0,
      fine_credit_amount: 0,
    })
  })

  it('RN-007: a multa vai nos campos escalares, nunca nos arrays', () => {
    const r = computeDebtDistribution(input({
      debts: [
        { id: 'a', amount_due: 300 },
        { id: FINE_DEBT_ID, amount_due: 150 },
      ],
      deposit_allocations: { a: 100, [FINE_DEBT_ID]: 80 },
      credit_allocations: { [FINE_DEBT_ID]: 70 },
    }))
    const out = buildTerminationAllocations(r)
    expect(out.deposit_allocations).toEqual([{ charge_id: 'a', amount: 100 }])
    expect(out.credit_allocations).toEqual([])
    expect(out.fine_deposit_amount).toBe(80)
    expect(out.fine_credit_amount).toBe(70)
    expect(out.deposit_allocations.some((e) => e.charge_id === FINE_DEBT_ID)).toBe(false)
  })

  it('operador não distribui nada → arrays vazios e multa zerada', () => {
    const r = computeDebtDistribution(input())
    expect(buildTerminationAllocations(r)).toEqual({
      deposit_allocations: [],
      credit_allocations: [],
      fine_deposit_amount: 0,
      fine_credit_amount: 0,
    })
  })
})

describe('clampAllocationInput', () => {
  it('dentro do teto: o texto volta exatamente como foi digitado', () => {
    expect(clampAllocationInput('80', 100)).toBe('80')
    expect(clampAllocationInput('80,5', 100)).toBe('80,5')
    expect(clampAllocationInput('100', 100)).toBe('100')
  })

  it('acima do teto: volta o teto, formatado para o input', () => {
    expect(clampAllocationInput('150', 100)).toBe('100.00')
    expect(clampAllocationInput('100,01', 100)).toBe('100.00')
    expect(clampAllocationInput('999', 37.5)).toBe('37.50')
  })

  it('sem teto (≤ 0): o campo fica vazio, não há o que aplicar', () => {
    expect(clampAllocationInput('50', 0)).toBe('')
    expect(clampAllocationInput('0,01', 0)).toBe('')
  })

  it('digitação em andamento passa intacta — cortar no meio brigaria com quem digita', () => {
    expect(clampAllocationInput('', 100)).toBe('')
    expect(clampAllocationInput('   ', 100)).toBe('   ')
    expect(clampAllocationInput('12,', 100)).toBe('12,')
    expect(clampAllocationInput('-', 100)).toBe('-')
    expect(clampAllocationInput('abc', 100)).toBe('abc')
  })

  it('compara em centavos: ponto flutuante não corta valor exato', () => {
    expect(clampAllocationInput(String(0.1 + 0.2), 0.3)).toBe(String(0.1 + 0.2))
  })

  it('usa o teto que computeDebtDistribution calcula para a linha (saldo restante)', () => {
    // Saldo de crédito 100; a linha A já tem 80 → a B só comporta 20.
    const r = computeDebtDistribution({
      debts: [{ id: 'a', amount_due: 300 }, { id: 'b', amount_due: 200 }],
      deposit_balance: 0,
      credit_balance: 100,
      deposit_allocations: {},
      credit_allocations: { a: 80 },
    })
    const b = r.lines.find((l) => l.id === 'b')!
    expect(b.max_credit).toBe(20)
    expect(clampAllocationInput('80', b.max_credit)).toBe('20.00')
  })
})

describe('formatAllocationInput', () => {
  it('sempre duas casas, com ponto', () => {
    expect(formatAllocationInput(300)).toBe('300.00')
    expect(formatAllocationInput(12.5)).toBe('12.50')
  })
})
