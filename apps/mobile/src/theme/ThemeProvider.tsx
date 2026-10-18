import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { darkTheme, lightTheme, type ThemeTokens } from './tokens'

export type ThemePreference = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'gomoto.themePreference'

interface ThemeContextValue {
  theme: ThemeTokens
  /** Modo já resolvido (preference 'auto' vira 'light'/'dark' conforme o SO). */
  mode: 'light' | 'dark'
  preference: ThemePreference
  setPreference: (pref: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * Preferência de tema do cliente (ADR 0021 — revisado): default 'auto'
 * (segue o SO via useColorScheme), com override manual persistido em
 * AsyncStorage — sobrevive a reabrir o app, é só local ao aparelho (não
 * sincroniza com o cockpit web, que guarda a preferência do operador no
 * banco por ser outro público e outra arquitetura de tokens).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('auto')

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark' || stored === 'auto') {
        setPreferenceState(stored)
      }
    })
  }, [])

  function setPreference(pref: ThemePreference) {
    setPreferenceState(pref)
    void AsyncStorage.setItem(STORAGE_KEY, pref)
  }

  const mode: 'light' | 'dark' =
    preference === 'auto' ? (systemScheme === 'light' ? 'light' : 'dark') : preference
  const theme = mode === 'light' ? lightTheme : darkTheme

  const value = useMemo(
    () => ({ theme, mode, preference, setPreference }),
    [theme, mode, preference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useThemeContext deve ser usado dentro de <ThemeProvider>')
  return ctx
}

/**
 * Força o tema claro na subárvore (login, definir senha, escolher locadora):
 * antes do login não sabemos quem é o cliente, nem se a preferência salva no
 * aparelho é dele. Os componentes do kit leem o tema do contexto, então o
 * override precisa ser um Provider, não um `lightTheme` local.
 */
export function LightThemeScope({ children }: { children: ReactNode }) {
  const parent = useThemeContext()
  const value = useMemo(
    () => ({ ...parent, theme: lightTheme, mode: 'light' as const }),
    [parent],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
