import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon } from './Icon'

/** Cabeçalho de modal: título à esquerda, botão redondo de fechar à direita. */
export function ModalHeader({
  title,
  subtitle,
  onClose,
  disabled,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  disabled?: boolean
}) {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <View style={styles.texts}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[styles.subtitle, { color: theme.textSoft }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <Pressable
        onPress={onClose}
        disabled={disabled}
        hitSlop={12}
        style={({ pressed }) => [
          styles.close,
          { backgroundColor: theme.surfaceAlt },
          (pressed || disabled) && styles.dim,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Fechar"
      >
        <Icon name="close" size={20} color={theme.textSoft} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  texts: { flex: 1, gap: 1 },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 13 },
  close: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.6 },
})
