import { forwardRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius } from './tokens'

type Props = TextInputProps & {
  label?: string
  /** Texto de apoio abaixo do campo (some quando há erro). */
  hint?: string
  error?: string | null
  icon?: IconName
  /** Marca o rótulo como opcional, em vez de asterisco nos obrigatórios. */
  optional?: boolean
}

/**
 * Campo de texto do app: rótulo acima, ícone opcional, borda que acende no
 * foco e mensagem de erro abaixo. `secureTextEntry` ganha botão de mostrar.
 */
export const TextField = forwardRef<TextInput, Props>(function TextField(
  { label, hint, error, icon, optional, secureTextEntry, multiline, style, onFocus, onBlur, ...rest },
  ref,
) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const borderColor = error ? theme.danger : focused ? theme.primary : theme.border

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={[styles.label, { color: theme.text }]}>
          {label}
          {optional ? <Text style={{ color: theme.textMute, fontWeight: '400' }}> (opcional)</Text> : null}
        </Text>
      ) : null}
      <View
        style={[
          styles.box,
          multiline && styles.boxMultiline,
          { backgroundColor: theme.surface, borderColor },
        ]}
      >
        {icon ? <Icon name={icon} size={18} color={focused ? theme.primary : theme.textMute} /> : null}
        <TextInput
          ref={ref}
          {...rest}
          multiline={multiline}
          secureTextEntry={secureTextEntry && !revealed}
          placeholderTextColor={theme.textMute}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          style={[styles.input, multiline && styles.inputMultiline, { color: theme.text }, style]}
        />
        {secureTextEntry ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Ocultar senha' : 'Mostrar senha'}
          >
            <Icon name={revealed ? 'eye-off-outline' : 'eye-outline'} size={20} color={theme.textMute} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <View style={styles.helpRow}>
          <Icon name="alert-circle" size={14} color={theme.danger} />
          <Text style={[styles.help, { color: theme.danger }]}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[styles.help, { color: theme.textMute }]}>{hint}</Text>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 14, fontWeight: '600' },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  boxMultiline: { alignItems: 'flex-start', paddingVertical: 12 },
  input: { flex: 1, fontSize: 16, paddingVertical: 12 },
  inputMultiline: { minHeight: 72, paddingVertical: 0, textAlignVertical: 'top' },
  helpRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  help: { fontSize: 13 },
})
