import { redirect } from 'next/navigation'

import { requireTenantOwner } from '@/lib/auth/tenant'
import { PagamentosClient } from './PagamentosClient'

export const dynamic = 'force-dynamic'

/**
 * Gateways de pagamento (ADR 0030) — só Owner: escolher por onde a empresa
 * recebe não é preferência operacional. A checagem que vale é a do banco, em
 * `fn_assert_gateway_owner`; aqui só não deixamos a tela existir para os outros.
 */
export default async function PagamentosPage() {
  try {
    await requireTenantOwner()
  } catch {
    redirect('/configuracoes/conta')
  }

  return <PagamentosClient />
}
