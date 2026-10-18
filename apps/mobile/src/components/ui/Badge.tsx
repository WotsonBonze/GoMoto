import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius, toneColors, type Tone } from './tokens'

/** Selo de status. `dot` para estados vivos; `icon` para estados finais. */
export function Badge({
  label,
  tone = 'neutral',
  dot,
  icon,
  size = 'md',
}: {
  label: string
  tone?: Tone
  dot?: boolean
  icon?: IconName
  size?: 'sm' | 'md'
}) {
  const theme = useTheme()
  const { fg, bg } = toneColors(theme, tone)
  return (
    <View style={[styles.base, size === 'sm' && styles.sm, { backgroundColor: bg }]}>
      {dot ? <View style={[styles.dot, { backgroundColor: fg }]} /> : null}
      {icon ? <Icon name={icon} size={size === 'sm' ? 11 : 13} color={fg} /> : null}
      <Text style={[styles.label, size === 'sm' && styles.labelSm, { color: fg }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  sm: { paddingHorizontal: 7, paddingVertical: 2, gap: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 12, fontWeight: '700' },
  labelSm: { fontSize: 10.5 },
})
