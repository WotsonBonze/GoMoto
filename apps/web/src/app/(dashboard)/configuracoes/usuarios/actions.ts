'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { InviteTenantMemberSchema, ResetPasswordSchema, TenantMemberRoleSchema } from '@gomoto/core'
import type { ActionResult, ErrorCode } from '@gomoto/core'

import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { logAction } from '@/lib/audit'

const UUID_LOOSE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = () => z.string().regex(UUID_LOOSE, 'ID inválido')

// SQLSTATE das RPCs de set_tenant_member_role/revoke_tenant_member/
// reactivate_tenant_member (Spec 0011 §4.2) → ErrorCode do envelope.
// As mensagens do RAISE EXCEPTION já são PT-BR específicas por caso
// (autopromoção vs. autorrevogação vs. não-owner/admin, mesmo SQLSTATE
// 42501) — reaproveitamos em vez de duplicar um texto genérico por código.
const PG_CODE_TO_ERROR_CODE: Record<string, ErrorCode> = {
  '42501': 'FORBIDDEN',
  '23514': 'CONFLICT',
  P0002: 'NOT_FOUND',
  '22023': 'VALIDATION_ERROR',
}

function translateAccessError(err: { code?: string; message: string }): { code: ErrorCode; message: string } {
  const code = (err.code && PG_CODE_TO_ERROR_CODE[err.code]) || 'INTERNAL'
  const message = err.message ?? 'Erro inesperado'
  return { code, message: message.charAt(0).toUpperCase() + message.slice(1) }
}

async function requireCtx() {
  try {
    return await requireTenantOwnerOrAdmin()
  } catch (err) {
    const code = err instanceof Error && err.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHORIZED'
    return { error: { code: code as ErrorCode, message: code === 'FORBIDDEN' ? 'Apenas o Proprietário e os Administradores gerenciam usuários' : 'Não autorizado' } }
  }
}

// ============================================================
// inviteTenantMember — RF-006/008/009/010/011/012 (Spec 0011 §3.1)
// Cria o usuário com senha definida na hora pelo Owner/Admin — sem link
// de convite por enquanto (envio por email fica pra uma próxima etapa;
// até lá, quem cadastra também define/comunica a senha). Mesmo motor de
// admin/platform-admins/actions.ts::createPlatformAdmin — só muda o
// guard, a tabela de vínculo e o log.
// ============================================================

export async function inviteTenantMember(input: unknown): Promise<ActionResult<void>> {
  const ctx = await requireCtx()
  if ('error' in ctx) return { ok: false, error: ctx.error }

  const parsed = InviteTenantMemberSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: first?.message ?? 'Dados inválidos' } }
  }
  const { name, email, role, password } = parsed.data

  const { data: conflictRows, error: conflictErr } = await ctx.supabase.rpc('check_user_email_conflict', {
    p_email: email,
  })
  if (conflictErr) {
    console.error('[TENANT_MEMBER ERROR]', conflictErr)
    return { ok: false, error: { code: 'INTERNAL', message: 'Erro ao verificar email' } }
  }

  const conflict = (
    conflictRows as
      | { user_id: string; is_platform_admin: boolean; tenant_id: string | null; tenant_member_id: string | null }[]
      | null
  )?.[0]

  if (conflict?.is_platform_admin) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Esse email já é admin da plataforma' } } // RF-008
  }
  if (conflict?.tenant_id && conflict.tenant_id !== ctx.tenantId) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Esse email já pertence a outra empresa' } } // RF-009
  }
  if (conflict?.tenant_id && conflict.tenant_id === ctx.tenantId) {
    return { ok: false, error: { code: 'CONFLICT', message: 'Esse email já é membro dessa empresa' } } // RF-010
  }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) {
    return { ok: false, error: { code: 'INTERNAL', message: 'Configuração do servidor incompleta' } }
  }
  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  let authUserId = conflict?.user_id ?? null

  if (authUserId) {
    // auth.users já existe sem vínculo (tentativa anterior que falhou
    // antes de completar o vínculo, §3.3) — define a senha nova e reaproveita.
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, { password })
    if (updateErr) return { ok: false, error: { code: 'INTERNAL', message: `Falha ao definir senha: ${updateErr.message}` } }
  } else {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    })
    if (createErr || !created.user) {
      console.error('[TENANT_MEMBER_CREATE ERROR]', createErr)
      return { ok: false, error: { code: 'INTERNAL', message: `Falha ao criar usuário: ${createErr?.message ?? 'erro desconhecido'}` } }
    }
    authUserId = created.user.id
  }

  const { data: member, error: insertErr } = await ctx.supabase
    .from('tenant_members')
    .insert({ tenant_id: ctx.tenantId, user_id: authUserId, role, status: 'active' })
    .select('id')
    .single()

  if (insertErr) {
    console.error('[TENANT_MEMBER ERROR]', insertErr)
    return { ok: false, error: { code: 'INTERNAL', message: 'Falha ao vincular usuário ao tenant' } }
  }

  await logAction({
    action: 'create',
    table: 'tenant_members',
    recordId: member.id,
    newData: { email, role, status: 'active' },
  })

  revalidatePath('/configuracoes/usuarios')
  return { ok: true, data: undefined }
}

