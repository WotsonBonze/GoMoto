/**
 * @file api/inspections/schedules/[scheduleId]/submit/route.ts
 * @description Único ponto de escrita do cliente mobile no módulo de Vistoria
 * (RF-016, RF-021) — padrão formalizado pela ADR 0016 (Route Handler + Bearer
 * token + client admin/service role), espelhando `billings/[id]/pix/route.ts`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { SubmitInspectionSchema, validateRequiredPhotos } from '@gomoto/core'
import type { InspectionAnswerRecord, InspectionPhotoRecord } from '@gomoto/core'

type RouteContext = { params: Promise<{ scheduleId: string }> }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status })
}

function log(level: 'info' | 'warn' | 'error', action: string, fields: Record<string, unknown> = {}) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, action, ...fields })
  level === 'error' ? console.error(out) : console.log(out)
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { scheduleId } = await ctx.params

  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (!token) return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Token não fornecido' } }, 401)

  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Não autorizado' } }, 401)

  // Queries de banco usam service role: o token do mobile não é propagado via
  // cookie, então o cliente SSR roda como anon e a RLS bloqueia as leituras
  // abaixo (ADR 0016 passo 4).
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Passo 1 (ADR 0016 §5): resolve os cadastros de cliente por user_id —
  // TODOS, um por locadora (PRD 0001). Era `.maybeSingle()`: com dois
  // cadastros o PostgREST devolve erro e a rota respondia "Cliente não
  // encontrado" a quem é cliente (mesmo defeito da rota de pagamento,
  // achado em produção em 2026-09-25).
  const { data: customers, error: customersError } = await admin
    .from('customers')
    .select('id, tenant_id')
    .eq('user_id', user.id)

  if (customersError) {
    log('error', 'inspection.customer_lookup_failed', { user_id: user.id, error: customersError.message })
    return json({ ok: false, error: { code: 'INTERNAL', message: 'Falha ao enviar vistoria. Tente novamente.' } }, 500)
  }
  if (!customers || customers.length === 0) {
    log('warn', 'inspection.customer_not_found', { user_id: user.id, schedule_id: scheduleId })
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cliente não encontrado' } }, 403)
  }

  const tenantIds = customers.map((c) => c.tenant_id as string)

  // Passo 2: resolve schedule por id, restrito às locadoras do cliente — senão NOT_FOUND
  const { data: schedule } = await admin
    .from('inspection_schedules')
    .select('id, tenant_id, rental_id')
    .eq('id', scheduleId)
    .in('tenant_id', tenantIds)
    .maybeSingle()

  if (!schedule) {
    log('warn', 'inspection.schedule_not_found', { schedule_id: scheduleId, user_id: user.id })
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Agendamento não encontrado' } }, 404)
  }

  // Passo 3: confere posse — rental.customer_id precisa ser o cadastro deste
  // usuário NA locadora do agendamento
  const { data: rental } = await admin
    .from('rentals')
    .select('id, customer_id, periodic_inspection_profile_id')
    .eq('id', schedule.rental_id)
    .maybeSingle()

  const customer = rental
    ? customers.find((c) => c.id === rental.customer_id && c.tenant_id === schedule.tenant_id)
    : undefined

  if (!rental || !customer || !rental.periodic_inspection_profile_id) {
    log('warn', 'inspection.periodic_forbidden', { user_id: user.id, schedule_id: scheduleId })
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Agendamento não pertence a este cliente' } }, 403)
  }

  // Passo 4 (RN-013): já existe aprovação para este agendamento?
  const { data: existingApproved } = await admin
    .from('inspections')
    .select('id')
    .eq('schedule_id', scheduleId)
    .eq('status', 'approved')
    .maybeSingle()

  if (existingApproved) {
    return json({ ok: false, error: { code: 'CONFLICT', message: 'Este agendamento já foi aprovado' } }, 409)
  }

  const rawBody = await req.json().catch(() => null)
  const parsed = SubmitInspectionSchema.safeParse(rawBody)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: first?.message ?? 'Dados inválidos', field: first?.path?.map(String).join('.') },
    }, 422)
  }

  const [checklistResult, photoResult] = await Promise.all([
    admin.from('inspection_profile_checklist_items').select('*').eq('profile_id', rental.periodic_inspection_profile_id),
    admin.from('inspection_profile_photo_items').select('*').eq('profile_id', rental.periodic_inspection_profile_id),
  ])
  const checklistItems = checklistResult.data ?? []
  const photoItems = photoResult.data ?? []

  const photoCheck = validateRequiredPhotos(
    photoItems.map((p) => ({ id: p.id, label: p.label, is_required: p.is_required })),
    parsed.data.photos,
  )
  if (!photoCheck.ok) {
    return json({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: `Foto obrigatória ausente: ${photoCheck.missingLabel}`, field: 'photos' },
    }, 422)
  }

  const checklistById = new Map(checklistItems.map((c) => [c.id as string, c]))
  const photoById = new Map(photoItems.map((p) => [p.id as string, p]))

  const answers: InspectionAnswerRecord[] = parsed.data.answers.map((a) => ({
    item_id: a.item_id,
    name: checklistById.get(a.item_id)?.name ?? '—',
    status: a.status,
    note: a.note,
  }))
  const photos: InspectionPhotoRecord[] = parsed.data.photos.map((p) => ({
    item_id: p.item_id,
    label: photoById.get(p.item_id)?.label ?? '—',
    is_required: photoById.get(p.item_id)?.is_required ?? false,
    storage_path: p.storage_path,
  }))

  // RN-010 — reenvio após rejeição sempre INSERT de um novo registro, nunca
  // UPDATE sobre o rejeitado (histórico preservado).
  const { data: inspection, error: insertErr } = await admin
    .from('inspections')
    .insert({
      tenant_id: customer.tenant_id,
      rental_id: rental.id,
      inspection_profile_id: rental.periodic_inspection_profile_id,
      schedule_id: scheduleId,
      kind: 'periodic',
      status: 'submitted',
      answers,
      photos,
    })
    .select()
    .single()

  if (insertErr || !inspection) {
    log('error', 'inspection.periodic_submit_failed', { schedule_id: scheduleId, tenant_id: customer.tenant_id, error: insertErr?.message })
    return json({ ok: false, error: { code: 'INTERNAL', message: 'Falha ao enviar vistoria. Tente novamente.' } }, 500)
  }

  // ADR 0016 passo 8 — audit_logs inserido diretamente (logAction() depende
  // de cookie de sessão, indisponível numa requisição Bearer-token).
  await admin.from('audit_logs').insert({
    tenant_id: customer.tenant_id,
    user_id: user.id,
    action: 'create',
    table_name: 'inspections',
    record_id: inspection.id,
    new_data: { status: 'submitted', kind: 'periodic', schedule_id: scheduleId },
  })

  log('info', 'inspection.periodic_submitted', { tenant_id: customer.tenant_id, customer_id: customer.id, schedule_id: scheduleId, inspection_id: inspection.id })
  return json({ ok: true, data: { id: inspection.id } })
}
