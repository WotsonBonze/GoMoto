import { describe, it, expect } from 'vitest'
import { toHistoryRow } from './gateway-history'

const base = {
  id: '1', action: 'gateway_deleted' as const, created_at: '2026-10-11T00:07:03Z', provider: 'infinitepay',
  account_label: '$wat-motos', external_account_id: 'wat-motos', actor_email: null, actor_system: null,
}

describe('toHistoryRow', () => {
  it('mostra quem fez pelo e-mail gravado no momento', () => {
    const r = toHistoryRow({ ...base, action: 'gateway_connected', actor_email: 'dono@locadora.com' })
    expect(r).toMatchObject({ gateway: 'InfinitePay', action: 'Conectada', account: '$wat-motos', actor: 'dono@locadora.com' })
  })

  it('data e hora no fuso da locadora (00:07 UTC = 21:07 do dia anterior em Brasília)', () => {
    expect(toHistoryRow(base).when).toBe('10/10/2026, 21:07')
  })

  it('a limpeza feita pela migration aparece como ajuste do sistema, não como alguém', () => {
    expect(toHistoryRow({ ...base, actor_system: 'system:migration_0039' }).actor).toBe('Sistema (ajuste de dados)')
  })

  it('sem rótulo, mostra a conta no provedor', () => {
    expect(toHistoryRow({ ...base, account_label: null }).account).toBe('wat-motos')
  })
})
