import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { loadPeriodAdjustmentContext } from '../../_lib/period-adjustment'
import { AdjustRentalPeriodForm } from '../../_components/AdjustRentalPeriodForm'

/**
 * Ajuste de período e condições da locação (ADR 0035).
 *
 * O cronograma e as cobranças são lidos NO SERVIDOR e passados como props. A
 * tela anterior (`/reajustar`) alimentava a prévia por `useRentalSchedule`, um
 * cache do TanStack que o `revalidatePath` da action não alcança — depois de
 * gravar, a prévia seguia anunciando que as mesmas parcelas ainda iam mudar.
 */
export default async function AdjustRentalPeriodPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const ctx = await loadPeriodAdjustmentContext(supabase, tenantId, id)
  if (!ctx || ctx.rental.status !== 'active') notFound()

  return (
    <AdjustRentalPeriodForm
      rental={ctx.rental}
      lines={ctx.lines}
      charges={ctx.charges}
      otherRentals={ctx.other_rentals}
      today={ctx.today}
    />
  )
}
