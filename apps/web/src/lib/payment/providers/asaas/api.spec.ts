import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  acceptedEnvironment, environmentOfKey, isAcceptableWebhookToken, keyCanWithdraw, maskDocument,
} from './api'

const conn = { apiKey: '$aact_hmlg_' + 'x'.repeat(40), environment: 'sandbox' as const }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

describe('environmentOfKey', () => {
  it('o prefixo diz o ambiente', () => {
    expect(environmentOfKey('$aact_prod_' + 'a'.repeat(40))).toBe('production')
    expect(environmentOfKey('$aact_hmlg_' + 'a'.repeat(40))).toBe('sandbox')
  })

  it('o que não parece chave do Asaas é recusado antes da rede', () => {
    expect(environmentOfKey('aact_prod_' + 'a'.repeat(40))).toBeNull()
    expect(environmentOfKey('$aact_prod_curta')).toBeNull()
    expect(environmentOfKey('$aact_prod_' + 'a'.repeat(20) + ' espaço')).toBeNull()
  })
})

describe('acceptedEnvironment', () => {
  it('produção da Vercel aceita só produção; o resto, sandbox', () => {
    vi.stubEnv('ASAAS_ENVIRONMENT', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(acceptedEnvironment()).toBe('production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(acceptedEnvironment()).toBe('sandbox')
  })

  it('ASAAS_ENVIRONMENT explícito vence', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('ASAAS_ENVIRONMENT', 'sandbox')
    expect(acceptedEnvironment()).toBe('sandbox')
  })
})

describe('keyCanWithdraw — sonda de privilégio', () => {
  it('403 insufficient_permission = chave SEM saque (verificado no sandbox)', async () => {
    respond(403, { errors: [{ code: 'insufficient_permission', description: 'sem saque' }] })
    await expect(keyCanWithdraw(conn)).resolves.toBe(false)
  })

  it('200 = chave COM saque (verificado com a chave pagadora)', async () => {
    respond(200, { data: [] })
    await expect(keyCanWithdraw(conn)).resolves.toBe(true)
  })

  it('qualquer outra resposta é "não sei", e "não sei" não autoriza gravar', async () => {
    respond(500, {})
    await expect(keyCanWithdraw(conn)).rejects.toThrow()
  })
})

describe('isAcceptableWebhookToken — regras do Asaas', () => {
  it('32 a 255 caracteres, sem espaço, sem 5 iguais seguidos', () => {
    expect(isAcceptableWebhookToken('ab'.repeat(16))).toBe(true)
    expect(isAcceptableWebhookToken('ab'.repeat(15))).toBe(false)
    expect(isAcceptableWebhookToken('ab'.repeat(16) + ' x')).toBe(false)
    expect(isAcceptableWebhookToken('aaaaa' + 'bc'.repeat(16))).toBe(false)
    expect(isAcceptableWebhookToken('aaaa' + 'bc'.repeat(16))).toBe(true)
  })
})

describe('maskDocument', () => {
  it('CPF e CNPJ saem mascarados', () => {
    expect(maskDocument('15160686703')).toBe('***.606.867-**')
    expect(maskDocument('12.345.678/0001-90')).toBe('**.***.***/0001-**')
  })
})
