import {
  LayoutDashboard, Bike, Users, DollarSign, ScrollText,
  TrendingDown, AlertTriangle, Wrench,
  Clock, BarChart2, HelpCircle, Settings,
  ClipboardCheck, ClipboardList, ListOrdered, Camera, FileText,
  type LucideIcon,
} from 'lucide-react'

export interface NavLeaf {
  kind: 'leaf'
  href: string
  label: string
  icon: LucideIcon
  badge?: 'pending-maintenance'
}

export interface NavBranch {
  kind: 'branch'
  label: string
  icon: LucideIcon
  children: NavLeaf[]
}

export type NavItem = NavLeaf | NavBranch

export interface NavSection {
  label?: string
  items: NavItem[]
}

export const DASHBOARD_NAV: NavSection[] = [
  {
    items: [
      { kind: 'leaf', href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Operações',
    items: [
      {
        kind: 'branch',
        label: 'Locações',
        icon: Clock,
        children: [
          { kind: 'leaf', href: '/locacoes',      label: 'Contratos', icon: Clock },
          { kind: 'leaf', href: '/locacoes/fila', label: 'Fila',      icon: ListOrdered },
        ],
      },
      { kind: 'leaf', href: '/contratos/modelos', label: 'Modelos de Contrato', icon: ScrollText },
      { kind: 'leaf', href: '/clientes',          label: 'Clientes | Locatário', icon: Users },
    ],
  },
  {
    label: 'Frota',
    items: [
      { kind: 'leaf', href: '/veiculos', label: 'Veículos', icon: Bike },
      {
        kind: 'branch',
        label: 'Manutenção',
        icon: Wrench,
        children: [
          { kind: 'leaf', href: '/manutencao',        label: 'Registros',  icon: Wrench },
          { kind: 'leaf', href: '/aprovacoes',        label: 'Aprovações', icon: ClipboardCheck, badge: 'pending-maintenance' },
          { kind: 'leaf', href: '/planos-manutencao', label: 'Planos',     icon: ClipboardList },
        ],
      },
      {
        kind: 'branch',
        label: 'Vistorias',
        icon: Camera,
        children: [
          { kind: 'leaf', href: '/vistorias',        label: 'Pendências', icon: Camera },
          { kind: 'leaf', href: '/vistorias/perfis', label: 'Perfis',     icon: ClipboardList },
        ],
      },
      { kind: 'leaf', href: '/multas', label: 'Multas', icon: AlertTriangle },
    ],
  },
  {
    label: 'Financeiro',
    items: [
      { kind: 'leaf', href: '/financeiro',     label: 'Painel',    icon: BarChart2 },
      { kind: 'leaf', href: '/financeiro/dre', label: 'DRE',       icon: FileText },
      { kind: 'leaf', href: '/despesas',       label: 'Despesas',  icon: TrendingDown },
      { kind: 'leaf', href: '/cobrancas',      label: 'Cobranças', icon: DollarSign },
    ],
  },
  {
    label: 'Análises',
    items: [
      { kind: 'leaf', href: '/relatorios', label: 'Relatórios', icon: BarChart2 },
      { kind: 'leaf', href: '/processos',  label: 'Processos',  icon: HelpCircle },
    ],
  },
]

export const DASHBOARD_NAV_BOTTOM: NavLeaf[] = [
  { kind: 'leaf', href: '/configuracoes', label: 'Configurações', icon: Settings },
]
