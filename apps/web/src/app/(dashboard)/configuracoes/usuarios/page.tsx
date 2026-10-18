import { redirect } from 'next/navigation'

import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { UsuariosClient, type TenantMemberRow } from './UsuariosClient'

export const dynamic = 'force-dynamic'

/**
 * RNF-003: Operator/Viewer não pode nem saber que a tela existe — usa
 * redirect() em vez de notFound(), mesmo padrão já estabelecido em
 * (admin)/layout.tsx pra bloquear tenant_member em /admin/*.
 */
export default async function UsuariosPage() {
  let ctx
  try {
    ctx = await requireTenantOwnerOrAdmin()
  } catch {
    redirect('/configuracoes/conta')
  }

  // list_tenant_members SECURITY DEFINER junta auth.users e retorna email/nome.
  const { data, error } = await ctx.supabase.rpc('list_tenant_members')

  const rows: TenantMemberRow[] = (data ?? []) as TenantMemberRow[]

  return (
    <UsuariosClient
      initialRows={rows}
      loadError={error?.message ?? null}
      currentUserId={ctx.userId}
      currentRole={ctx.role}
    />
  )
}
