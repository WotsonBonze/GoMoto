import { redirect } from 'next/navigation'

import { requireTenantOwner } from '@/lib/auth/tenant'
import { EncargosClient } from './EncargosClient'

export const dynamic = 'force-dynamic'

/**
 * Multa e juros (ADR 0024) — só Owner: define quanto TODO cliente paga quando
 * atrasa, não é preferência operacional. A trava que vale é a do banco, em
 * `fn_create_late_charge_policy`.
 */
export default async function EncargosPage() {
  try {
    await requireTenantOwner()
  } catch {
    redirect('/configuracoes/conta')
  }

  return <EncargosClient />
}
