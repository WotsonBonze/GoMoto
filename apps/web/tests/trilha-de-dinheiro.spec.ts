/**
 * A trilha do tenant vê dinheiro — ADR 0034, Fase 5.
 *
 * `payment_confirmed` e `token_refreshed` existiam no vocabulário de
 * `lib/audit.ts` desde sempre e **nunca tiveram um único escritor**. A trilha
 * registrava "conectou gateway" e "gerou Pix", e nunca "recebeu dinheiro".
 *
 * A causa era estrutural: a confirmação roda em Deno com `service_role`, e
 * `logAction` vive em `apps/web`. Por isso a trilha do dinheiro passou a ser
 * escrita pelo BANCO, por trigger, na mesma transação do pagamento — o que
 * também a torna impossível de "engolir", diferente de `logAction`, que captura
 * a própria falha e segue.
 *
 * O que este spec protege é a existência do registro e a IDENTIDADE de quem
 * agiu. Uma trilha que grava tudo como se fosse a mesma pessoa não responde a
 * pergunta que ela existe para responder.
 */

import { test, expect } from '@playwright/test'
import { TEST_TAG, getSupabaseAdmin, getTestTenantId } from './helpers'

const admin = () => getSupabaseAdmin()

const sufixo = Date.now().toString().slice(-9)

let tenantId = ''
let customerId = ''

test.beforeAll(async () => {
  tenantId = await getTestTenantId()
  const { data } = await admin()
    .from('customers').select('id').eq('tenant_id', tenantId).limit(1).single()
  customerId = (data as { id: string }).id
})

