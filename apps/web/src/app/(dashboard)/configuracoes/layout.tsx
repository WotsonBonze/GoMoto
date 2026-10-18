import { PageTitle } from '@/components/layout/PageTitle'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantRole } from '@/lib/auth/tenant'
import { SettingsNav } from './_components/SettingsNav'

/**
 * Casca de Configurações: título único + submenu à esquerda, conteúdo à direita.
 *
 * O papel é resolvido aqui, no servidor, só para montar o menu — Operator e
 * Viewer não veem os itens da empresa (Spec 0011 RNF-003). Quem barra o acesso
 * é cada página (`requireTenantOwner*` + redirect), não este menu.
 */
export default async function ConfiguracoesLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const role = await getCurrentTenantRole(supabase)

  return (
    <div className="flex flex-col min-h-full">
      <PageTitle title="Configurações" subtitle="Sua conta, a empresa e o recebimento" />
      <div className="flex flex-1 min-h-0">
        <aside className="w-60 shrink-0 border-r border-border p-4">
          <div className="sticky top-[76px]">
            <SettingsNav role={role} />
          </div>
        </aside>
        <div className="flex-1 min-w-0 p-6">
          <div className="max-w-5xl space-y-8">{children}</div>
        </div>
      </div>
    </div>
  )
}
