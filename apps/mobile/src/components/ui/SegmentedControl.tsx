import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius } from './tokens'

export type SegmentOption<T extends string> = {
  value: T
  label: string
  icon?: IconName
  /** Contador ao lado do rótulo; 0/undefined esconde. */
  count?: number
}

/** Seletor segmentado (abas internas, preferências de 2–4 opções). */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
}) {
  const theme = useTheme()
  return (
    <View style={[styles.wrap, { backgroundColor: theme.surfaceAlt }]} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[
              styles.segment,
              active && {
                backgroundColor: theme.surface,
                shadowColor: theme.shadowColor,
                shadowOpacity: theme.shadowOpacity * 1.5,
                shadowRadius: 4,
                shadowOffset: { width: 0, height: 1 },
                elevation: theme.shadowOpacity > 0 ? 1 : 0,
              },
            ]}
          >
            {o.icon ? <Icon name={o.icon} size={16} color={active ? theme.text : theme.textSoft} /> : null}
            <Text style={[styles.label, { color: active ? theme.text : theme.textSoft }]}>{o.label}</Text>
            {o.count ? (
              <View style={[styles.count, { backgroundColor: active ? theme.primary : theme.border }]}>
                <Text style={[styles.countText, { color: active ? theme.primaryContrast : theme.textSoft }]}>
                  {o.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', borderRadius: radius.md, padding: 4 },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.sm + 1,
  },
  label: { fontSize: 14, fontWeight: '600' },
  count: { minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, alignItems: 'center' },
  countText: { fontSize: 11, fontWeight: '700' },
})
