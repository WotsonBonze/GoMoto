import { describe, it, expect } from 'vitest'
import { buildGatewayRows } from './gateway-rows'

const conta = (over: Partial<{ id: string; provider: string; is_default: boolean; active: boolean }>) => ({
  id: 'x', provider: 'asaas', external_account_id: 'w', account_label: null, is_default: false, active: false, ...over,
})

const asaas = (accounts: ReturnType<typeof conta>[]) =>
  buildGatewayRows(accounts as never).find((r) => r.descriptor.id === 'asaas')!

describe('buildGatewayRows — conta que representa o provedor', () => {
  it('sandbox desconectada + produção conectada: mostra a CONECTADA, em qualquer ordem', () => {
    const sandbox = conta({ id: 'sandbox', active: false })
    const prod = conta({ id: 'prod', active: true })
    for (const ordem of [[sandbox, prod], [prod, sandbox]]) {
      const r = asaas(ordem)
      expect(r.account?.id).toBe('prod')
      expect([r.connected, r.billing]).toEqual([true, false])
    }
  })

  it('a que cobra vence a que só está conectada', () => {
    const r = asaas([conta({ id: 'a', active: true }), conta({ id: 'b', active: true, is_default: true })])
    expect(r.account?.id).toBe('b')
    expect(r.billing).toBe(true)
  })

  it('só desconectadas: mostra uma, com Reconectar', () => {
    const r = asaas([conta({ id: 'velha', active: false })])
    expect([r.account?.id, r.connected]).toEqual(['velha', false])
  })

  it('sem conta: provedor aparece sem conta', () => {
    expect(asaas([]).account).toBeNull()
  })
})