// ============================================================
// resetTenantMemberPassword — reset direto de senha por Owner/Admin
// (mesma restrição de inviteTenantMember: quem gerencia também
// define/comunica a senha nova, até o convite por email existir).
// ============================================================

export async function resetTenantMemberPassword(memberId: string, input: unknown): Promise<ActionResult<void>> {
  const ctx = await requireCtx()
  if ('error' in ctx) return { ok: false, error: ctx.error }

  const idCheck = uuid().safeParse(memberId)
  if (!idCheck.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'ID inválido' } }

  const parsed = ResetPasswordSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: first?.message ?? 'Senha inválida' } }
  }

  const { data: member, error: memberErr } = await ctx.supabase
    .from('tenant_members')
    .select('user_id')
    .eq('id', memberId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()
  if (memberErr || !member) return { ok: false, error: { code: 'NOT_FOUND', message: 'Membro não encontrado' } }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) {
    return { ok: false, error: { code: 'INTERNAL', message: 'Configuração do servidor incompleta' } }
  }
  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  const { error } = await supabaseAdmin.auth.admin.updateUserById(member.user_id, { password: parsed.data.password })
  if (error) {
    console.error('[TENANT_MEMBER ERROR]', error)
    return { ok: false, error: { code: 'INTERNAL', message: `Falha ao resetar senha: ${error.message}` } }
  }

  await logAction({
    action: 'update',
    table: 'tenant_members',
    recordId: memberId,
    newData: { password_reset: true },
  })

  return { ok: true, data: undefined }
}

// ============================================================
// updateTenantMemberRole — RF-015/016/017/023 (Spec 0011 §3.2)
// ============================================================

export async function updateTenantMemberRole(
  memberId: string,
  newRole: string,
): Promise<ActionResult<{ old_role: string; new_role: string }>> {
  const ctx = await requireCtx()
  if ('error' in ctx) return { ok: false, error: ctx.error }

  const idCheck = uuid().safeParse(memberId)
  if (!idCheck.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'ID inválido' } }

  const roleCheck = TenantMemberRoleSchema.safeParse(newRole)
  if (!roleCheck.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Papel inválido' } }

  const { data, error } = await ctx.supabase.rpc('set_tenant_member_role', {
    p_member_id: memberId,
    p_new_role: newRole,
  })
  if (error) {
    console.error('[TENANT_MEMBER ERROR]', error)
    return { ok: false, error: translateAccessError(error) }
  }

  const result = (data as { old_role: string; new_role: string }[] | null)?.[0]
  if (!result) return { ok: false, error: { code: 'INTERNAL', message: 'Resposta inesperada do banco' } }

  await logAction({
    action: 'update',
    table: 'tenant_members',
    recordId: memberId,
    oldData: { role: result.old_role },
    newData: { role: result.new_role },
  })

  revalidatePath('/configuracoes/usuarios')
  return { ok: true, data: result }
}

// ============================================================
// revokeTenantMember — RF-018/019/020/021/022/023 (Spec 0011 §3.3)
// ============================================================

export async function revokeTenantMember(memberId: string): Promise<ActionResult<void>> {
  const ctx = await requireCtx()
  if ('error' in ctx) return { ok: false, error: ctx.error }

  const idCheck = uuid().safeParse(memberId)
  if (!idCheck.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'ID inválido' } }

  const { error } = await ctx.supabase.rpc('revoke_tenant_member', { p_member_id: memberId })
  if (error) {
    console.error('[TENANT_MEMBER ERROR]', error)
    return { ok: false, error: translateAccessError(error) }
  }

  await logAction({
    action: 'update',
    table: 'tenant_members',
    recordId: memberId,
    newData: { status: 'revoked' },
  })

  revalidatePath('/configuracoes/usuarios')
  return { ok: true, data: undefined }
}

// ============================================================
// reactivateTenantMember — RF-024/025/026 (Spec 0011 §3.2, Fluxo D1)
// ============================================================

export async function reactivateTenantMember(memberId: string): Promise<ActionResult<void>> {
  const ctx = await requireCtx()
  if ('error' in ctx) return { ok: false, error: ctx.error }

  const idCheck = uuid().safeParse(memberId)
  if (!idCheck.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'ID inválido' } }

  const { error } = await ctx.supabase.rpc('reactivate_tenant_member', { p_member_id: memberId })
  if (error) {
    console.error('[TENANT_MEMBER ERROR]', error)
    return { ok: false, error: translateAccessError(error) }
  }

  await logAction({
    action: 'update',
    table: 'tenant_members',
    recordId: memberId,
    newData: { status: 'active' },
  })

  revalidatePath('/configuracoes/usuarios')
  return { ok: true, data: undefined }
}
