/**
 * Veículos — CRUD.
 *
 * A spec estava presa ao wizard em modal que existia em julho; o cadastro virou
 * página (`/veiculos/novo`) e a edição virou rota (`/veiculos/[id]/editar`).
 * Ela falhava desde então no primeiro clique, sem nunca chegar ao banco — ou
 * seja, não protegia nada.
 *
 * Os campos são alcançados por rótulo. O `Field` deste form passou a envolver o
 * controle com o `<label>`: antes eram irmãos sem `htmlFor`, o que deixava o
 * input sem nome acessível e obrigava o teste a caçar placeholder e posição.
 */

import { test, expect } from '@playwright/test'
import { waitForPageLoad, getSupabaseAdmin } from './helpers'

const SUFIXO = Date.now().toString().slice(-4)
// Padrão Mercosul (LLLNLNN): a máscara do form rejeita qualquer outro formato,
// e a spec antiga montava "T1234E2", que não passa.
const PLACA = `TST${SUFIXO[0]}E${SUFIXO.slice(1, 3)}`.toUpperCase()
const MODELO_EDITADO = 'Fan 160 EDITADO'

test.afterAll(async () => {
  await getSupabaseAdmin().from('vehicles').delete().eq('license_plate', PLACA)
})

test.describe('Veículos — CRUD', () => {
  // Três navegações completas (criar, editar, excluir) num form grande: cabe
  // nos 30s padrão sozinho, mas não com a suíte inteira disputando o servidor.
  test.slow()

  test('criar, editar e excluir veículo', async ({ page }) => {
    // ── CRIAR ────────────────────────────────────────────────────────────────
    await page.goto('/veiculos')
    await waitForPageLoad(page)
    await page.getByRole('link', { name: /novo veículo/i }).click()
    // 30s: em dev o Next compila a rota na primeira visita, e o formulário de
    // veículo é a maior tela do app. Sob a suíte inteira, 15s não bastam.
    await page.waitForURL('**/veiculos/novo', { timeout: 30_000 })
    await waitForPageLoad(page)

    // Cadastro simplificado: o Essencial fica à vista; o resto, recolhido.
    await page.getByLabel('Placa *').fill(PLACA)
    await page.getByRole('radio', { name: 'Moto' }).click()
    await page.getByLabel(/^Marca/i).fill('HONDA')
    await page.getByLabel(/^Modelo/i).fill('CG 160 Fan')
    await page.getByLabel(/^Ano fabrica/i).fill('2024')
    await page.getByLabel(/^Ano modelo/i).fill('2024')
    await page.getByLabel(/^Cor/i).fill('VERMELHO')

    // RENAVAM e chassi são opcionais e moram em "Identificação complementar".
    await page.getByRole('button', { name: /identificação complementar/i }).click()
    // RENAVAM é único por tenant: valor fixo colide com execução anterior.
    await page.getByLabel(/RENAVAM/i).fill(Date.now().toString().slice(-11).padStart(11, '1'))
    await page.getByLabel(/^Chassi/i).fill(`9C2${Date.now()}`.padEnd(17, '0').slice(0, 17))

    // O rótulo do submit muda entre criar e editar ("Cadastrar" / "Salvar").
    await page.getByRole('button', { name: /^cadastrar$/i }).first().click()
    await page.waitForURL(/\/veiculos(\/[0-9a-f-]+)?$/, { timeout: 20_000 })
    await waitForPageLoad(page)

    const { data: criado } = await getSupabaseAdmin()
      .from('vehicles').select('id, model, vehicle_type').eq('license_plate', PLACA).maybeSingle()
    expect(criado, 'veículo não foi criado').not.toBeNull()
    expect((criado as { vehicle_type: string }).vehicle_type).toBe('motorcycle')
    const vehicleId = (criado as { id: string }).id

    // ── EDITAR ───────────────────────────────────────────────────────────────
    await page.goto(`/veiculos/${vehicleId}/editar`)
    await waitForPageLoad(page)

    const campoModelo = page.getByLabel(/^Modelo/i)
    await campoModelo.clear()
    await campoModelo.fill(MODELO_EDITADO)
    await page.getByRole('button', { name: /^salvar( alterações)?$/i }).first().click()
    await page.waitForURL(`**/veiculos/${vehicleId}`, { timeout: 20_000 })

    const { data: editado } = await getSupabaseAdmin()
      .from('vehicles').select('model').eq('id', vehicleId).single()
    expect((editado as { model: string }).model, 'edição não persistiu').toBe(MODELO_EDITADO)

    // ── EXCLUIR ──────────────────────────────────────────────────────────────
    await page.goto('/veiculos')
    await waitForPageLoad(page)

    const linha = page.locator('tr', { hasText: PLACA }).first()
    await expect(linha).toBeVisible({ timeout: 10_000 })
    await linha.getByTitle('Excluir').click()

    // "Excluir" também é o title do ícone em cada linha da tabela: o botão de
    // confirmação tem de ser buscado DENTRO do modal.
    const modal = page.locator('div.fixed.inset-0').last()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await modal.getByRole('button', { name: /^excluir$/i }).click()

    await expect(page.locator('tr', { hasText: PLACA })).toHaveCount(0, { timeout: 15_000 })

    const { data: apagado } = await getSupabaseAdmin()
      .from('vehicles').select('id').eq('id', vehicleId).maybeSingle()
    expect(apagado, 'veículo continuou no banco depois da exclusão').toBeNull()
  })
})

