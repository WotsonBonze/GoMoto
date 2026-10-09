import { describe, it, expect } from 'vitest'
import {
  calculateAccruedCharges,
  calculateAmountDue,
  allocatePayment,
  applyCredits,
  distributeProportionally,
  type LateChargePolicy,
  type ChargeBalance,
  type AvailableCredit,
} from './allocation'

const POLICY: LateChargePolicy = {
  fee_type: 'percentage',
  fee_value: 0.02,          // 2% como FRAÇÃO (modelo novo)
  daily_interest_rate: 0.001,
  grace_period_days: 3,
  min_amount: 0,
}

/** Datas fixas: nada depende do relógio real (evita o flaky de charges.spec.ts). */
const HOJE = new Date(2026, 7, 12)      // 2026-08-12

function charge(id: string, due: string, open: number): ChargeBalance {
  return {
    charge_id: id, due_date: due, total_amount: open,
    paid_amount: 0, open_amount: open, late_charge_amount: 0,
  }
}

/**
 * Linha de saldo para `calculateAmountDue`. `late_charge` é quanto do total já
 * virou item de encargo — o insumo da ADR 0028.
 */
function saldo(
  open_amount: number,
  due_date: string,
  extra: { status?: string; paid_amount?: number; late_charge?: number } = {},
) {
  return {
    open_amount,
    due_date,
    paid_amount: extra.paid_amount ?? 0,
    late_charge_amount: extra.late_charge ?? 0,
    ...(extra.status ? { status: extra.status } : {}),
  }
}

describe('calculateAccruedCharges', () => {
  it('não cobra encargo antes do vencimento', () => {
    const r = calculateAccruedCharges(POLICY, 1000, '2026-08-20', HOJE)
    expect(r.total).toBe(0)
    expect(r.days_since_due).toBe(0)
  })

  it('respeita a carência: vencida há 2 dias com carência de 3 não gera encargo', () => {
    const r = calculateAccruedCharges(POLICY, 1000, '2026-08-10', HOJE)
    expect(r.grace_period_active).toBe(true)
    expect(r.total).toBe(0)
    expect(r.days_since_due).toBe(2)
  })

  it('multa aplicada uma vez, juros por dia após a carência', () => {
    // vencida em 2026-08-02 → 10 dias; carência 3 → 7 dias de juros
    const r = calculateAccruedCharges(POLICY, 1000, '2026-08-02', HOJE)
    expect(r.days_since_due).toBe(10)
    expect(r.days_overdue).toBe(7)
    expect(r.fee).toBe(20)          // 2% de 1000
    expect(r.interest).toBe(7)      // 0.1% x 7 dias x 1000
    expect(r.total).toBe(27)
  })

  it('multa fixa não depende do principal', () => {
    const fixa: LateChargePolicy = { ...POLICY, fee_type: 'fixed', fee_value: 25 }
    const r = calculateAccruedCharges(fixa, 1000, '2026-08-02', HOJE)
    expect(r.fee).toBe(25)
  })

  it('aplica valor mínimo quando o encargo calculado fica abaixo', () => {
    const comMinimo: LateChargePolicy = { ...POLICY, min_amount: 50 }
    const r = calculateAccruedCharges(comMinimo, 1000, '2026-08-02', HOJE)
    expect(r.total).toBe(50)        // 27 calculado, elevado ao mínimo
  })

  it('sem política, não há encargo', () => {
    expect(calculateAccruedCharges(null, 1000, '2026-01-01', HOJE).total).toBe(0)
  })

  it('principal zero não gera encargo', () => {
    expect(calculateAccruedCharges(POLICY, 0, '2026-01-01', HOJE).total).toBe(0)
  })
})

