'use server'

import { revalidatePath, revalidateTag } from 'next/cache'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import type { ZodError } from 'zod'
import {
  CreateTenantWithOwnerSchema,
  TenantSchema,
  TenantSuspendSchema,
  TenantLoginBrandingSchema,
  LOGIN_LOGO_MAX_BYTES,
} from '@gomoto/core'

import { requirePlatformAdmin, requirePlatformOwner } from '@/lib/auth/platform'
import { logPlatformAction } from '@/lib/audit'
import { validateImageFile } from '@/lib/file-validation'
import { LOGIN_BRANDING_BUCKET, loginBrandingTag } from '@/lib/login-branding'

const PG_ERROR_MAP: Record<string, string> = {
  '23505': 'Conflito de unicidade: slug, CNPJ ou email já cadastrado',
  '23514': 'Dados inválidos: verifique CNPJ, UF ou CEP',
  '42501': 'Acesso negado',
  '22023': 'Dados inválidos',
}

function translatePgError(err: { code?: string; message: string }): string {
  if (err.code && PG_ERROR_MAP[err.code]) return PG_ERROR_MAP[err.code]
  return err.message ?? 'Erro inesperado'
}

/**
 * Achata `ZodError.issues` em pares { path, message } no formato dotted
 * (ex.: "tenant.slug", "owner.email"). Mantém só o primeiro erro de cada
 * campo pra evitar listas duplicadas; a UI mostra um erro por input.
 */
type FieldIssue = { path: string; message: string }
function flattenZodIssues(error: ZodError): FieldIssue[] {
  const seen = new Set<string>()
  const out: FieldIssue[] = []
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ path, message: issue.message })
  }
  return out
}

/**
 * Tenta mapear violações de UNIQUE/CHECK do Postgres pro campo correto,
 * pra UI conseguir marcar o input específico (slug, cnpj, email, etc.).
 */
function pgErrorToFieldIssues(err: {
  code?: string
  message: string
  details?: string
}): FieldIssue[] {
  const msg = `${err.message} ${err.details ?? ''}`
  if (err.code === '23505') {
    if (/idx_tenants_cnpj_unique|tenants_cnpj_key|\(cnpj\)/i.test(msg)) {
      return [{ path: 'tenant.cnpj', message: 'CNPJ já cadastrado em outra empresa' }]
    }
    if (/tenants_slug_key|\(slug\)/i.test(msg)) {
      return [{ path: 'tenant.slug', message: 'Slug já em uso — escolha outro' }]
    }
    if (/auth\.users.*email|users_email_partial_key|\(email\)/i.test(msg)) {
      return [{ path: 'owner.email', message: 'Email já cadastrado em auth.users' }]
    }
  }
  if (err.code === '23514') {
    if (/chk_tenants_cnpj_digits/i.test(msg)) {
      return [{ path: 'tenant.cnpj', message: 'CNPJ precisa ter 14 dígitos' }]
    }
    if (/chk_tenants_state_uf/i.test(msg)) {
      return [{ path: 'tenant.address_state', message: 'UF inválida (use 2 letras)' }]
    }
    if (/chk_tenants_zip_digits/i.test(msg)) {
      return [{ path: 'tenant.address_zip', message: 'CEP precisa ter 8 dígitos' }]
    }
  }
  return []
}


export async function createTenant(rawData: unknown) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  const parsed = CreateTenantWithOwnerSchema.safeParse(rawData)
  if (!parsed.success) {
    return {
      error: 'Corrija os campos destacados',
      fieldErrors: flattenZodIssues(parsed.error),
    }
  }

  // RPC atômica: cria auth user + tenant + tenant_members + settings +
  // audit em uma só transação. Se qualquer passo falhar, nada fica órfão.
  // O próprio RPC loga em platform_audit_logs (tenant.create_with_owner).
  const { data: newTenantId, error } = await ctx.supabase.rpc('create_tenant_with_owner', {
    p_tenant: parsed.data.tenant,
    p_owner_email: parsed.data.owner.email,
    p_owner_password: parsed.data.owner.password,
    p_owner_name: parsed.data.owner.name,
  })

  if (error) {
    const fieldErrors = pgErrorToFieldIssues(error)
    if (fieldErrors.length > 0) {
      return { error: 'Corrija os campos destacados', fieldErrors }
    }
    return { error: translatePgError(error) }
  }

  // Re-busca o tenant já criado para devolver pra UI (Server Action não
  // tem como retornar o row direto do RPC sem segunda chamada).
  const { data: tenantRow } = await ctx.supabase
    .from('tenants')
    .select()
    .eq('id', newTenantId as string)
    .single()

  revalidatePath('/admin/empresas')
  revalidatePath(`/admin/empresas/${newTenantId}`)
  return { data: tenantRow }
}

