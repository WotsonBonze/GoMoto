import type { Metadata, Viewport } from 'next'
import { redirect } from 'next/navigation'
import { Bike, LogOut } from 'lucide-react'

import { Providers } from '@/providers/Providers'
import { createClient } from '@/lib/supabase/server'
import { getPlatformRole } from '@/lib/auth/platform'
import { getCurrentTenantId } from '@/lib/auth/tenant'

// PWA instalável (ADR 0018) — escopo restrito a este layout, não ao app
// inteiro: só a fatia /mobile/* vira "app" na tela inicial do celular, o
// cockpit desktop (dashboard) continua sem manifest/ícone algum.
export const metadata: Metadata = {
  manifest: '/mobile-manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Locaw Vistoria',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/mobile/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#121212',
}

interface MobileLayoutProps {
  children: React.ReactNode
}

function TenantSuspendedPage({ tenantName }: { tenantName: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-bg px-6">
      <div className="text-center max-w-sm">
        <h1 className="text-[18px] font-semibold text-fg mb-2">{tenantName}</h1>
        <p className="text-fg-mute text-[13px]">
          Esta empresa está temporariamente indisponível. Entre em contato com o suporte.
        </p>
      </div>
    </div>
  )
}

/**
 * Layout de campo (ADR 0018) — telas adaptadas pra celular, hoje só a
 * vistoria no pátio. Mesma sessão/tenant do (dashboard) (mesmo funcionário,
 * mesmo login), mas sem a chrome de Sidebar/Topbar desktop: tela cheia,
 * coluna única, alvo de toque grande, pensado pra uso com uma mão parado ao
 * lado da moto. Prefixo `/mobile/*` genérico (não `/vistorias/*`) porque
 * outras telas podem ganhar versão adaptada aqui no futuro (ADR 0018,
 * "Quando reavaliar").
 */
export default async function MobileLayout({ children }: MobileLayoutProps) {
  const supabase = await createClient()
  const role = await getPlatformRole(supabase)
  if (role) redirect('/admin/dashboard')

  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) redirect('/login')

  const [{ data: tenant }, { data: { user } }] = await Promise.all([
    supabase.from('tenants').select('id, name, suspended_at').eq('id', tenantId).single(),
    supabase.auth.getUser(),
  ])

  if (tenant?.suspended_at) {
    return <TenantSuspendedPage tenantName={tenant.name} />
  }

  const userName = user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? user?.email ?? undefined

  return (
    <Providers>
      <div className="min-h-screen bg-bg">
        <header className="sticky top-0 z-30 h-12 flex items-center justify-between gap-3 px-4 bg-bg backdrop-blur border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 flex-shrink-0 bg-primary rounded-full flex items-center justify-center">
              <Bike className="w-3.5 h-3.5 text-primary-contrast" />
            </div>
            <span className="text-[13px] font-bold text-fg truncate">Locaw</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            {userName && (
              <span className="text-[12px] text-fg-mute truncate max-w-[140px]">{userName}</span>
            )}
            <form action="/auth/logout" method="post">
              <button
                type="submit"
                className="h-8 px-3 rounded-full text-[12px] text-fg-mute hover:text-danger hover:bg-danger-bg transition-colors flex items-center gap-1.5 flex-shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sair
              </button>
            </form>
          </div>
        </header>
        {children}
      </div>
    </Providers>
  )
}
