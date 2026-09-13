import { test, expect } from '@playwright/test'
import {
  getSupabaseAdmin, getTestTenantId,
  createTestVehicle, deleteTestVehicle, createTestCustomer, deleteTestCustomer,
} from './helpers'
import { generateSchedule } from '@gomoto/core'

/**
 * Um veículo, uma locação (ADR 0036).
 *
 * A moto não pode estar com dois clientes ao mesmo tempo. Até aqui isso valia
 * por convenção — a tela só lista veículos `available` — e a própria suíte
 * provava que o banco não sabia: specs criavam seis locações ativas na mesma
 * moto e passavam.
 *
 * O que este spec fixa é que a regra está NO BANCO: vale pela RPC, vale por um
 * INSERT direto que não passa por RPC nenhuma, e vale para as duas formas de
 * violá-la — duas ativas, e período que cruza o de uma locação já encerrada.
 *
 * Usa service_role: o alvo é o banco, não a RLS.
 */

const admin = () => getSupabaseAdmin()

function isoOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

let customerId = ''
let adjustedBy = ''
const veiculos: string[] = []
const locacoes: string[] = []

async function novoVeiculo(): Promise<string> {
  const v = await createTestVehicle()
  veiculos.push(v.id)
  return v.id
}

async function criar(vehicleId: string, start: string, end: string) {
  const params = {
    start_date: start, end_date: end,
    cycle: 'monthly' as const, due_day: 10, cycle_amount: 500, use_pro_rata: false,
  }
  const res = await admin().rpc('create_rental_with_schedule', {
    p_tenant_id: await getTestTenantId(),
    p_rental: { customer_id: customerId, vehicle_id: vehicleId, contract_type: 'rental', ...params },
    p_schedule: generateSchedule(params),
  })
  if (!res.error) locacoes.push(res.data as string)
  return res
}

/** Encerra pelo mesmo caminho da tela: `end_date` passa a ser a devolução. */
async function encerrar(rentalId: string, em: string) {
  const { error } = await admin().rpc('terminate_rental', {
    p_tenant_id: await getTestTenantId(),
    p_rental_id: rentalId,
    p_termination_date: em,
    p_new_status: 'closed',
    p_force: true,
    // Spec 0014: km_final é obrigatório em todo encerramento. O teste aqui é
    // sobre período/sobreposição, não sobre km — 0 satisfaz o piso porque os
    // veículos de teste nascem com km_current = 0 e as locações destes specs
    // não passam km_initial.
    p_km_final: 0,
  })
  if (error) throw new Error(`Setup falhou ao encerrar: ${error.message}`)
}

test.describe('Um veículo, uma locação', () => {
  test.beforeAll(async () => {
    customerId = (await createTestCustomer()).id
    const { data } = await admin()
      .from('tenant_members').select('user_id')
      .eq('tenant_id', await getTestTenantId()).limit(1).single()
    adjustedBy = (data as { user_id: string }).user_id
  })

  test.afterAll(async () => {
    for (const id of locacoes) {
      await admin().from('rental_adjustments').delete().eq('rental_id', id)
      await admin().from('rental_billing_schedules').delete().eq('rental_id', id)
      await admin().from('rentals').delete().eq('id', id)
    }
    await deleteTestCustomer(customerId).catch(() => {})
    for (const id of veiculos) await deleteTestVehicle(id).catch(() => {})
  })

  test('a criação recusa segunda locação ativa, mesmo em datas que não se cruzam', async () => {
    const v = await novoVeiculo()
    expect((await criar(v, isoOffset(0), isoOffset(30))).error).toBeNull()

    // Datas sem sobreposição de propósito: a regra é "uma ATIVA", não só
    // "sem cruzar datas". Reserva futura é o papel da fila.
    const { error } = await criar(v, isoOffset(60), isoOffset(90))
    expect(error).not.toBeNull()
    expect(error!.message).toContain('VEHICLE_ALREADY_RENTED')
  })

  test('um INSERT direto, por fora da RPC, também é recusado', async () => {
    const v = await novoVeiculo()
    expect((await criar(v, isoOffset(0), isoOffset(30))).error).toBeNull()

    // `@gomoto/data` tem um INSERT direto em `rentals`. É por caminhos assim
    // que a regra precisa estar no banco e não na função.
    const { error } = await admin().from('rentals').insert({
      tenant_id: await getTestTenantId(),
      customer_id: customerId,
      vehicle_id: v,
      start_date: isoOffset(60),
      end_date: isoOffset(90),
      cycle: 'monthly', due_day: 10, cycle_amount: 500,
      status: 'active',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23505')
    expect(error!.message).toContain('idx_rentals_one_active_per_vehicle')
  })

  test('nova locação não pode começar antes da devolução da anterior', async () => {
    const v = await novoVeiculo()
    const anterior = await criar(v, isoOffset(-60), isoOffset(30))
    expect(anterior.error).toBeNull()
    await encerrar(anterior.data as string, isoOffset(-30))

    const { error } = await criar(v, isoOffset(-45), isoOffset(60))
    expect(error).not.toBeNull()
    expect(error!.message).toContain('VEHICLE_PERIOD_OVERLAP')
  })

  test('devolver e retirar no mesmo dia é permitido', async () => {
    const v = await novoVeiculo()
    const anterior = await criar(v, isoOffset(-60), isoOffset(30))
    await encerrar(anterior.data as string, isoOffset(-30))

    const { error } = await criar(v, isoOffset(-30), isoOffset(60))
    expect(error).toBeNull()
  })

  test('ajustar o início para antes da devolução anterior é recusado', async () => {
    // O caminho que a ADR 0035 abriu: a locação anterior está ENCERRADA, então
    // "uma ativa por veículo" não a enxerga — só o trigger de período.
    const v = await novoVeiculo()
    const anterior = await criar(v, isoOffset(-60), isoOffset(30))
    await encerrar(anterior.data as string, isoOffset(-30))

    const atual = await criar(v, isoOffset(-20), isoOffset(100))
    expect(atual.error).toBeNull()
    const atualId = atual.data as string

    const { error } = await admin().rpc('fn_adjust_rental_period', {
      p_tenant_id:          await getTestTenantId(),
      p_rental_id:          atualId,
      p_params: {
        start_date: isoOffset(-40), end_date: isoOffset(100),
        cycle: 'monthly', due_day: 10, cycle_amount: 500, use_pro_rata: false,
      },
      p_effective_from:     isoOffset(-40),
      p_supersede_line_ids: [],
      p_new_lines:          [],
      p_justification:      'Tentativa de antecipar sobre a locação anterior',
      p_adjusted_by:        adjustedBy,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('VEHICLE_PERIOD_OVERLAP')

    // A recusa é da transação inteira: o início não mudou.
    const { data } = await admin().from('rentals').select('start_date').eq('id', atualId).single()
    expect((data as { start_date: string }).start_date).toBe(isoOffset(-20))
  })

  test('encerrar a atual libera o veículo para a próxima', async () => {
    const v = await novoVeiculo()
    const primeira = await criar(v, isoOffset(0), isoOffset(30))
    await encerrar(primeira.data as string, isoOffset(10))

    const { error } = await criar(v, isoOffset(10), isoOffset(60))
    expect(error).toBeNull()
  })
})
