import { createContext, useContext } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

type SupabaseContextValue = {
  client: SupabaseClient
  /**
   * Tenant ativo da sessão. Quando null, mutations levantam erro —
   * o app deve resolver o tenant (via `tenant_members`) antes de
   * permitir interação com dados de domínio.
   */
  tenantId: string | null
  /**
   * Quando true, as leituras de lista filtram por `tenantId`. O app do cliente
   * liga: a RLS de cliente (`current_customer_ids()`) devolve o cadastro dele em
   * TODAS as locadoras, então sem o filtro quem é cliente de duas via placas e
   * cobranças das duas misturadas, qualquer que fosse a locadora escolhida.
   */
  scopeReadsToTenant: boolean
}

const SupabaseContext = createContext<SupabaseContextValue | null>(null)

export function SupabaseProvider({
  client,
  tenantId,
  scopeReadsToTenant = false,
  children,
}: {
  client: SupabaseClient
  tenantId: string | null
  scopeReadsToTenant?: boolean
  children: React.ReactNode
}) {
  return (
    <SupabaseContext.Provider value={{ client, tenantId, scopeReadsToTenant }}>
      {children}
    </SupabaseContext.Provider>
  )
}

export function useSupabaseContext(): SupabaseClient {
  const ctx = useContext(SupabaseContext)
  if (!ctx) throw new Error('useSupabaseContext deve ser usado dentro de <SupabaseProvider>')
  return ctx.client
}

export function useTenantId(): string | null {
  const ctx = useContext(SupabaseContext)
  if (!ctx) throw new Error('useTenantId deve ser usado dentro de <SupabaseProvider>')
  return ctx.tenantId
}

/**
 * Escopo das leituras de lista. `tenantId` é o filtro a aplicar (null = sem
 * filtro, a RLS decide) e entra na queryKey para o cache não servir os dados de
 * uma locadora na outra. `ready` é false enquanto o escopo está ligado mas a
 * locadora ainda não foi resolvida — consultar antes traria tudo misturado.
 */
export function useReadScope(): { tenantId: string | null; ready: boolean } {
  const ctx = useContext(SupabaseContext)
  if (!ctx) throw new Error('useReadScope deve ser usado dentro de <SupabaseProvider>')
  if (!ctx.scopeReadsToTenant) return { tenantId: null, ready: true }
  return { tenantId: ctx.tenantId, ready: !!ctx.tenantId }
}

/**
 * Usado em mutations que dependem de tenant_id (todos os inserts de domínio).
 * Retorna um getter que só falha quando chamado — assim não quebra render/SSR
 * antes do tenant ser resolvido pela sessão.
 */
export function useRequiredTenantId(): () => string {
  const tenantId = useTenantId()
  return () => {
    if (!tenantId) {
      throw new Error(
        'Operação requer tenant_id, mas o tenant ainda não foi resolvido na sessão.',
      )
    }
    return tenantId
  }
}