export async function updateTenant(id: string, rawData: unknown) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  const parsed = TenantSchema.partial().safeParse(rawData)
  if (!parsed.success) {
    return {
      error: 'Corrija os campos destacados',
      fieldErrors: flattenZodIssues(parsed.error),
    }
  }

  // Zod aceita CNPJ vazio (campo opcional); o CHECK do banco rejeita
  // string vazia. Normalizamos pra null antes do UPDATE.
  const update: Record<string, unknown> = { ...parsed.data }
  if (update.cnpj === '') update.cnpj = null

  const { data: before } = await ctx.supabase.from('tenants').select().eq('id', id).single()

  const { data, error } = await ctx.supabase
    .from('tenants')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    // updateTenant lida só com a parte `tenant`; ajustamos o prefixo
    // pro shape esperado pelo updateTenant flow (sem `tenant.`).
    const fieldErrors = pgErrorToFieldIssues(error).map((fe) => ({
      ...fe,
      path: fe.path.replace(/^tenant\./, ''),
    }))
    if (fieldErrors.length > 0) {
      return { error: 'Corrija os campos destacados', fieldErrors }
    }
    return { error: translatePgError(error) }
  }

  await logPlatformAction(ctx.supabase, ctx.userId, 'tenant.update', 'tenant', id, {
    before: before
      ? { name: before.name, slug: before.slug }
      : null,
    after: { name: data.name, slug: data.slug },
  })

  revalidatePath('/admin/empresas')
  revalidatePath(`/admin/empresas/${id}`)
  return { data }
}

export async function suspendTenant(id: string, rawData: unknown) {
  let ctx
  try {
    ctx = await requirePlatformOwner()
  } catch {
    return { error: 'Acesso negado' }
  }

  const parsed = TenantSuspendSchema.safeParse(rawData)
  if (!parsed.success) return { error: 'Dados inválidos', details: parsed.error.flatten() }

  const { error } = await ctx.supabase
    .from('tenants')
    .update({
      suspended_at: new Date().toISOString(),
      suspended_reason: parsed.data.reason,
      suspended_by: ctx.userId,
    })
    .eq('id', id)

  if (error) return { error: `Erro ao suspender empresa: ${error.message}` }

  await logPlatformAction(ctx.supabase, ctx.userId, 'tenant.suspend', 'tenant', id, {
    reason: parsed.data.reason,
  })

  revalidatePath('/admin/empresas')
  revalidatePath(`/admin/empresas/${id}`)
  return { success: true }
}

export async function reactivateTenant(id: string) {
  let ctx
  try {
    ctx = await requirePlatformOwner()
  } catch {
    return { error: 'Acesso negado' }
  }

  const { error } = await ctx.supabase
    .from('tenants')
    .update({
      suspended_at: null,
      suspended_reason: null,
      suspended_by: null,
    })
    .eq('id', id)

  if (error) return { error: `Erro ao reativar empresa: ${error.message}` }

  await logPlatformAction(ctx.supabase, ctx.userId, 'tenant.reactivate', 'tenant', id, {})

  revalidatePath('/admin/empresas')
  revalidatePath(`/admin/empresas/${id}`)
  return { success: true }
}

export async function regenerateOwnerLink(tenantId: string) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) return { error: 'Configuração do servidor incompleta' }

  const { data: member, error: memberErr } = await ctx.supabase
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()

  if (memberErr || !member) return { error: 'Owner do tenant não encontrado' }

  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  const { data: authUser, error: userErr } = await supabaseAdmin.auth.admin.getUserById(member.user_id)
  if (userErr || !authUser.user?.email) return { error: 'Usuário do owner não encontrado' }

  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: authUser.user.email,
    // expiresIn não está nos tipos do SDK 2.x mas é suportado pela API
    options: { expiresIn: 259200 } as { redirectTo?: string },
  })

  if (linkErr) return { error: `Falha ao gerar link: ${linkErr.message}` }

  await logPlatformAction(ctx.supabase, ctx.userId, 'regenerate_owner_link', 'tenant', tenantId, {})

  return { link: linkData.properties?.action_link ?? null }
}

export async function changeOwnerPassword(tenantId: string, newPassword: string) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  if (!newPassword || newPassword.length < 8) {
    return { error: 'A senha precisa ter no mínimo 8 caracteres' }
  }

  const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceUrl || !serviceKey) return { error: 'Configuração do servidor incompleta' }

  const { data: member, error: memberErr } = await ctx.supabase
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()

  if (memberErr || !member) return { error: 'Owner do tenant não encontrado' }

  const supabaseAdmin = createAdminClient(serviceUrl, serviceKey, { auth: { persistSession: false } })

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
    member.user_id,
    { password: newPassword },
  )

  if (updateErr) return { error: `Falha ao alterar senha: ${updateErr.message}` }

  await logPlatformAction(ctx.supabase, ctx.userId, 'owner.change_password', 'tenant', tenantId, {})

  return { success: true }
}

type LogoKind = 'dark' | 'light'

const LOGO_COLUMNS: Record<LogoKind, 'login_logo_path' | 'login_logo_light_path'> = {
  dark: 'login_logo_path',
  light: 'login_logo_light_path',
}

const LOGO_FIELDS: Record<LogoKind, { file: string; remove: string }> = {
  dark: { file: 'logo', remove: 'remove_logo' },
  light: { file: 'logo_light', remove: 'remove_logo_light' },
}

