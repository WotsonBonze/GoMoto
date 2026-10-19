'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { CreatePlatformAdminSchema, ResetPasswordSchema } from '@gomoto/core'

import { requirePlatformAdmin, requirePlatformOwner } from '@/lib/auth/platform'
import { logPlatformAction } from '@/lib/audit'

type PlatformRole = 'owner' | 'operator'

const ERROR_MAP: Record<string, string> = {
  '42501': 'Apenas proprietários podem realizar essa ação',
  '23514': 'A plataforma precisa de pelo menos um proprietário ativo',
  '23505': 'Esse usuário já é platform_admin',
  '22023': 'Role inválida',
  P0002: 'Usuário não encontrado',
}

// O Postgres devolve códigos SQLSTATE; mapeamos para mensagens humanas.
// Mantém os RAISE EXCEPTION do banco como única fonte de verdade.
function translateError(err: { code?: string; message: string }): string {
  if (err.code && ERROR_MAP[err.code]) return ERROR_MAP[err.code]
  return err.message ?? 'Erro inesperado'
}

/**
 * createPlatformAdmin — RF-001/003/004/005 (Spec 0011 §3.1/§5.1).
 * Cria o admin com senha definida na hora pelo Owner — sem link de
 * convite por enquanto (envio por email fica pra uma próxima etapa;
 * até lá, quem cadastra também define/comunica a senha).
 */
export async function createPlatformAdmin(rawData: unknown) {
  let ctx
  try {
    ctx = await requirePlatformOwner()
  } catch {
    return { error: 'Apenas proprietários podem adicionar admins' }
  }

  const parsed = CreatePlatformAdminSchema.safeParse(rawData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' }
  }
  const { name, email, role, password } = parsed.data

  // check_user_email_conflict resolve email → auth.users.id via SECURITY
  // DEFINER (auth.users não é acessível por PostgREST direto).
  const { data: conflictRows, error: conflictErr } = await ctx.supabase.rpc(
    'check_user_email_conflict',
    { p_email: email },
  )
  if (conflictErr) return { error: translateError(conflictErr) }

  const conflict = (
    conflictRows as
      | { user_id: string; is_platform_admin: boolean; tenant_id: string | null; tenant_member_id: string | null }[]
      | null
  )?.[0]

  if (conflict?.is_platform_admin) {
    return { error: 'Esse email já é admin da plataforma' } // RF-004
  }
  if (conflict?.tenant_id) {
    return { error: 'Esse email já é Usuário do Sistema de uma empresa — não pode virar admin da plataforma' } // RF-003
  }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) return { error: 'Configuração do servidor incompleta' }
  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  let authUserId = conflict?.user_id ?? null

  if (authUserId) {
    // auth.users já existe sem vínculo (ex.: tentativa anterior que falhou
    // antes de completar o vínculo) — define a senha nova e reaproveita.
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, { password })
    if (updateErr) return { error: `Falha ao definir senha: ${updateErr.message}` }
  } else {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    })
    if (createErr || !created.user) {
      console.error('[PLATFORM_ADMIN_CREATE ERROR]', createErr)
      return { error: `Falha ao criar usuário: ${createErr?.message ?? 'erro desconhecido'}` }
    }
    authUserId = created.user.id
  }

  // add_platform_admin_by_email já resolve email → user_id de novo e grava
  // a auditoria em platform_audit_logs (RPC existente, sem mudança).
  const { error } = await ctx.supabase.rpc('add_platform_admin_by_email', {
    p_email: email,
    p_role: role,
  })
  if (error) return { error: translateError(error) }

  // Recarrega a lista e devolve a linha recém-adicionada já enriquecida —
  // evita um reload completo na UI.
  const { data: rows } = await ctx.supabase.rpc('list_platform_admins')
  const created = (rows as Array<{ user_id: string }> | null)?.find(
    (r) => r.user_id === authUserId,
  )

  revalidatePath('/admin/platform-admins')
  return { success: true as const, row: created ?? null }
}

/**
 * resetPlatformAdminPassword — reset direto de senha por Owner (mesma
 * restrição de createPlatformAdmin: quem define/comunica a senha nova é
 * quem está gerenciando, até o convite por email existir).
 */
export async function resetPlatformAdminPassword(userId: string, rawData: unknown) {
  let ctx
  try {
    ctx = await requirePlatformOwner()
  } catch {
    return { error: 'Apenas proprietários podem redefinir a senha de um admin' }
  }

  const parsed = ResetPasswordSchema.safeParse(rawData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Senha inválida' }
  }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) return { error: 'Configuração do servidor incompleta' }
  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: parsed.data.password })
  if (error) return { error: `Falha ao resetar senha: ${error.message}` }

  await logPlatformAction(ctx.supabase, ctx.userId, 'platform_admin.reset_password', 'platform_admin', userId, {})

  return { success: true as const }
}

export async function setPlatformAdminRole(userId: string, role: PlatformRole) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  const { error } = await ctx.supabase.rpc('set_platform_admin_role', {
    p_user_id: userId,
    p_role: role,
  })
  if (error) return { error: translateError(error) }

  revalidatePath('/admin/platform-admins')
  return { success: true as const }
}

export async function removePlatformAdmin(userId: string) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  // Proteção amistosa: o caller não pode se remover. O guard "≥1 owner"
  // do banco impediria perder todos os owners, mas remover-se sendo
  // operator deixaria a pessoa sem acesso ao admin — quase sempre erro.
  if (userId === ctx.userId) return { error: 'Você não pode remover a si mesmo' }

  const { error } = await ctx.supabase.rpc('remove_platform_admin', {
    p_user_id: userId,
  })
  if (error) return { error: translateError(error) }

  revalidatePath('/admin/platform-admins')
  return { success: true as const }
}
