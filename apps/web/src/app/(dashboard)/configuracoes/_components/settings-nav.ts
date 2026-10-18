import {
  Activity, Contact, CreditCard, Palette, Percent, UserRound, UsersRound,
  type LucideIcon,
} from 'lucide-react'
import type { TenantMemberRole } from '@gomoto/core'

/**
 * Quem enxerga o item no menu. É só o que se MOSTRA: cada página repete a
 * checagem no servidor (`requireTenantOwner*`), e a que vale é a do banco.
 */
export type SettingsAccess = 'all' | 'owner-admin' | 'owner'

export interface SettingsNavItem {
  href: string
  label: string
  icon: LucideIcon
  access: SettingsAccess
}

export interface SettingsNavGroup {
  label: string
  items: SettingsNavItem[]
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Minha conta',
    items: [
      { href: '/configuracoes/conta',     label: 'Perfil e segurança', icon: UserRound, access: 'all' },
      { href: '/configuracoes/aparencia', label: 'Aparência',          icon: Palette,   access: 'all' },
    ],
  },
  {
    label: 'Empresa',
    items: [
      { href: '/configuracoes/usuarios', label: 'Usuários',        icon: UsersRound, access: 'owner-admin' },
      { href: '/configuracoes/contatos', label: 'Contatos do app', icon: Contact,    access: 'owner-admin' },
    ],
  },
  {
    label: 'Financeiro',
    items: [
      { href: '/configuracoes/pagamentos',  label: 'Gateways de pagamento', icon: CreditCard, access: 'owner' },
      { href: '/configuracoes/encargos',    label: 'Multa e juros',         icon: Percent,    access: 'owner' },
      { href: '/configuracoes/integracoes', label: 'Diagnóstico',           icon: Activity,   access: 'owner-admin' },
    ],
  },
]

export function canSee(access: SettingsAccess, role: TenantMemberRole | null): boolean {
  if (access === 'all') return true
  if (access === 'owner') return role === 'owner'
  return role === 'owner' || role === 'admin'
}

/** Menu já filtrado pelo papel; grupos que ficam vazios somem. */
export function visibleSettingsNav(role: TenantMemberRole | null): SettingsNavGroup[] {
  return SETTINGS_NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => canSee(i.access, role)) }))
    .filter((g) => g.items.length > 0)
}