/**
 * "Login personalizado" da empresa (ADR 0042): subdomínio + logos do login.
 * Só o admin da plataforma escreve — tanto a coluna (platform_admin_manage_tenants)
 * quanto o bucket tenant-branding (policy com is_platform_admin()).
 *
 * Logo com nome versionado (`…-{timestamp}.ext`) e cache imutável: trocar o
 * logo gera um caminho novo, então o cache longo nunca serve logo velho.
 */
export async function updateTenantLoginBranding(id: string, formData: FormData) {
  let ctx
  try {
    ctx = await requirePlatformAdmin()
  } catch {
    return { error: 'Acesso negado' }
  }

  const parsed = TenantLoginBrandingSchema.safeParse({
    login_subdomain: formData.get('login_subdomain'),
  })
  if (!parsed.success) {
    return { error: 'Corrija os campos destacados', fieldErrors: flattenZodIssues(parsed.error) }
  }

  const files: Partial<Record<LogoKind, File>> = {}
  for (const kind of ['dark', 'light'] as const) {
    const file = formData.get(LOGO_FIELDS[kind].file)
    if (!(file instanceof File) || file.size === 0) continue
    if (file.size > LOGIN_LOGO_MAX_BYTES) {
      return { error: 'Corrija os campos destacados', fieldErrors: [{ path: LOGO_FIELDS[kind].file, message: 'Logo muito grande. Máximo: 1 MB.' }] }
    }
    const check = await validateImageFile(file)
    if (!check.valid) {
      return { error: 'Corrija os campos destacados', fieldErrors: [{ path: LOGO_FIELDS[kind].file, message: check.error ?? 'Arquivo inválido' }] }
    }
    files[kind] = file
  }

  const { data: before, error: beforeError } = await ctx.supabase
    .from('tenants')
    .select('login_subdomain, login_logo_path, login_logo_light_path')
    .eq('id', id)
    .single()
  if (beforeError || !before) return { error: 'Empresa não encontrada' }

  const update: Record<string, string | null> = { login_subdomain: parsed.data.login_subdomain }
  const uploaded: string[] = []
  const replaced: string[] = []

  for (const kind of ['dark', 'light'] as const) {
    const column = LOGO_COLUMNS[kind]
    const previous = before[column] as string | null
    const file = files[kind]

    if (file) {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
      const path = `${id}/login-logo-${kind}-${Date.now()}.${ext}`
      const { error: uploadError } = await ctx.supabase.storage
        .from(LOGIN_BRANDING_BUCKET)
        .upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false })
      if (uploadError) {
        if (uploaded.length) await ctx.supabase.storage.from(LOGIN_BRANDING_BUCKET).remove(uploaded)
        return { error: `Falha ao enviar o logo: ${uploadError.message}` }
      }
      uploaded.push(path)
      update[column] = path
      if (previous) replaced.push(previous)
    } else if (formData.get(LOGO_FIELDS[kind].remove) === '1') {
      update[column] = null
      if (previous) replaced.push(previous)
    }
  }

  const { error } = await ctx.supabase.from('tenants').update(update).eq('id', id)

  if (error) {
    if (uploaded.length) await ctx.supabase.storage.from(LOGIN_BRANDING_BUCKET).remove(uploaded)
    const msg = `${error.message} ${error.details ?? ''}`
    if (error.code === '23505' && /tenants_login_subdomain_key|\(login_subdomain\)/i.test(msg)) {
      return { error: 'Corrija os campos destacados', fieldErrors: [{ path: 'login_subdomain', message: 'Subdomínio já em uso por outra empresa' }] }
    }
    if (error.code === '23514' && /chk_tenants_login_subdomain_format/i.test(msg)) {
      return { error: 'Corrija os campos destacados', fieldErrors: [{ path: 'login_subdomain', message: 'Subdomínio inválido ou reservado' }] }
    }
    return { error: translatePgError(error) }
  }

  // Só depois do UPDATE: se ele falhasse, o logo antigo ainda estaria em uso.
  if (replaced.length) await ctx.supabase.storage.from(LOGIN_BRANDING_BUCKET).remove(replaced)

  await logPlatformAction(ctx.supabase, ctx.userId, 'tenant.login_branding_update', 'tenant', id, {
    subdomain_before: before.login_subdomain,
    subdomain_after: update.login_subdomain,
    logo: 'login_logo_path' in update ? (update.login_logo_path ? 'trocado' : 'removido') : null,
    logo_light: 'login_logo_light_path' in update ? (update.login_logo_light_path ? 'trocado' : 'removido') : null,
  })

  // Invalida o subdomínio antigo (deixou de ser login) e o novo (inclusive o
  // "não encontrado" que pode estar em cache para ele).
  for (const subdomain of new Set([before.login_subdomain, update.login_subdomain])) {
    if (subdomain) revalidateTag(loginBrandingTag(subdomain))
  }
  revalidatePath(`/admin/empresas/${id}`)
  return { success: true }
}
