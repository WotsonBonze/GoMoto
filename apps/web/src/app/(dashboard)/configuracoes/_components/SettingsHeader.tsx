import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Cabeçalho de cada sub-tela de Configurações — mesmo visual das seções antigas. */
export function SettingsHeader({
  icon: Icon,
  title,
  description,
  tone = 'info',
}: {
  icon: LucideIcon
  title: string
  description: string
  tone?: 'info' | 'primary' | 'warning'
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div
        className={cn(
          'p-2.5 rounded-full',
          tone === 'info' && 'bg-info-bg border border-info',
          tone === 'warning' && 'bg-warning-bg border border-warning',
          tone === 'primary' && 'bg-primary-tint',
        )}
      >
        <Icon
          className={cn(
            'w-5 h-5',
            tone === 'info' && 'text-info',
            tone === 'warning' && 'text-warning',
            tone === 'primary' && 'text-primary',
          )}
        />
      </div>
      <div>
        <h2 className="text-[28px] font-semibold text-fg">{title}</h2>
        <p className="text-[13px] text-fg-mute">{description}</p>
      </div>
    </div>
  )
}
