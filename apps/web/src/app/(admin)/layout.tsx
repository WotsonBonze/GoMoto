import { redirect } from 'next/navigation'
import { Building2, LayoutDashboard, LogOut, ShieldCheck, UsersRound } from 'lucide-react'

import { createClient } from '@/lib/supabase/server'
import { getPlatformRole } from '@/lib/auth/platform'
import { Providers } from '@/providers/Providers'
import { Topbar } from '@/components/layout/Topbar'
import { AdminNav } from './AdminNav'

interface AdminLayoutProps {
  children: React.ReactNode
}

/**
 * Layout do control plane (área administrativa da plataforma).
 * Separado do (dashboard) do tenant para não vazar sidebar/branding entre
 * os universos. Gate em Server Component redireciona quem não é
 * platform_admin antes de qualquer render — o reforço real (RLS) está
 * nas policies `platform_admin_*` do banco.
 */
export default async function AdminLayout({ children }: AdminLayoutProps) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const role = await getPlatformRole(supabase)
  if (!role) redirect('/dashboard')

  const userName  = user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? undefined
  const userEmail = user?.email ?? undefined

  return (
    <Providers>
      <div className="flex h-screen bg-bg">
          <aside className="w-[240px] border-r border-divider bg-bg p-4 flex flex-col shrink-0 overflow-y-auto">
            <div className="flex items-center gap-2 mb-6">
              <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-bg" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-fg leading-tight">Locaw</div>
                <div className="text-[11px] text-fg-mute">Admin da plataforma</div>
              </div>
            </div>

            <AdminNav
              items={[
                { href: '/admin/dashboard',       label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
                { href: '/admin/empresas',         label: 'Empresas',  icon: <Building2 className="w-4 h-4" /> },
                { href: '/admin/platform-admins',  label: 'Admins',    icon: <UsersRound className="w-4 h-4" /> },
              ]}
            />

            <div className="border-t border-divider pt-3 space-y-1">
              <form action="/auth/logout" method="post">
                <button
                  type="submit"
                  className="flex items-center gap-2 w-full px-3 h-10 rounded-lg text-[13px] text-fg-soft hover:bg-danger-bg hover:text-danger transition"
                >
                  <LogOut className="w-4 h-4" /> Sair
                </button>
              </form>
            </div>
          </aside>

          <div className="flex-1 flex flex-col min-w-0">
            <Topbar userName={userName} userEmail={userEmail} />
            <main className="relative flex-1 min-h-0 overflow-y-auto">{children}</main>
          </div>
        </div>
    </Providers>
  )
}
