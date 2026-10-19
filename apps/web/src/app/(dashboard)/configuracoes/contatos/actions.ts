'use server'

import { TenantContactInputSchema } from '@gomoto/core'
import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { logAction } from '@/lib/audit'
import { revalidatePath } from 'next/cache'

type ActionError = { code: string; message: string }
type ActionFail = { ok: false; error: ActionError }
/** Ação sem retorno. */
type ActionResult = { ok: true } | ActionFail
/** Ação com retorno: `data` é obrigatório no sucesso, não opcional — foi por ser
 *  opcional que a tela precisava checar `!result.data` e perdia o narrowing. */
type ActionData<T> = { ok: true; data: T } | ActionFail

// ============================================================
// Contatos da locadora — exibidos no app do cliente ("Fale com a locadora")
// Owner/Admin: é informação que todo cliente vê. A RLS de tenant_contacts
// repete a mesma regra (get_user_admin_tenant_memberships).
// ============================================================

async function getAdminTenant() {
  try {
    return await requireTenantOwnerOrAdmin()
  } catch (err) {
    const code = err instanceof Error && err.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHORIZED'
    return { error: code as 'FORBIDDEN' | 'UNAUTHORIZED' }
  }
}

function adminError(code: 'FORBIDDEN' | 'UNAUTHORIZED'): ActionError {
  return {
    code,
    message: code === 'FORBIDDEN'
      ? 'Apenas o Proprietário ou um Administrador da empresa podem alterar os contatos'
      : 'Não autorizado',
  }
}

function parseContact(input: unknown) {
  const parsed = TenantContactInputSchema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Dados inválidos' } }
}

export async function createTenantContactAction(input: unknown): Promise<ActionData<{ id: string }>> {
  const ctx = await getAdminTenant()
  if ('error' in ctx) return { ok: false, error: adminError(ctx.error) }

  const parsed = parseContact(input)
  if ('error' in parsed) return { ok: false, error: parsed.error! }

  // Novo contato entra no fim da lista.
  const { data: last } = await ctx.supabase
    .from('tenant_contacts')
    .select('sort_order')
    .eq('tenant_id', ctx.tenantId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  const row = { ...parsed.data, tenant_id: ctx.tenantId, sort_order: (last?.sort_order ?? -1) + 1 }
  const { data, error } = await ctx.supabase
    .from('tenant_contacts')
    .insert(row)
    .select('id')
    .single()

  if (error) return { ok: false, error: { code: 'INTERNAL', message: error.message } }

  await logAction({ action: 'create', table: 'tenant_contacts', recordId: data.id, newData: row })
  revalidatePath('/configuracoes/contatos')
  return { ok: true, data: { id: data.id } }
}

export async function updateTenantContactAction(id: unknown, input: unknown): Promise<ActionResult> {
  const ctx = await getAdminTenant()
  if ('error' in ctx) return { ok: false, error: adminError(ctx.error) }
  if (typeof id !== 'string') return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Contato inválido' } }

  const parsed = parseContact(input)
  if ('error' in parsed) return { ok: false, error: parsed.error! }

  const { data: before } = await ctx.supabase
    .from('tenant_contacts')
    .select('label, phone, phone_kind, email, business_hours')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()
  if (!before) return { ok: false, error: { code: 'NOT_FOUND', message: 'Contato não encontrado' } }

  const { error } = await ctx.supabase
    .from('tenant_contacts')
    .update(parsed.data)
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)

  if (error) return { ok: false, error: { code: 'INTERNAL', message: error.message } }

  await logAction({ action: 'update', table: 'tenant_contacts', recordId: id, oldData: before, newData: parsed.data })
  revalidatePath('/configuracoes/contatos')
  return { ok: true }
}

export async function deleteTenantContactAction(id: unknown): Promise<ActionResult> {
  const ctx = await getAdminTenant()
  if ('error' in ctx) return { ok: false, error: adminError(ctx.error) }
  if (typeof id !== 'string') return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Contato inválido' } }

  // `.select()` devolve o que foi apagado: sem isso, RLS que barra o DELETE
  // responde sucesso com 0 linhas e a tela diria "excluído".
  const { data, error } = await ctx.supabase
    .from('tenant_contacts')
    .delete()
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .select('label, phone, phone_kind, email, business_hours')

  if (error) return { ok: false, error: { code: 'INTERNAL', message: error.message } }
  if (!data?.length) return { ok: false, error: { code: 'NOT_FOUND', message: 'Contato não encontrado' } }

  await logAction({ action: 'delete', table: 'tenant_contacts', recordId: id, oldData: data[0] })
  revalidatePath('/configuracoes/contatos')
  return { ok: true }
}

/** Grava a ordem exibida no app: `ids` na ordem final, do primeiro ao último. */
export async function reorderTenantContactsAction(ids: unknown): Promise<ActionResult> {
  const ctx = await getAdminTenant()
  if ('error' in ctx) return { ok: false, error: adminError(ctx.error) }
  if (!Array.isArray(ids) || !ids.every((v): v is string => typeof v === 'string')) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Ordem inválida' } }
  }

  for (const [index, id] of ids.entries()) {
    const { error } = await ctx.supabase
      .from('tenant_contacts')
      .update({ sort_order: index })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
    if (error) return { ok: false, error: { code: 'INTERNAL', message: error.message } }
    await logAction({ action: 'update', table: 'tenant_contacts', recordId: id, newData: { sort_order: index } })
  }

  revalidatePath('/configuracoes/contatos')
  return { ok: true }
}
