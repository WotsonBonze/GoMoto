import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { IconCircle } from './IconCircle'
import type { IconName } from './Icon'
import type { Tone } from './tokens'

export function EmptyState({
  icon,
  title,
  text,
  tone = 'neutral',
}: {
  icon: IconName
  title: string
  text: string
  tone?: Tone
}) {
  const theme = useTheme()
  return (
    <View style={styles.wrap}>
      <IconCircle name={icon} tone={tone} size={60} />
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.text, { color: theme.textSoft }]}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 28 },
  title: { fontSize: 17, fontWeight: '700', marginTop: 8 },
  text: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
})
