import { describe, expect, it } from 'vitest'
import { isIdleVehicle, isVehicleModelYearCoherent, vehicleTypeFromCrlv, resolveKmEntryUpdate, canEditKmEntry } from './vehicles'

const TODAY = new Date('2026-06-10T12:00:00')

describe('isIdleVehicle', () => {
  it('available + sem update há 10 dias → ocioso', () => {
    expect(isIdleVehicle(
      { status: 'available', updated_at: '2026-05-31T12:00:00Z' },
      TODAY,
    )).toBe(true)
  })

  it('available + atualizado ontem → não ocioso', () => {
    expect(isIdleVehicle(
      { status: 'available', updated_at: '2026-06-09T12:00:00Z' },
      TODAY,
    )).toBe(false)
  })

  it('alugado nunca é ocioso', () => {
    expect(isIdleVehicle(
      { status: 'rented', updated_at: '2025-01-01T00:00:00Z' },
      TODAY,
    )).toBe(false)
  })

  it('aceita threshold customizado', () => {
    expect(isIdleVehicle(
      { status: 'available', updated_at: '2026-06-05T12:00:00Z' },
      TODAY,
      3,
    )).toBe(true)
  })
})

describe('isVehicleModelYearCoherent', () => {
  it('aceita ano modelo igual ou seguinte ao de fabricação', () => {
    expect(isVehicleModelYearCoherent('2025', '2025')).toBe(true)
    expect(isVehicleModelYearCoherent('2025', '2026')).toBe(true)
  })
  it('rejeita ano modelo anterior ou dois anos à frente', () => {
    expect(isVehicleModelYearCoherent('2025', '2024')).toBe(false)
    expect(isVehicleModelYearCoherent('2025', '2027')).toBe(false)
  })
  it('não opina quando falta um dos anos', () => {
    expect(isVehicleModelYearCoherent('2025', null)).toBe(true)
    expect(isVehicleModelYearCoherent(undefined, '2025')).toBe(true)
  })
})

describe('vehicleTypeFromCrlv', () => {
  it('reconhece moto pelas espécies do CTB', () => {
    expect(vehicleTypeFromCrlv('PASSAGEIRO MOTOCICLETA')).toBe('motorcycle')
    expect(vehicleTypeFromCrlv('PASSAGEIRO MOTONETA')).toBe('motorcycle')
  })
  it('reconhece carro, com ou sem acento', () => {
    expect(vehicleTypeFromCrlv('PASSAGEIRO AUTOMOVEL')).toBe('car')
    expect(vehicleTypeFromCrlv('PASSAGEIRO AUTOMÓVEL')).toBe('car')
  })
  it('devolve null quando não dá para decidir', () => {
    expect(vehicleTypeFromCrlv(null)).toBeNull()
    expect(vehicleTypeFromCrlv('CARGA CAMINHAO')).toBeNull()
  })
})

describe('KM de entrada — gravado uma vez', () => {
  it('aceita o primeiro preenchimento', () => {
    expect(resolveKmEntryUpdate(null, 15000)).toBe(15000)
    expect(resolveKmEntryUpdate(undefined, 0)).toBe(0)
  })
  it('ignora troca de valor já gravado', () => {
    expect(resolveKmEntryUpdate(15000, 16000)).toBeUndefined()
  })
  it('não apaga valor já gravado', () => {
    expect(resolveKmEntryUpdate(15000, null)).toBeUndefined()
  })
  it('sem valor pedido, nada a gravar', () => {
    expect(resolveKmEntryUpdate(null, null)).toBeUndefined()
  })
  it('campo editável só enquanto vazio', () => {
    expect(canEditKmEntry(null)).toBe(true)
    expect(canEditKmEntry(0)).toBe(false)
  })
})
