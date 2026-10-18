import { describe, it, expect } from 'vitest'
import { parseLoginSubdomain } from './login-subdomain'
import { LoginSubdomainSchema } from '../schemas/loginBranding'

describe('parseLoginSubdomain', () => {
  const root = 'locaw.com.br'

  it('extrai o subdomínio da locadora', () => {
    expect(parseLoginSubdomain('motosrj.locaw.com.br', root)).toBe('motosrj')
  })

  it('ignora porta, maiúsculas e ponto final', () => {
    expect(parseLoginSubdomain('MotosRJ.Locaw.com.br:443', root)).toBe('motosrj')
    expect(parseLoginSubdomain('motosrj.locaw.com.br.', root)).toBe('motosrj')
  })

  it('domínio raiz e www não são locadora', () => {
    expect(parseLoginSubdomain('locaw.com.br', root)).toBeNull()
    expect(parseLoginSubdomain('www.locaw.com.br', root)).toBeNull()
  })

  it('reservados, rótulos aninhados e formato inválido devolvem null', () => {
    expect(parseLoginSubdomain('admin.locaw.com.br', root)).toBeNull()
    expect(parseLoginSubdomain('a.b.locaw.com.br', root)).toBeNull()
    expect(parseLoginSubdomain('-motos.locaw.com.br', root)).toBeNull()
    expect(parseLoginSubdomain('motos_rj.locaw.com.br', root)).toBeNull()
  })

  it('host de outro domínio cai no padrão', () => {
    expect(parseLoginSubdomain('gomotos-web.vercel.app', root)).toBeNull()
    expect(parseLoginSubdomain('evil-locaw.com.br', root)).toBeNull()
    expect(parseLoginSubdomain(null, root)).toBeNull()
  })

  it('funciona com localhost em desenvolvimento', () => {
    expect(parseLoginSubdomain('motosrj.localhost:3000', 'localhost')).toBe('motosrj')
    expect(parseLoginSubdomain('localhost:3000', 'localhost')).toBeNull()
  })
})

describe('LoginSubdomainSchema', () => {
  it('normaliza e aceita rótulo válido', () => {
    expect(LoginSubdomainSchema.parse('  MotosRJ ')).toBe('motosrj')
    expect(LoginSubdomainSchema.parse('motos-rj-2')).toBe('motos-rj-2')
  })

  it('rejeita reservado, hífen nas pontas, ponto e mais de 63 caracteres', () => {
    expect(LoginSubdomainSchema.safeParse('www').success).toBe(false)
    expect(LoginSubdomainSchema.safeParse('motos-').success).toBe(false)
    expect(LoginSubdomainSchema.safeParse('motos.rj').success).toBe(false)
    expect(LoginSubdomainSchema.safeParse('a'.repeat(64)).success).toBe(false)
  })
})
