import { useRef, useState } from 'react'
import type { TextInput } from 'react-native'

import { useAuth } from '../src/contexts/auth'
import { AuthShell } from '../src/components/AuthShell'
import { Button, Notice, TextField } from '../src/components/ui'

// Fluxo de autenticação fica sempre no tema claro padrão — ver login.tsx.
export default function SetPasswordScreen() {
  const { setPassword, signOut } = useAuth()
  const [password, setPasswordValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const confirmRef = useRef<TextInput>(null)

  async function handleSubmit() {
    setError(null)
    if (password.length < 8) {
      setError('A senha precisa ter pelo menos 8 caracteres.')
      return
    }
    if (password !== confirm) {
      setError('As senhas não coincidem.')
      return
    }
    setSubmitting(true)
    const { error: updateError } = await setPassword(password)
    if (updateError) {
      setError(updateError)
      setSubmitting(false)
    }
    // sucesso: o gate em _layout.tsx redireciona para "/" assim que needsPasswordSetup vira false.
  }

  return (
    <AuthShell title="Crie sua senha" subtitle="Você vai usá-la nos próximos acessos ao app.">
      <TextField
        label="Nova senha"
        icon="lock-closed-outline"
        value={password}
        onChangeText={setPasswordValue}
        placeholder="Mínimo 8 caracteres"
        hint="Use pelo menos 8 caracteres."
        secureTextEntry
        autoComplete="new-password"
        editable={!submitting}
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />

      <TextField
        ref={confirmRef}
        label="Confirmar senha"
        icon="lock-closed-outline"
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Repita a senha"
        secureTextEntry
        autoComplete="new-password"
        editable={!submitting}
        returnKeyType="go"
        onSubmitEditing={handleSubmit}
      />

      {error ? <Notice tone="danger" text={error} /> : null}

      <Button label="Salvar senha" onPress={handleSubmit} loading={submitting} />
      <Button label="Cancelar e sair" variant="ghost" size="md" onPress={signOut} disabled={submitting} />
    </AuthShell>
  )
}
