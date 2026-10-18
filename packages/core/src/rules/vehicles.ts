import type { VehicleStatus } from '../schemas/vehicles'

export interface VehicleIdleInput {
  status: VehicleStatus
  updated_at: string
}

const DAY_MS = 86_400_000

/**
 * Considera um veículo "ocioso" quando está disponível e não recebeu
 * atualização há mais de `idleDays` dias. Default = 7 dias (regra atual
 * do painel "veículos parados").
 */
export function isIdleVehicle(
  vehicle: VehicleIdleInput,
  today: Date = new Date(),
  idleDays = 7,
): boolean {
  if (vehicle.status !== 'available') return false
  const threshold = today.getTime() - idleDays * DAY_MS
  return new Date(vehicle.updated_at).getTime() <= threshold
}

/**
 * Ano modelo é o mesmo da fabricação ou o seguinte — é o que o DENATRAN aceita
 * (uma moto fabricada em 2025 sai como 2025 ou 2026). Fora disso é digitação
 * errada. Só valida quando os dois anos vêm com 4 dígitos; formato é problema
 * do schema.
 */
export function isVehicleModelYearCoherent(
  yearManufacture: string | null | undefined,
  yearModel: string | null | undefined,
): boolean {
  if (!yearManufacture || !yearModel) return true
  if (!/^\d{4}$/.test(yearManufacture) || !/^\d{4}$/.test(yearModel)) return true
  const diff = Number(yearModel) - Number(yearManufacture)
  return diff === 0 || diff === 1
}

/**
 * Tipo do veículo a partir do campo ESPÉCIE/TIPO do CRLV
 * (ex.: "PASSAGEIRO MOTOCICLETA", "PASSAGEIRO AUTOMOVEL").
 * `null` quando o texto não permite decidir — o operador escolhe.
 */
export function vehicleTypeFromCrlv(especieTipo: string | null | undefined): 'motorcycle' | 'car' | null {
  if (!especieTipo) return null
  const t = especieTipo.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  if (/MOTOCICLETA|MOTONETA|CICLOMOTOR|TRICICLO|QUADRICICLO/.test(t)) return 'motorcycle'
  if (/AUTOMOVEL|CAMINHONETE|CAMIONETA|UTILITARIO/.test(t)) return 'car'
  return null
}

/**
 * KM de entrada é gravado uma vez só (RN-010): pode ir de vazio para um valor,
 * nunca trocar nem ser apagado. Devolve o valor a gravar na edição, ou
 * `undefined` quando o campo deve ser ignorado. O banco tem a mesma trava
 * (trigger `vehicles_km_entry_guard`).
 */
export function resolveKmEntryUpdate(
  currentKmEntry: number | null | undefined,
  requested: number | null | undefined,
): number | undefined {
  if (currentKmEntry != null) return undefined
  if (requested == null) return undefined
  return requested
}

/** O campo de KM de entrada aparece na edição enquanto não foi preenchido. */
export function canEditKmEntry(currentKmEntry: number | null | undefined): boolean {
  return currentKmEntry == null
}
