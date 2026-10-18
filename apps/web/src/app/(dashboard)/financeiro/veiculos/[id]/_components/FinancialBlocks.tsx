import type { ReactNode } from 'react'

// Cada tom liga um ponto de legenda, a cor do número e o segmento da barra ao
// mesmo token — a cor ensina o significado uma vez e vale na tela inteira.
export type Tone = 'success' | 'danger' | 'info' | 'warning' | 'neutral'

const TONE: Record<Tone, { dot: string; text: string }> = {
  success: { dot: 'bg-success', text: 'text-success' },
  danger:  { dot: 'bg-danger',  text: 'text-danger' },
  info:    { dot: 'bg-info',    text: 'text-info' },
  warning: { dot: 'bg-warning', text: 'text-warning' },
  neutral: { dot: 'bg-fg-mute', text: 'text-fg' },
}

export function Stat({
  label,
  value,
  tone,
  muted = false,
  children,
}: {
  label: string
  value: string
  tone: Tone
  /** Valor zerado: o número perde a cor para não gritar por nada. */
  muted?: boolean
  children?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-fg-mute">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[tone].dot}`} aria-hidden />
        {label}
      </p>
      <p className={`mt-1.5 text-2xl font-bold tracking-tight ${muted ? 'text-fg-mute' : TONE[tone].text}`}>
        {value}
      </p>
      {children && <div className="mt-1 space-y-0.5 text-[12px] leading-snug text-fg-mute">{children}</div>}
    </div>
  )
}

export type BarSegment = {
  value: number
  /** Classe de fundo do token (ex.: 'bg-success'). */
  className: string
  label: string
}

/** Barra proporcional com 2px de respiro entre os trechos. Trecho zerado some. */
export function SegmentedBar({ segments, summary }: { segments: BarSegment[]; summary: string }) {
  const visible = segments.filter((s) => s.value > 0)
  if (visible.length === 0) {
    return <div className="h-2.5 w-full rounded-full bg-surface-2" role="img" aria-label="Sem valores" />
  }

  return (
    <div
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-2"
      role="img"
      aria-label={summary}
    >
      {visible.map((s) => (
        <div
          key={s.label}
          title={s.label}
          className={`${s.className} min-w-[4px] first:rounded-l-full last:rounded-r-full`}
          style={{ flex: `${s.value} 1 0%` }}
        />
      ))}
    </div>
  )
}
