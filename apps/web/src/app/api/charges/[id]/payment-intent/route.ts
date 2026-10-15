/**
 * Criação de tentativa de pagamento pelo app do cliente (Spec 0014 / ADR 0024).
 *
 * Substitui `/api/billings/[id]/pix`. Duas mudanças:
 *
 * - o valor vem de `calculateAmountDue`, não de `original_amount − desconto`.
 *   O endpoint antigo ignorava crédito aplicado e encargo de atraso (F-05):
 *   cliente com crédito pagava a mais, cobrança vencida quitava a menos.
 * - o provedor é a conta que o TENANT elegeu (ADR 0030). A rota não nomeia
 *   gateway nenhum: pede o meio de pagamento e recebe o que o gateway ativo
 *   souber gerar.
 *
 * Escrita do cliente mobile via Route Handler com service role, conforme
 * ADR 0016 — o padrão de autenticação não muda, só o que trafega nele.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getOrCreateIntent } from '@/lib/payment/intents'

type RouteContext = { params: Promise<{ id: string }> }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status })
}

function log(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id: chargeId } = await ctx.params

  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (!token) return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token não fornecido' } }, 401)

  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }, 401)

  // Service role: o token do mobile não chega por cookie, então o cliente SSR
  // roda como anon e a RLS bloqueia as leituras necessárias.
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // TODOS os cadastros do login, um por locadora (PRD 0001: o mesmo CPF pode
  // ser cliente de mais de um tenant). Era `.maybeSingle()`: com dois cadastros
  // o PostgREST devolve erro, `data` vinha null e a rota respondia "Cliente não
  // encontrado" a quem é cliente — em produção, 2026-09-25.
  const { data: customers, error: customersError } = await admin
    .from('customers')
    .select('id, tenant_id')
    .eq('user_id', user.id)

  if (customersError) {
    log('error', 'intent.customer_lookup_failed', { user_id: user.id, error: customersError.message })
    return json({ ok: false, error: { code: 'INTERNAL', message: 'Falha ao gerar cobrança. Tente novamente.' } }, 500)
  }
  if (!customers || customers.length === 0) {
    log('warn', 'intent.customer_not_found', { user_id: user.id, charge_id: chargeId })
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cliente não encontrado' } }, 403)
  }

  // Titularidade: a cobrança precisa ser de UM destes cadastros, na locadora
  // dele. Sem esta checagem, o service role contornaria a RLS. Cobrança alheia
  // e inexistente respondem igual (404), para não revelar qual existe.
  const { data: charge } = await admin
    .from('charges')
    .select('id, tenant_id, customer_id')
    .eq('id', chargeId)
    .maybeSingle()

  const ch = charge as { tenant_id: string; customer_id: string } | null
  const c = ch
    ? (customers as { id: string; tenant_id: string }[])
        .find((cu) => cu.id === ch.customer_id && cu.tenant_id === ch.tenant_id)
    : undefined

  if (!c) {
    log('warn', 'intent.charge_not_owned', { charge_id: chargeId, user_id: user.id })
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Cobrança não encontrada' } }, 404)
  }

  // Sem `?? 'pix'`: o default é do gateway ELEITO, resolvido dentro de
  // `getOrCreateIntent`. Fixar aqui fazia o app pedir PIX a um provedor de
  // checkout hospedado e ouvir que ele não gera PIX — culpa nossa, mensagem
  // apontando para o cliente.
  const body = await req.json().catch(() => ({})) as { method?: string }
  const method = body.method ?? null

  try {
    const result = await getOrCreateIntent(admin, {
      tenantId: c.tenant_id, chargeId, method,
    })
    log('info', 'intent.created', {
      charge_id: chargeId, tenant_id: c.tenant_id, provider: result.provider,
      amount: result.amount, reused: result.is_reused,
    })
    return json({ ok: true, data: result })
  } catch (err: unknown) {
    const e = err as Error & { code?: string }

    if (e.code === 'FORBIDDEN') {
      return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Pagamento online não configurado' } }, 403)
    }
    // Credencial expirada é diferente de gateway ausente: o cliente não deve
    // ficar tentando de novo, e o log tem que apontar para a locadora. Antes,
    // o 401 do provedor virava 500 "Tente novamente" — conselho errado para um
    // token que expirou há dois meses.
    if (e.code === 'GATEWAY_UNAUTHORIZED') {
      log('error', 'intent.gateway_unauthorized', { charge_id: chargeId, tenant_id: c.tenant_id })
      return json({ ok: false, error: {
        code: 'GATEWAY_UNAUTHORIZED',
        message: 'Pagamento online indisponível no momento. Fale com a locadora.',
      } }, 503)
    }
    // A mensagem do provedor é para o operador; o cliente não tem o que
    // ajustar e precisa saber a quem recorrer.
    if (e.code === 'FINE_EXCEEDS_AMOUNT') {
      log('warn', 'intent.fine_exceeds_amount', { charge_id: chargeId, tenant_id: c.tenant_id })
      return json({ ok: false, error: {
        code: 'FINE_EXCEEDS_AMOUNT',
        message: 'Não é possível pagar esta cobrança pelo app. Entre em contato com a locadora para realizar o pagamento.',
      } }, 409)
    }
    if (e.code === 'NOT_FOUND') {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: e.message } }, 404)
    }
    if (e.code === 'CONFLICT') {
      return json({ ok: false, error: { code: 'CONFLICT', message: e.message } }, 409)
    }

    log('error', 'intent.failed', { charge_id: chargeId, error: e.message })
    return json({ ok: false, error: { code: 'INTERNAL', message: 'Falha ao gerar cobrança. Tente novamente.' } }, 500)
  }
}
