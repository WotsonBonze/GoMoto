import { redirect } from 'next/navigation'

import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { ContatosClient } from './ContatosClient'

export const dynamic = 'force-dynamic'

/**
 * Contatos exibidos no app do cliente — Owner/Admin, mesma régua da RLS de
 * `tenant_contacts` (`get_user_admin_tenant_memberships()`).
 */
export default async function ContatosPage() {
  try {
    await requireTenantOwnerOrAdmin()
  } catch {
    redirect('/configuracoes/conta')
  }

  return <ContatosClient />
}