describe('calculateAmountDue — fonte única do valor devido (F-05)', () => {
  it.each(['written_off', 'cancelled', 'paid'] as const)(
    'cobrança %s não deve nada e não acumula encargo',
    (status) => {
      // Regressão: a tela de cobranças exibia baixadas de 2020 devendo R$545,18
      // (principal R$300 + R$245,18 de juros que cresciam todo dia) sobre
      // dívida já reconhecida como perda. `open_amount` continua sendo a
      // aritmética do documento — quem lê precisa considerar o status.
      const r = calculateAmountDue(
        saldo(300, '2020-01-01', { status }),
        POLICY,
        HOJE,
      )
      expect(r.amount_due).toBe(0)
      expect(r.accrued.total).toBe(0)
      // O saldo do documento é preservado: é ele que registra o valor perdido.
      expect(r.open_amount).toBe(300)
    },
  )

  it('cobrança aberta e vencida segue devendo principal + encargo', () => {
    // Contraprova do caso acima: o status é o que muda o resultado, não a data.
    const r = calculateAmountDue(
      saldo(300, '2020-01-01', { status: 'open' }),
      POLICY,
      HOJE,
    )
    expect(r.amount_due).toBeGreaterThan(300)
    expect(r.accrued.total).toBeGreaterThan(0)
  })

  it('cobrança em dia deve o saldo em aberto, sem encargo', () => {
    const r = calculateAmountDue(saldo(500, '2026-08-20'), POLICY, HOJE)
    expect(r.amount_due).toBe(500)
    expect(r.accrued.total).toBe(0)
  })

  it('cobrança vencida deve saldo + encargo', () => {
    const r = calculateAmountDue(saldo(1000, '2026-08-02'), POLICY, HOJE)
    expect(r.amount_due).toBe(1027)
  })

  it('saldo parcial já abatido reduz a base do encargo', () => {
    // cobrança de 1000 com 600 pagos → encargo incide sobre 400
    const r = calculateAmountDue(saldo(400, '2026-08-02'), POLICY, HOJE)
    expect(r.accrued.fee).toBe(8)     // 2% de 400
    expect(r.amount_due).toBe(410.8)  // 400 + 8 + 2.8
  })

  it('nunca devolve valor negativo', () => {
    const r = calculateAmountDue(saldo(0, '2026-01-01'), POLICY, HOJE)
    expect(r.amount_due).toBe(0)
  })
})

describe('calculateAmountDue — encargo já realizado (ADR 0028)', () => {
  // Cenário base: cobrança de 1000 vencida em 2026-08-02. Em 12/08 são 10 dias
  // corridos, 7 depois da carência → multa 20 + juros 7 = 27 de encargo.
  // Recebida com o encargo realizado, o total vira 1027 e o item de 27 fica
  // DENTRO da cobrança. Um estorno — ou um pagamento parcial — devolve essa
  // cobrança para aberto com o encargo já lá.
  const VENCIMENTO = '2026-08-02'
  const AMANHA = new Date(2026, 7, 13)

  it('não cobra multa de novo nem juros sobre juros', () => {
    const r = calculateAmountDue(
      saldo(1027, VENCIMENTO, { status: 'open', late_charge: 27 }),
      POLICY,
      HOJE,
    )
    // Sem a regra, a apuração rodava sobre 1027: multa 20,54 + juros 7,19.
    expect(r.accrued.fee).toBe(20)          // 2% de 1000, não de 1027
    expect(r.accrued.total).toBe(27)        // o corrente, não um segundo encargo
    expect(r.late_charge_realized).toBe(27)
    expect(r.accrued_pending).toBe(0)       // nenhum dia novo passou
    expect(r.amount_due).toBe(1027)
  })

  it('no dia seguinte acrescenta só o juro do dia', () => {
    const r = calculateAmountDue(
      saldo(1027, VENCIMENTO, { status: 'open', late_charge: 27 }),
      POLICY,
      AMANHA,
    )
    expect(r.accrued.total).toBe(28)        // 8 dias de juros sobre 1000
    expect(r.accrued_pending).toBe(1)       // juro de um dia, sem multa nova
    expect(r.amount_due).toBe(1028)
  })

  it('o pagamento quita o encargo antes do principal (art. 354 CC)', () => {
    // Pagou exatamente os 27 do encargo: o principal continua inteiro, e é
    // sobre ele que a apuração roda.
    const r = calculateAmountDue(
      saldo(1000, VENCIMENTO, { status: 'open', paid_amount: 27, late_charge: 27 }),
      POLICY,
      HOJE,
    )
    expect(r.accrued.fee).toBe(20)          // 2% de 1000
    expect(r.accrued_pending).toBe(0)
    expect(r.amount_due).toBe(1000)
  })

  it('pagamento parcial do principal trava em zero, nunca devolve encargo', () => {
    // Pagou 527 (os 27 do encargo + 500 do principal). O corrente sobre os 500
    // que sobraram vale 13,50 — menos que os 27 já documentados. A diferença
    // não vira crédito nem some do documento: apenas nada se acrescenta até o
    // corrente voltar a passar de 27. Subcobra, jamais sobrecobra.
    const r = calculateAmountDue(
      saldo(500, VENCIMENTO, { status: 'open', paid_amount: 527, late_charge: 27 }),
      POLICY,
      HOJE,
    )
    expect(r.accrued.total).toBe(13.5)
    expect(r.accrued_pending).toBe(0)
    expect(r.amount_due).toBe(500)
  })

  it('cobrança sem encargo realizado continua exatamente como antes', () => {
    const r = calculateAmountDue(saldo(1000, VENCIMENTO, { status: 'open' }), POLICY, HOJE)
    expect(r.late_charge_realized).toBe(0)
    expect(r.accrued_pending).toBe(27)
    expect(r.amount_due).toBe(1027)
  })
})

