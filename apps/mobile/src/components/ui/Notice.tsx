import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius, toneColors, type Tone } from './tokens'

const DEFAULT_ICON: Record<Tone, IconName> = {
  neutral: 'information-circle',
  primary: 'information-circle',
  info: 'information-circle',
  success: 'checkmark-circle',
  warning: 'warning',
  pending: 'time',
  danger: 'alert-circle',
}

/** Aviso em linha: ícone + título opcional + texto, tingido pelo tom. */
export function Notice({
  tone = 'info',
  icon,
  title,
  text,
}: {
  tone?: Tone
  icon?: IconName
  title?: string
  text: string
}) {
  const theme = useTheme()
  const { fg, bg } = toneColors(theme, tone)
  return (
    <View style={[styles.wrap, { backgroundColor: bg }]}>
      <Icon name={icon ?? DEFAULT_ICON[tone]} size={20} color={fg} />
      <View style={styles.body}>
        {title ? <Text style={[styles.title, { color: fg }]}>{title}</Text> : null}
        <Text style={[styles.text, { color: theme.textSoft }]}>{text}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: radius.md + 2, padding: 14 },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '700' },
  text: { fontSize: 13.5, lineHeight: 19 },
})
