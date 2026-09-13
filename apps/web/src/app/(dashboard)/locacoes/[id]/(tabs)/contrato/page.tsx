import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CONTRACT_CUSTOMER_FIELDS, CONTRACT_VEHICLE_FIELDS, warnMissingContractFields } from '@gomoto/core'
import { ContractPreviewPanel } from '../../../_components/ContractPreviewPanel'
import { SignedContractUpload } from '../../../_components/SignedContractUpload'
import { getRentalCore } from '../_lib/get-rental-core'
import { fmt, CONTRACT_LABEL, CYCLE_LABEL } from '../_lib/shared'

const SIGNED_CONTRACT_BUCKET = 'rental-documents'

async function getSignedContractUrl(supabase: SupabaseClient, path: string | null | undefined): Promise<string | null> {
  if (!path) return null
  const { data } = await supabase.storage.from(SIGNED_CONTRACT_BUCKET).createSignedUrl(path, 3600)
  return data?.signedUrl ?? null
}

export default async function RentalContractTab({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { rental, tenantId, supabase } = await getRentalCore(id)

  const [depositResult, adjustmentsResult, tenantResult] = await Promise.all([
    supabase
      .from('deposits')
      .select('amount, closed_at')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase
      .from('rental_adjustments')
      .select('id, adjusted_at')
      .eq('rental_id', id)
      .eq('tenant_id', tenantId)
      .order('adjusted_at', { ascending: false }),
    supabase
      .from('tenants')
      .select('name, legal_name')
      .eq('id', tenantId)
      .single(),
  ])

  warnMissingContractFields('customer', rental.customer, CONTRACT_CUSTOMER_FIELDS)
  warnMissingContractFields('vehicle', rental.vehicle, CONTRACT_VEHICLE_FIELDS)

  const deposit     = depositResult.data as { amount: number; closed_at: string | null } | null
  const adjustments = adjustmentsResult.data ?? []
  const signedContractUrl = await getSignedContractUrl(supabase, rental.signed_contract_path)
  const tenantName  = tenantResult.data?.legal_name ?? tenantResult.data?.name ?? ''

  return (
    <section>
      <div className="overflow-hidden rounded-xl bg-surface">
        <table className="w-full text-[13px]">
          <tbody>
            {([
              ['Tipo',        CONTRACT_LABEL[rental.contract_type ?? 'rental']],
              ['Ciclo',       CYCLE_LABEL[rental.cycle ?? 'monthly']],
              ['Vencimento',  `Dia ${rental.due_day ?? '—'}`],
              ['Início',      fmt(rental.start_date)],
              ['Fim',         fmt(rental.end_date)],
              ['Pro rata',    rental.use_pro_rata ? 'Sim' : 'Não'],
              ...(rental.observations ? [['Observações', rental.observations]] : []),
            ] as [string, string][]).map(([label, value]) => (
              <tr key={label} className="border-b border-divider last:border-0">
                <td className="h-9 w-44 shrink-0 px-4 text-fg-mute">{label}</td>
                <td className="h-9 px-4 text-fg">{value}</td>
              </tr>
            ))}
            {adjustments.length > 0 && (
              <tr className="border-b border-divider last:border-0">
                <td className="h-9 w-44 shrink-0 px-4 text-fg-mute">Reajustes</td>
                <td className="h-9 px-4 text-fg">
                  {adjustments.length} · último em {fmt(adjustments[0].adjusted_at)}
                  {' '}
                  <Link
                    href={`/locacoes/${id}/financeiro`}
                    className="text-[12px] text-fg-mute transition-colors hover:text-primary"
                  >
                    ver histórico →
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 space-y-3">
        <ContractPreviewPanel
          rentalId={id}
          currentTemplateId={rental.contract_template_id}
          customer={{
            name: rental.customer?.name ?? '',
            cpf: rental.customer?.cpf ?? null,
            rg: rental.customer?.rg ?? null,
            drivers_license: rental.customer?.drivers_license ?? null,
            drivers_license_category: rental.customer?.drivers_license_category ?? null,
            street: rental.customer?.street ?? null,
            street_number: rental.customer?.street_number ?? null,
            complement: rental.customer?.complement ?? null,
            neighborhood: rental.customer?.neighborhood ?? null,
            city: rental.customer?.city ?? null,
            state: rental.customer?.state ?? null,
            zip_code: rental.customer?.zip_code ?? null,
          }}
          vehicle={{
            make: rental.vehicle?.make ?? '',
            model: rental.vehicle?.model ?? '',
            year_manufacture: rental.vehicle?.year_manufacture ?? '',
            year_model: rental.vehicle?.year_model ?? undefined,
            renavam: rental.vehicle?.renavam ?? '',
            license_plate: rental.vehicle?.license_plate ?? '',
            chassis: rental.vehicle?.chassis ?? '',
            color: rental.vehicle?.color ?? '',
            fuel: rental.vehicle?.fuel ?? undefined,
            km_current: rental.vehicle?.km_current ?? undefined,
            registered_owner_name: rental.vehicle?.registered_owner_name ?? null,
            registered_owner_document: rental.vehicle?.registered_owner_document ?? null,
          }}
          rental={{
            cycle: rental.cycle ?? 'monthly',
            due_day: rental.due_day ?? 10,
            cycle_amount: rental.cycle_amount ?? 0,
            start_date: rental.start_date ?? '',
            end_date: rental.end_date ?? '',
            security_deposit: deposit?.amount ?? null,
            km_initial: rental.km_initial,
          }}
          tenantName={tenantName}
        />
        <SignedContractUpload
          rentalId={id}
          currentFileName={rental.signed_contract_file_name}
          signedUrl={signedContractUrl}
        />
      </div>
    </section>
  )
}
