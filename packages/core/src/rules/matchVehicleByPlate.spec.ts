import { describe, it, expect } from 'vitest'
import { matchVehicleByPlate } from './matchVehicleByPlate'
import type { Vehicle } from '../types/index'

function buildVehicle(overrides: Partial<Vehicle>): Vehicle {
  return {
    id: 'v1',
    tenant_id: 't1',
    license_plate: 'ABC-1234',
    model: 'CG 160',
    make: 'Honda',
    year_manufacture: '2022',
    color: 'Vermelha',
    vehicle_type: 'motorcycle',
    renavam: '12345678901',
    chassis: '9BWZZZ377VT004251',
    status: 'available',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('matchVehicleByPlate', () => {
  it('encontra match exato', () => {
    const vehicles = [buildVehicle({ id: 'v1', license_plate: 'ABC-1234' })]
    expect(matchVehicleByPlate('ABC-1234', vehicles)).toEqual(vehicles[0])
  })

  it('sem match retorna null (CA-009/RN-006)', () => {
    const vehicles = [buildVehicle({ id: 'v1', license_plate: 'ABC-1234' })]
    expect(matchVehicleByPlate('XYZ-9999', vehicles)).toBeNull()
  })

  it('retorna null quando a placa extraída é null', () => {
    const vehicles = [buildVehicle({ id: 'v1', license_plate: 'ABC-1234' })]
    expect(matchVehicleByPlate(null, vehicles)).toBeNull()
  })

  it('normaliza formatação de placa — hífen e minúsculas na entrada extraída', () => {
    const vehicles = [buildVehicle({ id: 'v1', license_plate: 'ABC1234' })]
    expect(matchVehicleByPlate('abc-1234', vehicles)).toEqual(vehicles[0])
  })

  it('normaliza formatação de placa — placa Mercosul sem hífen no cadastro', () => {
    const vehicles = [buildVehicle({ id: 'v1', license_plate: 'ABC1D23' })]
    expect(matchVehicleByPlate('ABC 1D23', vehicles)).toEqual(vehicles[0])
  })
})
