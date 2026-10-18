import type { ViewStyle } from 'react-native'
import type { ThemeTokens } from '../../theme'

/**
 * Métricas do kit de componentes do app (ADR 0040). Fora de `ThemeTokens`
 * porque não variam entre claro e escuro.
 */
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const

/** Profundidade de cartão. No escuro a opacidade é 0 e a borda faz o papel. */
export function elevation(theme: ThemeTokens, level: 1 | 2 = 1): ViewStyle {
  return {
    shadowColor: theme.shadowColor,
    shadowOpacity: theme.shadowOpacity * level,
    shadowRadius: level === 1 ? 8 : 16,
    shadowOffset: { width: 0, height: level === 1 ? 2 : 6 },
    elevation: theme.shadowOpacity > 0 ? level * 2 : 0,
  }
}

/** Tom semântico dos componentes (badge, ícone, alerta). */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'pending' | 'info'

export function toneColors(theme: ThemeTokens, tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'primary': return { fg: theme.primary, bg: theme.primaryTint }
    case 'success': return { fg: theme.success, bg: theme.successBg }
    case 'warning': return { fg: theme.warning, bg: theme.warningBg }
    case 'danger':  return { fg: theme.danger, bg: theme.dangerBg }
    case 'pending': return { fg: theme.pending, bg: theme.pendingBg }
    case 'info':    return { fg: theme.info, bg: theme.infoBg }
    default:        return { fg: theme.textSoft, bg: theme.surfaceAlt }
  }
}
