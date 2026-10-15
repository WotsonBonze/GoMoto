import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius } from './tokens'

type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'onBrand'

/** Botão do app. Altura mínima 52 (alvo de toque confortável) no tamanho padrão. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  loading,
  disabled,
  style,
}: {
  label: string
  onPress: () => void
  variant?: Variant
  size?: 'md' | 'lg'
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary:   { bg: theme.primary, fg: theme.primaryContrast, border: theme.primary },
    secondary: { bg: theme.surface, fg: theme.text, border: theme.border },
    danger:    { bg: theme.danger, fg: '#FFFFFF', border: theme.danger },
    success:   { bg: theme.success, fg: '#FFFFFF', border: theme.success },
    ghost:     { bg: 'transparent', fg: theme.primary, border: 'transparent' },
    onBrand:   { bg: theme.brandButton, fg: theme.brandButtonText, border: theme.brandButton },
  }
  const c = palette[variant]
  const inactive = disabled || loading

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      style={({ pressed }) => [
        styles.base,
        size === 'lg' ? styles.lg : styles.md,
        { backgroundColor: c.bg, borderColor: c.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <View style={styles.content}>
          {icon ? <Icon name={icon} size={size === 'lg' ? 20 : 18} color={c.fg} /> : null}
          <Text style={[styles.label, size === 'md' && styles.labelMd, { color: c.fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md + 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  lg: { minHeight: 52 },
  md: { minHeight: 42 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 16, fontWeight: '700', letterSpacing: 0.1 },
  labelMd: { fontSize: 14 },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
})
