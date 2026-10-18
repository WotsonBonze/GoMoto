/**
 * De onde veio o dinheiro — tela de detalhe da cobrança.
 *
 * A tela mostrava "PIX" tanto para um recebimento que a Cora confirmou sozinha
 * quanto para um que alguém digitou à mão. São situações que exigem coisas
 * diferentes de quem confere: a primeira tem contrapartida no extrato do
 * provedor, a segunda depende de uma pessoa ter digitado certo.
 *
 * O dado para responder isso só passou a existir na ADR 0034
 * (`payments.received_by_system`), com o provedor do intent cobrindo os
 * recebimentos anteriores a ela.
 */

import { test, expect } from '@playwright/test'
import { TEST_TAG, getSupabaseAdmin, getTestTenantId } from './helpers'

const admin = () => getSupabaseAdmin()
const sufixo = Date.now().toString().slice(-9)

let chargeId = ''
let nomeDeQuemRecebeu = ''

test.beforeAll(async () => {
  const tenantId = await getTestTenantId()

  const { data: cliente } = await admin()
    .from('customers').select('id').eq('tenant_id', tenantId).limit(1).single()
  const customerId = (cliente as { id: string }).id

  const { data: membros } = await admin().from('tenant_members')
    .select('user_id').eq('tenant_id', tenantId).eq('status', 'active').limit(1).single()
  const userId = (membros as { user_id: string }).user_id

  const { data: users } = await admin().auth.admin.listUsers({ perPage: 200 })
  const u = users.users.find((x) => x.id === userId)
  nomeDeQuemRecebeu = (u?.user_metadata?.name as string) || (u?.email ?? '').split('@')[0]

  const contaId = crypto.randomUUID()
  await admin().from('payment_provider_accounts').insert({
    id: contaId, tenant_id: tenantId, provider: 'cora',
    external_account_id: `origem-${sufixo}`, active: true, is_default: false,
  })

  const { data: cobranca } = await admin().rpc('fn_create_charge', {
    p_tenant_id: tenantId,
    p_charge: {
      customer_id: customerId, due_date: new Date().toISOString().slice(0, 10),
      source_module: 'manual', source_id: crypto.randomUUID(),
    },
    p_items: [{
      description: `${TEST_TAG} Origem`, credit_account_code: 'receita_locacao',
      quantity: 1, unit_amount: 100, amount: 100,
    }],
  })
  chargeId = (cobranca as { charge_id: string }).charge_id

  // Metade pelo GATEWAY: é `fn_confirm_gateway_payment` que grava
  // `received_by_system`, então o teste passa pelo caminho real.
  const { data: evento } = await admin().from('gateway_events').insert({
    tenant_id: tenantId, provider: 'cora', provider_event_id: `origem-${sufixo}`,
    event_type: 'invoice.PAID', payload: {}, signature_valid: false,
    processed_at: null, accepted_without_verification: false,
    processing_error: null, attempts: 0, outcome: null,
  }).select('id').single()

  const { data: intentId } = await admin().rpc('fn_open_payment_intent', {
    p_tenant_id: tenantId, p_charge_id: chargeId, p_provider: 'cora',
    p_provider_account_id: contaId, p_method: 'pix',
    p_provider_intent_id: `inv-origem-${sufixo}`, p_amount: 60,
    p_accrued_amount: 0, p_expires_at: null, p_payload: {},
  })

  const { error } = await admin().rpc('fn_confirm_gateway_payment', {
    p_tenant_id: tenantId, p_intent_id: intentId, p_amount: 60,
    p_paid_at: new Date().toISOString(), p_method: null,
    p_notes: 'Confirmado pelo gateway',
    p_gateway_event_id: (evento as { id: string }).id, p_provider: 'cora',
  })
  if (error) throw new Error(`setup gateway falhou: ${error.message}`)

  // A outra metade À MÃO, com autor.
  const { data: pagamento } = await admin().from('payments').insert({
    tenant_id: tenantId, customer_id: customerId, amount: 40,
    method: 'cash', paid_at: new Date().toISOString(),
    notes: `${TEST_TAG} balcão`, received_by: userId,
  }).select('id').single()

  await admin().from('payment_allocations').insert({
    tenant_id: tenantId, payment_id: (pagamento as { id: string }).id,
    charge_id: chargeId, amount: 40,
  })
})

test.describe('Origem do pagamento na tela da cobrança (ADR 0034)', () => {
  test('distingue o que o gateway confirmou do que alguém digitou', async ({ page }) => {
    await page.goto(`/cobrancas/${chargeId}`)
    await expect(page.getByRole('heading', { name: /Pagamentos/ })).toBeVisible()

    const linhaGateway = page.locator('tr', { hasText: 'Confirmado pelo gateway' })
    const linhaManual = page.locator('tr', { hasText: 'balcão' })

    // O gateway aparece pelo NOME do provedor, não por "gateway:cora" cru.
    await expect(linhaGateway).toContainText('Cora')
    await expect(linhaGateway, 'recebimento de gateway rotulado como manual')
      .not.toContainText('Manual')

    // E o manual diz que foi manual — e por quem, quando dá para resolver.
    await expect(linhaManual).toContainText('Manual')
    await expect(linhaManual).toContainText(nomeDeQuemRecebeu)
  })
})
