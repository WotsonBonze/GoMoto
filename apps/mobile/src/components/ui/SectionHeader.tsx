import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'

/** Título de seção: rótulo à esquerda; valor ou ação ("Ver todas") à direita. */
export function SectionHeader({
  title,
  trailing,
  actionLabel,
  onAction,
  color,
}: {
  title: string
  trailing?: string
  actionLabel?: string
  onAction?: () => void
  color?: string
}) {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: color ?? theme.text }]}>{title}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={10}>
          <Text style={[styles.action, { color: theme.primary }]}>{actionLabel}</Text>
        </Pressable>
      ) : trailing ? (
        <Text style={[styles.trailing, { color: color ?? theme.textSoft }]}>{trailing}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  title: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  trailing: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  action: { fontSize: 14, fontWeight: '600' },
})
