import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'

/** Cabeçalho grande de aba (estilo "large title" do iOS). */
export function ScreenHeader({
  title,
  eyebrow,
  right,
}: {
  title: string
  /** Linha pequena acima do título (ex.: saudação, nome da locadora). */
  eyebrow?: string
  right?: ReactNode
}) {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <View style={styles.texts}>
        {eyebrow ? <Text style={[styles.eyebrow, { color: theme.textSoft }]} numberOfLines={1}>{eyebrow}</Text> : null}
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>{title}</Text>
      </View>
      {right}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  texts: { flex: 1, gap: 2 },
  eyebrow: { fontSize: 14, fontWeight: '500' },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
})