test.describe('Veículo locado — edição e documentação anual', () => {
  test.slow()

  /**
   * Nenhum veículo LOCADO podia ser editado, e o formulário não dizia nada.
   *
   * `VehicleBaseSchema` declarava `status` com os 4 valores que o operador pode
   * escolher à mão (RF-016). Como o formulário devolve o status atual junto com
   * o resto do payload, o Zod reprovava em `status` antes de qualquer regra
   * rodar — e a regra de verdade já existia logo abaixo, em `updateVehicle`,
   * descartando `status` quando a moto está locada (RN-002).
   *
   * O erro apontava para um campo que a tela mostra como informativo ("Status
   * Locado é gerenciado automaticamente via contratos"), sem slot de mensagem.
   * Resultado: clicar em Salvar não produzia nada — nem aviso, nem navegação,
   * nem gravação. Neste banco eram 16 motos impossíveis de editar.
   */
  test('moto locada aceita edição, e a isenção de documento sobrevive ao recarregar', async ({ page }) => {
    const admin = getSupabaseAdmin()
    const placa = `TST${Date.now().toString().slice(-4)}`.slice(0, 7).toUpperCase()

    const { data: tenant } = await admin.from('tenants').select('id').limit(1).single()
    const tenantId = (tenant as { id: string }).id

    const { data: criado, error } = await admin
      .from('vehicles')
      .insert({
        tenant_id: tenantId, license_plate: placa, make: 'TEST', model: 'Locada E2E',
        year_manufacture: '2024', year_model: '2024', color: 'PRETO',
        acquisition_type: 'used', renavam: Date.now().toString().slice(-11),
        chassis: `LOCADA${Date.now()}`.slice(0, 17).toUpperCase(),
        fuel: 'GASOLINA', km_current: 0,
        status: 'rented',
      })
      .select('id')
      .single()

    if (error) throw new Error(`setup: ${error.message}`)
    const vehicleId = (criado as { id: string }).id

    try {
      await page.goto(`/veiculos/${vehicleId}/editar`)
      await waitForPageLoad(page)

      const novaCor = 'AZUL'
      await page.getByLabel('Cor').fill(novaCor)

      // DPVAT nasce "Isento" no formulário. A escolha não tinha onde ser
      // gravada — `vehicle_obligations` não tem coluna de situação —, então
      // virava obrigação sem conta a pagar e o veículo era reprovado na
      // documentação por algo de que está dispensado.
      await page.getByRole('button', { name: /^salvar$/i }).click()
      await page.waitForURL(`**/veiculos/${vehicleId}`, { timeout: 20_000 })

      const { data: depois } = await admin
        .from('vehicles').select('color, status').eq('id', vehicleId).single()

      const v = depois as { color: string; status: string }
      expect(v.color, 'edição de moto locada não gravou').toBe(novaCor)
      expect(v.status, 'o status não pode ser alterado pela edição (RN-002)').toBe('rented')

      // A isenção precisa voltar como "Isento" ao reabrir. Antes, a página lia
      // `obl.status` de uma coluna que não existe: vinha `undefined`, caía no
      // fallback 'pending', e desfazia a escolha do operador em silêncio.
      const { data: obrigacoes } = await admin
        .from('vehicle_obligation_status')
        .select('type, is_exempt, status')
        .eq('vehicle_id', vehicleId)

      const dpvat = ((obrigacoes ?? []) as { type: string; is_exempt: boolean; status: string }[])
        .find(o => o.type === 'dpvat')

      expect(dpvat, 'a isenção do DPVAT não foi registrada').toBeTruthy()
      expect(dpvat!.is_exempt).toBe(true)
      expect(dpvat!.status).toBe('exempt')

      // E isenta não conta como pendência: o veículo segue em dia.
      const { data: rollup } = await admin
        .from('vehicle_document_status')
        .select('is_compliant, unbilled_count, exempt_count')
        .eq('vehicle_id', vehicleId)
        .single()

      const r = rollup as { is_compliant: boolean; unbilled_count: number; exempt_count: number }
      expect(Number(r.exempt_count)).toBe(1)
      expect(Number(r.unbilled_count), 'isento virou "custo não lançado"').toBe(0)
      expect(r.is_compliant, 'veículo isento não pode ser reprovado').toBe(true)
    } finally {
      await admin.from('vehicle_obligations').delete().eq('vehicle_id', vehicleId)
      await admin.from('vehicles').delete().eq('id', vehicleId)
    }
  })
})