test.describe('Trilha de auditoria do dinheiro (ADR 0034 Fase 5)', () => {
  test('recebimento de gateway entra na trilha como o SISTEMA, não como pessoa', async () => {
    const { data: evento } = await admin()
      .from('gateway_events')
      .insert({
        tenant_id: tenantId, provider: 'cora',
        provider_event_id: `trilha-${sufixo}`, event_type: `invoice.PAID ${TEST_TAG}`,
        payload: {}, signature_valid: false,
        processed_at: null, accepted_without_verification: false,
        processing_error: null, attempts: 0,
      })
      .select('id').single()

    const eventId = (evento as { id: string }).id

    // Um recebimento com a marca de gateway, exatamente como
    // `fn_confirm_gateway_payment` grava.
    const { data: pagamento, error } = await admin()
      .from('payments')
      .insert({
        tenant_id: tenantId, customer_id: customerId, amount: 99,
        method: 'pix', paid_at: new Date().toISOString(),
        notes: `${TEST_TAG} trilha`,
        gateway_event_id: eventId, received_by_system: 'gateway:cora',
      })
      .select('id').single()

    expect(error, error?.message).toBeNull()
    const paymentId = (pagamento as { id: string }).id

    const { data: trilha } = await admin()
      .from('audit_logs')
      .select('action, user_id, actor_system, new_data')
      .eq('record_id', paymentId)
      .eq('action', 'payment_confirmed')
      .maybeSingle()

    expect(trilha, 'recebimento de gateway não deixou rastro na trilha').not.toBeNull()

    const t = trilha as { user_id: string | null; actor_system: string | null; new_data: Record<string, unknown> }

    // O ponto: papel de máquina não se disfarça de pessoa. Um `auth.users`
    // fictício apareceria em listas de membros e em todo relatório por pessoa.
    expect(t.actor_system).toBe('gateway:cora')
    expect(t.user_id, 'gateway registrado como se fosse um usuário').toBeNull()

    // O elo causal da Fase 1 viaja junto: dá para ir da trilha ao webhook.
    expect(t.new_data.gateway_event_id).toBe(eventId)
    expect(Number(t.new_data.amount)).toBe(99)
  })

  test('recebimento manual entra na trilha como PESSOA', async () => {
    const { data: users } = await admin().auth.admin.listUsers({ perPage: 200 })
    const alguem = users.users[0]
    expect(alguem, 'nenhum usuário para atribuir o recebimento').toBeTruthy()

    const { data: pagamento, error } = await admin()
      .from('payments')
      .insert({
        tenant_id: tenantId, customer_id: customerId, amount: 77,
        method: 'cash', paid_at: new Date().toISOString(),
        notes: `${TEST_TAG} trilha manual`,
        received_by: alguem!.id,
      })
      .select('id').single()

    expect(error, error?.message).toBeNull()
    const paymentId = (pagamento as { id: string }).id

    const { data: trilha } = await admin()
      .from('audit_logs')
      .select('user_id, actor_system')
      .eq('record_id', paymentId)
      .eq('action', 'payment_confirmed')
      .maybeSingle()

    const t = trilha as { user_id: string | null; actor_system: string | null } | null
    expect(t, 'recebimento manual não deixou rastro').not.toBeNull()
    expect(t!.user_id).toBe(alguem!.id)
    expect(t!.actor_system, 'pessoa registrada como sistema').toBeNull()
  })

  test('estorno de verdade deixa rastro, com o motivo', async () => {
    // Estorno exige o caminho completo: cobrança, tentativa e confirmação. Sem
    // lançamento de origem `fn_reverse_payment` não tem o que inverter, e a
    // trava da Fase 2 impede marcar `reversed_at` à mão — de propósito.
    const contaId = crypto.randomUUID()
    await admin().from('payment_provider_accounts').insert({
      id: contaId, tenant_id: tenantId, provider: 'cora',
      external_account_id: `trilha-${sufixo}`, active: true, is_default: false,
    })

    const { data: cobranca } = await admin().rpc('fn_create_charge', {
      p_tenant_id: tenantId,
      p_charge: {
        customer_id: customerId, due_date: new Date().toISOString().slice(0, 10),
        source_module: 'manual', source_id: crypto.randomUUID(),
      },
      p_items: [{
        description: `${TEST_TAG} trilha estorno`, credit_account_code: 'receita_locacao',
        quantity: 1, unit_amount: 55, amount: 55,
      }],
    })
    const chargeId = (cobranca as { charge_id: string }).charge_id

    const { data: intentId } = await admin().rpc('fn_open_payment_intent', {
      p_tenant_id: tenantId, p_charge_id: chargeId, p_provider: 'cora',
      p_provider_account_id: contaId, p_method: 'pix',
      p_provider_intent_id: `inv-trilha-${sufixo}`, p_amount: 55,
      p_accrued_amount: 0, p_expires_at: null, p_payload: {},
    })

    const { data: paymentId, error: erroConfirma } = await admin().rpc('fn_confirm_gateway_payment', {
      p_tenant_id: tenantId, p_intent_id: intentId, p_amount: 55,
      p_paid_at: new Date().toISOString(), p_method: null,
      p_notes: 'Confirmado pelo gateway',
      p_gateway_event_id: null, p_provider: null,
    })
    expect(erroConfirma, erroConfirma?.message).toBeNull()

    const { error: erroEstorno } = await admin().rpc('fn_reverse_payment', {
      p_tenant_id: tenantId, p_payment_id: paymentId,
      p_reason: `${TEST_TAG} motivo do estorno`, p_reversed_by: null,
    })
    expect(erroEstorno, erroEstorno?.message).toBeNull()

    const { data: trilha } = await admin()
      .from('audit_logs')
      .select('new_data, actor_system, user_id')
      .eq('record_id', paymentId)
      .eq('action', 'payment_reversed')
      .maybeSingle()

    expect(trilha, 'estorno não deixou rastro na trilha').not.toBeNull()

    const t = trilha as { new_data: Record<string, unknown> }
    // O MOTIVO é o que a trilha precisa carregar: "foi estornado" sem por quê
    // não responde nada a quem investiga depois.
    expect(String(t.new_data.reversal_reason)).toContain('motivo do estorno')
  })

  test('a trilha é imutável mesmo para o backend', async () => {
    // A trilha do dinheiro é escrita por funções SECURITY DEFINER, que IGNORAM
    // RLS. A imutabilidade precisava existir onde ela não pode ser contornada —
    // como já acontece no razão.
    const { data: alvo } = await admin()
      .from('audit_logs')
      .select('id')
      .eq('action', 'payment_confirmed')
      .limit(1)
      .maybeSingle()

    expect(alvo, 'sem linha de trilha para testar').not.toBeNull()
    const id = (alvo as { id: string }).id

    const { error: erroUpdate } = await admin()
      .from('audit_logs').update({ action: 'adulterado' }).eq('id', id)
    expect(erroUpdate, 'service_role alterou a trilha').not.toBeNull()

    const { error: erroDelete } = await admin()
      .from('audit_logs').delete().eq('id', id)
    expect(erroDelete, 'service_role apagou a trilha').not.toBeNull()
  })
})
