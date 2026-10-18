import { describe, expect, it } from 'vitest'
import { TenantContactInputSchema } from './tenantContacts'

describe('TenantContactInputSchema', () => {
  it('normaliza telefone mascarado para dígitos', () => {
    const r = TenantContactInputSchema.parse({ label: ' Financeiro ', phone: '(11) 98765-4321' })
    expect(r).toEqual({
      label: 'Financeiro', phone: '11987654321', phone_kind: 'phone', email: null, business_hours: null,
    })
  })

  it('aceita só e-mail', () => {
    const r = TenantContactInputSchema.parse({ label: 'Manutenção', phone: '', email: 'oficina@x.com' })
    expect(r.phone).toBeNull()
    expect(r.email).toBe('oficina@x.com')
  })

  it('exige telefone ou e-mail', () => {
    const r = TenantContactInputSchema.safeParse({ label: 'Financeiro', phone: '', email: '  ' })
    expect(r.success).toBe(false)
  })

  it('rejeita telefone sem DDD', () => {
    expect(TenantContactInputSchema.safeParse({ label: 'X', phone: '98765-4321' }).success).toBe(false)
  })

  it('rejeita e-mail inválido e rótulo vazio', () => {
    expect(TenantContactInputSchema.safeParse({ label: 'X', email: 'sem-arroba' }).success).toBe(false)
    expect(TenantContactInputSchema.safeParse({ label: '  ', phone: '11987654321' }).success).toBe(false)
  })

  it('guarda tipo WhatsApp e horário de atendimento', () => {
    const r = TenantContactInputSchema.parse({
      label: 'Financeiro', phone: '11987654321', phone_kind: 'whatsapp', business_hours: ' Seg a sex, 8h às 18h ',
    })
    expect(r.phone_kind).toBe('whatsapp')
    expect(r.business_hours).toBe('Seg a sex, 8h às 18h')
  })

  it('rejeita tipo de número desconhecido', () => {
    expect(TenantContactInputSchema.safeParse({ label: 'X', phone: '11987654321', phone_kind: 'sms' }).success).toBe(false)
  })
})
