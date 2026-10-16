import { describe, it, expect } from 'vitest'
import { postProcessCnhFields, stripRgIssuer, validateCnhRegistro } from './cnh'
import type { CnhFields } from './registry'

const TODAY = new Date('2026-10-15T12:00:00Z')

function fields(overrides: Partial<CnhFields> = {}): CnhFields {
  return {
    name: { value: 'MARIA DA SILVA', confidence: 'high' },
    cpf: { value: '52998224725', confidence: 'high' },
    rg: { value: '123456789', confidence: 'high' },
    birth_date: { value: '1990-05-12', confidence: 'high' },
    drivers_license: { value: '12345678900', confidence: 'high' },
    drivers_license_category: { value: 'B', confidence: 'high' },
    drivers_license_validity: { value: '2030-05-12', confidence: 'high' },
    ...overrides,
  }
}

describe('validateCnhRegistro', () => {
  it('aceita registro com DV correto', () => {
    expect(validateCnhRegistro('12345678900')).toBe(true)
    expect(validateCnhRegistro('02650306461')).toBe(true)
  })
  it('rejeita DV errado', () => expect(validateCnhRegistro('12345678901')).toBe(false))
  it('rejeita tamanho diferente de 11 (ex.: Nº Espelho de 10 dígitos)', () =>
    expect(validateCnhRegistro('2408149527')).toBe(false))
  it('rejeita sequência trivial', () => expect(validateCnhRegistro('00000000000')).toBe(false))
})

describe('stripRgIssuer', () => {
  it('remove órgão emissor e UF', () => {
    expect(stripRgIssuer('254954811 DETRAN RJ')).toBe('254954811')
    expect(stripRgIssuer('12.345.678-9 SSP/SP')).toBe('12.345.678-9')
    expect(stripRgIssuer('1234567 SSP-DS DF')).toBe('1234567')
  })
  it('preserva prefixo de UF colado ao número', () => expect(stripRgIssuer('MG-12.345.678 SSP MG')).toBe('MG-12.345.678'))
  it('mantém valor que já é só o número', () => expect(stripRgIssuer('123456789')).toBe('123456789'))
})

describe('postProcessCnhFields', () => {
  it('mantém extração válida intacta', () => {
    expect(postProcessCnhFields(fields(), TODAY)).toEqual(fields())
  })

  it('tira pontuação do CPF e mantém high quando o DV confere', () => {
    const out = postProcessCnhFields(fields({ cpf: { value: '529.982.247-25', confidence: 'high' } }), TODAY)
    expect(out.cpf).toEqual({ value: '52998224725', confidence: 'high' })
  })

  it('CPF com DV errado vira low, sem descartar o valor', () => {
    const out = postProcessCnhFields(fields({ cpf: { value: '52998224726', confidence: 'high' } }), TODAY)
    expect(out.cpf).toEqual({ value: '52998224726', confidence: 'low' })
  })

  it('Registro com 10 dígitos (Nº Espelho lido no lugar) vira low', () => {
    const out = postProcessCnhFields(fields({ drivers_license: { value: '2408149527', confidence: 'high' } }), TODAY)
    expect(out.drivers_license).toEqual({ value: '2408149527', confidence: 'low' })
  })

  it('CPF igual ao Registro marca os dois como low', () => {
    const out = postProcessCnhFields(fields({ cpf: { value: '12345678900', confidence: 'high' } }), TODAY)
    expect(out.cpf.confidence).toBe('low')
    expect(out.drivers_license.confidence).toBe('low')
  })

  it('remove órgão emissor do RG', () => {
    const out = postProcessCnhFields(fields({ rg: { value: '254954811 DETRAN RJ', confidence: 'high' } }), TODAY)
    expect(out.rg).toEqual({ value: '254954811', confidence: 'high' })
  })

  it('converte data DD/MM/AAAA para ISO', () => {
    const out = postProcessCnhFields(fields({ drivers_license_validity: { value: '31/05/2032', confidence: 'high' } }), TODAY)
    expect(out.drivers_license_validity).toEqual({ value: '2032-05-31', confidence: 'high' })
  })

  it('data impossível vira null + low', () => {
    const out = postProcessCnhFields(fields({ birth_date: { value: '1990-02-31', confidence: 'high' } }), TODAY)
    expect(out.birth_date).toEqual({ value: null, confidence: 'low' })
  })

  it('nascimento com menos de 18 anos vira low (provável data de emissão/1ª habilitação)', () => {
    const out = postProcessCnhFields(fields({ birth_date: { value: '2022-06-06', confidence: 'high' } }), TODAY)
    expect(out.birth_date.confidence).toBe('low')
  })

  it('validade anterior ao nascimento marca as duas datas como low', () => {
    const out = postProcessCnhFields(
      fields({
        birth_date: { value: '1990-05-12', confidence: 'high' },
        drivers_license_validity: { value: '1985-01-01', confidence: 'high' },
      }),
      TODAY,
    )
    expect(out.birth_date.confidence).toBe('low')
    expect(out.drivers_license_validity.confidence).toBe('low')
  })

  it('preserva campos null como estão', () => {
    const empty = fields({ cpf: { value: null, confidence: 'low' }, rg: { value: null, confidence: 'high' } })
    const out = postProcessCnhFields(empty, TODAY)
    expect(out.cpf).toEqual({ value: null, confidence: 'low' })
    expect(out.rg).toEqual({ value: null, confidence: 'high' })
  })
})