describe('allocatePayment', () => {
  it('quita integralmente uma cobrança', () => {
    const { allocations, unallocated } = allocatePayment(500, [charge('a', '2026-08-01', 500)])
    expect(allocations).toEqual([{ charge_id: 'a', amount: 500 }])
    expect(unallocated).toBe(0)
  })

  it('pagamento parcial aloca o que cabe e deixa saldo na cobrança', () => {
    const { allocations, unallocated } = allocatePayment(300, [charge('a', '2026-08-01', 700)])
    expect(allocations).toEqual([{ charge_id: 'a', amount: 300 }])
    expect(unallocated).toBe(0)
  })

  it('abate da MAIS ANTIGA primeiro, não da recém-criada', () => {
    const { allocations } = allocatePayment(600, [
      charge('nova',  '2026-08-10', 500),
      charge('antiga','2026-07-01', 500),
    ])
    expect(allocations[0]!.charge_id).toBe('antiga')
    expect(allocations[0]!.amount).toBe(500)
    expect(allocations[1]!.charge_id).toBe('nova')
    expect(allocations[1]!.amount).toBe(100)
  })

  it('um pagamento cobre várias cobranças', () => {
    const { allocations, unallocated } = allocatePayment(1000, [
      charge('a', '2026-07-01', 400),
      charge('b', '2026-07-15', 400),
      charge('c', '2026-08-01', 400),
    ])
    expect(allocations).toHaveLength(3)
    expect(allocations.map((a) => a.amount)).toEqual([400, 400, 200])
    expect(unallocated).toBe(0)
  })

  it('sobra é devolvida para virar crédito', () => {
    const { allocations, unallocated } = allocatePayment(800, [charge('a', '2026-08-01', 500)])
    expect(allocations).toEqual([{ charge_id: 'a', amount: 500 }])
    expect(unallocated).toBe(300)
  })

  it('a soma das alocações nunca excede o pagamento', () => {
    const { allocations } = allocatePayment(250, [
      charge('a', '2026-07-01', 400),
      charge('b', '2026-07-15', 400),
    ])
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBe(250)
  })

  it('ignora cobrança já quitada', () => {
    const { allocations } = allocatePayment(100, [
      { ...charge('quitada', '2026-07-01', 0), total_amount: 500, paid_amount: 500 },
      charge('aberta', '2026-08-01', 100),
    ])
    expect(allocations).toEqual([{ charge_id: 'aberta', amount: 100 }])
  })

  it('rejeita pagamento não positivo', () => {
    expect(() => allocatePayment(0, [])).toThrow(/positivo/)
    expect(() => allocatePayment(-5, [])).toThrow(/positivo/)
  })

  it('ordenação é determinística no empate de vencimento', () => {
    const r1 = allocatePayment(100, [charge('b', '2026-08-01', 100), charge('a', '2026-08-01', 100)])
    const r2 = allocatePayment(100, [charge('a', '2026-08-01', 100), charge('b', '2026-08-01', 100)])
    expect(r1.allocations[0]!.charge_id).toBe(r2.allocations[0]!.charge_id)
  })
})

