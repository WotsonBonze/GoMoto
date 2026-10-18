import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { IconCircle } from './IconCircle'
import type { Tone } from './tokens'

/**
 * Linha de lista agrupada (estilo Ajustes do iOS): ícone, rótulo, subtítulo,
 * legenda opcional (terceira linha, mais discreta), valor à direita e chevron
 * quando pressionável. Use dentro de
 * `<Card padded={false}>`; `last` remove o divisor.
 */
export function ListItem({
  icon,
  iconTone = 'primary',
  label,
  sublabel,
  caption,
  value,
  trailing,
  onPress,
  destructive,
  last,
}: {
  icon?: IconName
  iconTone?: Tone
  label: string
  sublabel?: string
  caption?: string
  value?: string
  trailing?: ReactNode
  onPress?: () => void
  destructive?: boolean
  last?: boolean
}) {
  const theme = useTheme()
  const content = (
    <>
      {icon ? <IconCircle name={icon} tone={destructive ? 'danger' : iconTone} size={34} /> : null}
      <View style={styles.body}>
        <Text style={[styles.label, { color: destructive ? theme.danger : theme.text }]} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? <Text style={[styles.sublabel, { color: theme.textSoft }]} numberOfLines={1}>{sublabel}</Text> : null}
        {caption ? <Text style={[styles.caption, { color: theme.textMute }]} numberOfLines={2}>{caption}</Text> : null}
      </View>
      {value ? <Text style={[styles.value, { color: theme.textSoft }]} numberOfLines={1}>{value}</Text> : null}
      {trailing}
      {onPress && !destructive ? <Icon name="chevron-forward" size={18} color={theme.textMute} /> : null}
    </>
  )
  const rowStyle = [
    styles.row,
    !last && { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth },
  ]

  if (!onPress) return <View style={rowStyle}>{content}</View>
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [...rowStyle, pressed && { backgroundColor: theme.surfaceAlt }]}
    >
      {content}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 56 },
  body: { flex: 1, gap: 1 },
  label: { fontSize: 15, fontWeight: '500' },
  sublabel: { fontSize: 13 },
  caption: { fontSize: 12 },
  value: { fontSize: 15, maxWidth: '55%', textAlign: 'right' },
})
