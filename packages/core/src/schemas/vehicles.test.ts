import { describe, it, expect } from 'vitest'
import { VehicleSchema } from './vehicles'

const base = {
  license_plate: 'ABC1D23',
  renavam: '12345678901',
  make: 'Honda',
  model: 'CG 160',
  vehicle_type: 'motorcycle',
  year_manufacture: '2025',
  year_model: '2026',
  color: 'PRETA',
}

describe('VehicleSchema — IMEI', () => {
  it('rejeita IMEI com 5 dígitos', () => {
    const result = VehicleSchema.safeParse({
      ...base,
      has_tracker: true,
      tracker_brand: 'Rastrear',
      tracker_model: 'X1',
      tracker_imei: '12345',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('15 dígitos'))).toBe(true)
    }
  })

  it('aceita IMEI com 15 dígitos', () => {
    const result = VehicleSchema.safeParse({
      ...base,
      has_tracker: true,
      tracker_brand: 'Rastrear',
      tracker_model: 'X1',
      tracker_imei: '123456789012345',
    })
    expect(result.success).toBe(true)
  })

  it('exige marca/modelo/IMEI quando has_tracker=true', () => {
    const result = VehicleSchema.safeParse({
      ...base,
      has_tracker: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('rastreador'))).toBe(true)
    }
  })

  it('exige valor/vencimento quando has_insurance=true', () => {
    const result = VehicleSchema.safeParse({
      ...base,
      has_insurance: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('seguro'))).toBe(true)
    }
  })
})

describe('VehicleSchema — campos obrigatórios', () => {
  it('rejeita sem license_plate', () => {
    const { license_plate: _, ...rest } = base
    const result = VehicleSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it.each(['vehicle_type', 'year_manufacture', 'year_model', 'color'] as const)('rejeita sem %s', (key) => {
    const { [key]: _, ...rest } = base
    expect(VehicleSchema.safeParse(rest).success).toBe(false)
  })

  it('aceita sem renavam e sem chassi', () => {
    const { renavam: _, ...rest } = base
    expect(VehicleSchema.safeParse(rest).success).toBe(true)
  })

  it('grava renavam e chassi vazios como null (índice único por tenant)', () => {
    const result = VehicleSchema.safeParse({ ...base, renavam: '', chassis: '  ' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.renavam).toBeNull()
      expect(result.data.chassis).toBeNull()
    }
  })

  it('rejeita ano com formato inválido', () => {
    expect(VehicleSchema.safeParse({ ...base, year_manufacture: '25' }).success).toBe(false)
  })

  it('rejeita ano modelo incoerente com a fabricação', () => {
    const result = VehicleSchema.safeParse({ ...base, year_manufacture: '2025', year_model: '2023' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].path).toEqual(['year_model'])
  })

  it('rejeita tipo de veículo desconhecido', () => {
    expect(VehicleSchema.safeParse({ ...base, vehicle_type: 'truck' }).success).toBe(false)
  })

  it('rejeita sem make', () => {
    const { make: _, ...rest } = base
    const result = VehicleSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejeita sem model', () => {
    const { model: _, ...rest } = base
    const result = VehicleSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('aceita sem campos opcionais', () => {
    const result = VehicleSchema.safeParse(base)
    expect(result.success).toBe(true)
  })
})
