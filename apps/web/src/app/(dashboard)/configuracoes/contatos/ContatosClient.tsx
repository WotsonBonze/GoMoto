'use client'

import { useTenantContacts } from '@gomoto/data'
import { TenantContactsSection } from './_components/TenantContactsSection'

export function ContatosClient() {
  const contactsQuery = useTenantContacts()

  return (
    <TenantContactsSection
      contacts={contactsQuery.data ?? []}
      isLoading={contactsQuery.isLoading}
      onChanged={() => { void contactsQuery.refetch() }}
    />
  )
}
