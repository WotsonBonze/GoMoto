'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { TenantMemberRole } from '@gomoto/core'
import { cn } from '@/lib/utils'
import { visibleSettingsNav } from './settings-nav'

/** Submenu de Configurações — agrupado por escopo (pessoal, empresa, financeiro). */
export function SettingsNav({ role }: { role: TenantMemberRole | null }) {
  const pathname = usePathname()
  const groups = visibleSettingsNav(role)

  return (
    <nav aria-label="Configurações" className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-mute">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
              const Icon = item.icon
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] transition-colors',
                      active
                        ? 'bg-primary-tint text-fg font-medium'
                        : 'text-fg-soft hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : 'text-fg-mute')} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
