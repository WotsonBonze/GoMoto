import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../../theme'
import { elevation, radius, space } from './tokens'

/**
 * Cartão base. `variant="brand"` é a superfície azul-marinho de destaque —
 * no máximo uma por tela, para o dado mais importante.
 */
export function Card({
  children,
  variant = 'default',
  padded = true,
  onPress,
  style,
}: {
  children: ReactNode
  variant?: 'default' | 'brand' | 'outline'
  padded?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const base: ViewStyle = {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: padded ? space.lg : 0,
    overflow: padded ? 'visible' : 'hidden',
    ...(variant === 'brand'
      ? { backgroundColor: theme.brand, borderColor: theme.brandBorder, ...elevation(theme, 2) }
      : variant === 'outline'
        ? { backgroundColor: 'transparent', borderColor: theme.border }
        : { backgroundColor: theme.surface, borderColor: theme.border, ...elevation(theme) }),
  }

  if (!onPress) return <View style={[base, style]}>{children}</View>
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [base, style, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      {children}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.88, transform: [{ scale: 0.995 }] },
})
