import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { RentalCycle } from '@gomoto/core'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'

export type RentalCore = {
  id: string
  status: string
  contract_type: string | null
  cycle: RentalCycle | null
  cycle_amount: number | null
  due_day: number | null
  start_date: string | null
  end_date: string | null
  use_pro_rata: boolean | null
  km_initial: number | null
  km_final: number | null
  observations: string | null
  contract_template_id: string | null
  signed_contract_path: string | null
  signed_contract_file_name: string | null
  signed_contract_uploaded_at: string | null
  checkin_checkout_inspection_profile_id: string | null
  periodic_inspection_profile_id: string | null
  periodic_inspection_frequency_days: number | null
  customer_id: string | null
  vehicle_id: string | null
  customer: {
    id: string
    phone: string | null
    name: string
    cpf: string | null
    rg: string | null
    drivers_license: string | null
    drivers_license_category: string | null
    street: string | null
    street_number: string | null
    complement: string | null
    neighborhood: string | null
    city: string | null
    state: string | null
    zip_code: string | null
  } | null
  vehicle: {
    id: string
    make: string
    model: string
    year_manufacture: string | null
    year_model: string | null
    renavam: string | null
    license_plate: string
    chassis: string | null
    color: string | null
    fuel: string | null
    km_current: number | null
    registered_owner_name: string | null
    registered_owner_document: string | null
  } | null
  contract_template: { id: string; name: string } | null
}

// Fetch base da locação, compartilhado entre layout.tsx e cada aba via
// React.cache() — dedupe por request, um único round-trip a `rentals`
// independente de quantos Server Components (layout + page) o chamarem.
//
// O select precisa ser uma string LITERAL (não montada a partir de
// CONTRACT_CUSTOMER_FIELDS/CONTRACT_VEHICLE_FIELDS em runtime) para o client
// tipado do Supabase inferir o shape do retorno — mesma armadilha já
// documentada em obsidian-notes/Telas/Locações.md. warnMissingContractFields
// roda em contrato/page.tsx, que é quem de fato consome esses campos.
export const getRentalCore = cache(async (id: string) => {
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const { data, error } = await supabase
    .from('rentals')
    .select(`*,
      customer:customers(id,phone,name,cpf,rg,drivers_license,drivers_license_category,street,street_number,complement,neighborhood,city,state,zip_code),
      vehicle:vehicles(id,make,model,year_manufacture,year_model,renavam,license_plate,chassis,color,fuel,km_current,registered_owner_name,registered_owner_document),
      contract_template:contract_templates(id,name)`)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) notFound()

  return {
    rental: data as unknown as RentalCore,
    tenantId,
    supabase,
  }
})
