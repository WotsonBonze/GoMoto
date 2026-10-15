import { useQuery } from '@tanstack/react-query'
import { useSupabaseContext, useTenantId } from '../context'
import { listTenantContacts } from '../repositories/tenantContacts'

/**
 * Contatos que a locadora publica para os clientes ("Fale com a locadora").
 * Lido pelo cockpit (Configurações) e pelo app do cliente (aba Conta) — nos
 * dois, o tenant vem do `SupabaseProvider` (no mobile, a locadora ativa).
 */
export function useTenantContacts() {
  const supabase = useSupabaseContext()
  const tenantId = useTenantId()
  return useQuery({
    queryKey: ['tenant-contacts', tenantId],
    queryFn: () => listTenantContacts(supabase, tenantId!),
    enabled: !!tenantId,
  })
}
