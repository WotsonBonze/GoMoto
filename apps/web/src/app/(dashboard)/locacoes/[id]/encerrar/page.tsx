import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { TerminateForm } from '../../_components/TerminateForm'

export default async function TerminateRentalPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase  = await createClient()
  const tenantId  = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const { data, error } = await supabase
    .from('rentals')
    .select('*, customer:customers(id,name), vehicle:vehicles(id,license_plate,make,model,km_current)')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data || data.status !== 'active') notFound()

  return <TerminateForm rental={data} />
}