test.describe('KM de entrada — gravado uma vez', () => {
  test.slow()

  /**
   * Com o cadastro simplificado o KM de entrada virou opcional. Antes, deixar
   * em branco era definitivo: a edição não mostrava o campo e a action
   * descartava o valor. Agora ele pode ser informado depois — uma vez — e o
   * KM atual sobe junto (a locação usa km_current como KM inicial).
   */
  test('veículo sem KM recebe na edição, e depois o valor trava', async ({ page }) => {
    const admin = getSupabaseAdmin()
    const placa = `KME${Date.now().toString().slice(-4)}`.slice(0, 7).toUpperCase()
    const { data: tenant } = await admin.from('tenants').select('id').limit(1).single()

    const { data: criado, error } = await admin
      .from('vehicles')
      .insert({
        tenant_id: (tenant as { id: string }).id, license_plate: placa, make: 'TEST', model: 'KM E2E',
        vehicle_type: 'motorcycle', year_manufacture: '2024', year_model: '2024', color: 'PRETO',
        acquisition_type: 'used', status: 'available',
      })
      .select('id')
      .single()
    if (error) throw new Error(`setup: ${error.message}`)
    const vehicleId = (criado as { id: string }).id

    try {
      await page.goto(`/veiculos/${vehicleId}/editar`)
      await waitForPageLoad(page)
      await page.getByLabel('KM de entrada').fill('12000')
      await page.getByRole('button', { name: /^salvar$/i }).click()
      await page.waitForURL(`**/veiculos/${vehicleId}`, { timeout: 20_000 })

      const { data: depois } = await admin
        .from('vehicles').select('km_entry, km_current').eq('id', vehicleId).single()
      const v = depois as { km_entry: number; km_current: number }
      expect(v.km_entry, 'KM de entrada não gravou na edição').toBe(12000)
      expect(v.km_current, 'KM atual não partiu do KM de entrada').toBe(12000)

      // Preenchido, o campo some da edição…
      await page.goto(`/veiculos/${vehicleId}/editar`)
      await waitForPageLoad(page)
      await expect(page.getByLabel(/^Cor/)).toBeVisible()
      await expect(page.getByLabel('KM de entrada')).toHaveCount(0)

      // …e o banco recusa a troca mesmo por fora da tela.
      const { error: troca } = await admin
        .from('vehicles').update({ km_entry: 13000 }).eq('id', vehicleId)
      expect(troca?.message ?? '').toContain('não pode ser alterado')
    } finally {
      await admin.from('vehicle_obligations').delete().eq('vehicle_id', vehicleId)
      await admin.from('vehicles').delete().eq('id', vehicleId)
    }
  })
})