describe('applyCredits — corrige F-06', () => {
  it('usa TODOS os créditos, não apenas o primeiro', () => {
    // O bug antigo: LIMIT 1 abateria só 50 de uma dívida de 120.
    const credits: AvailableCredit[] = [
      { id: 'c1', amount: 50, available: 50 },
      { id: 'c2', amount: 50, available: 50 },
      { id: 'c3', amount: 50, available: 50 },
    ]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 120)], HOJE)

    expect(applications.reduce((s, a) => s + a.amount, 0)).toBe(120)
    expect(applications).toHaveLength(3)
    expect(applications[2]!.amount).toBe(20)   // o terceiro entra só com o resto
  })

  it('abate a cobrança de vencimento mais antigo', () => {
    const credits: AvailableCredit[] = [{ id: 'c1', amount: 300, available: 300 }]
    const { applications } = applyCredits(credits, [
      charge('nova',   '2026-08-10', 200),
      charge('antiga', '2026-07-01', 200),
    ], HOJE)

    expect(applications[0]!.charge_id).toBe('antiga')
  })

  it('ignora crédito expirado', () => {
    const credits: AvailableCredit[] = [
      { id: 'vencido', amount: 100, available: 100, expires_at: '2026-08-11' },
      { id: 'valido',  amount: 100, available: 100, expires_at: '2026-12-31' },
    ]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 150)], HOJE)

    expect(applications.every((a) => a.credit_id === 'valido')).toBe(true)
    expect(applications.reduce((s, a) => s + a.amount, 0)).toBe(100)
  })

  it('crédito que expira hoje ainda é usável', () => {
    const credits: AvailableCredit[] = [{ id: 'c', amount: 100, available: 100, expires_at: '2026-08-12' }]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 100)], HOJE)
    expect(applications).toHaveLength(1)
  })

  it('consome o crédito que expira antes primeiro', () => {
    const credits: AvailableCredit[] = [
      { id: 'longe', amount: 100, available: 100, expires_at: '2026-12-31' },
      { id: 'perto', amount: 100, available: 100, expires_at: '2026-09-01' },
    ]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 50)], HOJE)
    expect(applications[0]!.credit_id).toBe('perto')
  })

  it('crédito sem expiração é usado por último', () => {
    const credits: AvailableCredit[] = [
      { id: 'eterno', amount: 100, available: 100 },
      { id: 'expira', amount: 100, available: 100, expires_at: '2026-09-01' },
    ]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 50)], HOJE)
    expect(applications[0]!.credit_id).toBe('expira')
  })

  it('devolve o saldo de crédito não consumido', () => {
    const credits: AvailableCredit[] = [{ id: 'c', amount: 500, available: 500 }]
    const { applications, remainingCredit } = applyCredits(credits, [charge('x', '2026-08-01', 200)], HOJE)
    expect(applications[0]!.amount).toBe(200)
    expect(remainingCredit).toBe(300)
  })

  it('sem cobrança em aberto, nada é aplicado e o saldo permanece', () => {
    const credits: AvailableCredit[] = [{ id: 'c', amount: 500, available: 500 }]
    const { applications, remainingCredit } = applyCredits(credits, [], HOJE)
    expect(applications).toHaveLength(0)
    expect(remainingCredit).toBe(500)
  })

  it('nunca aplica mais do que o crédito disponível', () => {
    const credits: AvailableCredit[] = [{ id: 'c', amount: 100, available: 40 }]
    const { applications } = applyCredits(credits, [charge('x', '2026-08-01', 500)], HOJE)
    expect(applications.reduce((s, a) => s + a.amount, 0)).toBe(40)
  })
})

describe('distributeProportionally', () => {
  it('bucket único recebe o valor inteiro', () => {
    const partes = distributeProportionally(100, [{ key: 'a', weight: 350 }])
    expect(partes).toEqual([{ key: 'a', amount: 100 }])
  })

  it('rateia proporcionalmente ao peso de cada bucket', () => {
    const partes = distributeProportionally(100, [
      { key: 'a', weight: 300 },
      { key: 'b', weight: 100 },
    ])
    expect(partes.find((p) => p.key === 'a')!.amount).toBe(75)
    expect(partes.find((p) => p.key === 'b')!.amount).toBe(25)
  })

  it('a soma das partes sempre fecha no valor total, mesmo com resto de arredondamento', () => {
    // 10 rateado em 3 pesos iguais dá 3,33/3,33/3,33 — sobra 0,01 que precisa
    // ir para algum lugar, senão a transação não fecha em zero (Princípio 1).
    const partes = distributeProportionally(10, [
      { key: 'a', weight: 1 },
      { key: 'b', weight: 1 },
      { key: 'c', weight: 1 },
    ])
    const soma = Math.round(partes.reduce((s, p) => s + p.amount, 0) * 100) / 100
    expect(soma).toBe(10)
  })

  it('ignora bucket com peso zero ou negativo', () => {
    const partes = distributeProportionally(50, [
      { key: 'a', weight: 100 },
      { key: 'b', weight: 0 },
      { key: 'c', weight: -20 },
    ])
    expect(partes).toEqual([{ key: 'a', amount: 50 }])
  })

  it('sem buckets com peso positivo, não distribui nada', () => {
    expect(distributeProportionally(50, [])).toEqual([])
    expect(distributeProportionally(50, [{ key: 'a', weight: 0 }])).toEqual([])
  })

  it('valor zero ou negativo não distribui nada', () => {
    expect(distributeProportionally(0, [{ key: 'a', weight: 100 }])).toEqual([])
    expect(distributeProportionally(-10, [{ key: 'a', weight: 100 }])).toEqual([])
  })
})
