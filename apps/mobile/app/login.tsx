import { useRef, useState } from 'react'
import type { TextInput } from 'react-native'
import { formatCpf, normalizeCpf } from '@gomoto/core'

import { useAuth } from '../src/contexts/auth'
import { AuthShell } from '../src/components/AuthShell'
import { Button, Notice, TextField } from '../src/components/ui'

const NOT_A_CUSTOMER_ERROR = 'Esta conta não tem acesso ao app.'

// Fluxo de autenticação fica sempre no tema claro padrão (AuthShell →
// LightThemeScope), ignorando a preferência salva — antes do login não
// sabemos ainda quem é o cliente (nem se a preferência salva no aparelho é
// dele). Depois de autenticado, as tabs voltam a usar useTheme() normalmente.
export default function LoginScreen() {
  const { signIn } = useAuth()
  const [cpf, setCpf] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const passwordRef = useRef<TextInput>(null)

  function handleCpfChange(value: string) {
    const digits = normalizeCpf(value).slice(0, 11)
    // Mascara em tempo real quando o usuário já digitou os 11 dígitos —
    // antes disso, mostra os números crus pra não atrapalhar a digitação.
    setCpf(digits.length === 11 ? formatCpf(digits) : digits)
    if (digits.length === 11) passwordRef.current?.focus()
  }

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    const { error: authError } = await signIn(cpf, password)
    if (authError) {
      if (authError === NOT_A_CUSTOMER_ERROR) {
        setError(authError)
      } else if (authError.startsWith('Informe')) {
        setError(authError)
      } else {
        setError('CPF ou senha incorretos.')
      }
      setSubmitting(false)
    }
  }

  return (
    <AuthShell title="Entrar" subtitle="Acesse com o CPF cadastrado na sua locadora.">
      <TextField
        label="CPF"
        icon="person-outline"
        value={cpf}
        onChangeText={handleCpfChange}
        placeholder="000.000.000-00"
        autoCapitalize="none"
        keyboardType="number-pad"
        editable={!submitting}
        maxLength={14}
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />

      <TextField
        ref={passwordRef}
        label="Senha"
        icon="lock-closed-outline"
        value={password}
        onChangeText={setPassword}
        placeholder="Sua senha"
        secureTextEntry
        autoComplete="current-password"
        editable={!submitting}
        returnKeyType="go"
        onSubmitEditing={handleSubmit}
      />

      {error ? <Notice tone="danger" text={error} /> : null}

      <Button label="Entrar" onPress={handleSubmit} loading={submitting} />
    </AuthShell>
  )
}
