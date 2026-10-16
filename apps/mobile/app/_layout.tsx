import { Stack, useRouter, useSegments } from 'expo-router'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import * as SplashScreen from 'expo-splash-screen'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SupabaseProvider, useMaintenanceRecordsRealtime } from '@gomoto/data'

import { AnimatedSplash } from '../src/components/AnimatedSplash'
import { AuthProvider, useAuth } from '../src/contexts/auth'
import { supabase } from '../src/lib/supabase'
import { ThemeProvider, useTheme, type ThemeTokens } from '../src/theme'

// Segura a splash nativa até o AnimatedSplash assumir a tela (ele chama
// hideAsync no primeiro layout) — sem isso ela some sozinha no 1º render.
void SplashScreen.preventAutoHideAsync()

// QueryClient é estável durante o ciclo do app. Defaults conservadores: dados
// considerados frescos por 30 s (mobile alterna foreground/background bastante).
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

function DataProviders({ children }: { children: ReactNode }) {
  const { activeTenantId } = useAuth()
  // Re-cria o value só quando o tenant ativo muda — evita render desnecessário
  // nos consumidores do contexto.
  const tenantId = useMemo(() => activeTenantId, [activeTenantId])
  return (
    <SupabaseProvider client={supabase} tenantId={tenantId}>
      <RealtimeSubscriptions>{children}</RealtimeSubscriptions>
    </SupabaseProvider>
  )
}

function RealtimeSubscriptions({ children }: { children: ReactNode }) {
  useMaintenanceRecordsRealtime()
  return <>{children}</>
}

function RootGate() {
  const { session, loading, needsPasswordSetup, needsTenantSelection } = useAuth()
  const router = useRouter()
  const segments = useSegments()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const [splashDone, setSplashDone] = useState(false)
  const handleSplashFinish = useCallback(() => setSplashDone(true), [])

  useEffect(() => {
    if (loading) return
    const onLogin = segments[0] === 'login'
    const onSetPassword = segments[0] === 'set-password'
    const onSelectTenant = segments[0] === 'select-tenant'

    if (!session && !onLogin) {
      router.replace('/login')
      return
    }
    if (session && needsPasswordSetup && !onSetPassword) {
      router.replace('/set-password')
      return
    }
    if (session && !needsPasswordSetup && needsTenantSelection && !onSelectTenant) {
      router.replace('/select-tenant')
      return
    }
    if (
      session &&
      !needsPasswordSetup &&
      !needsTenantSelection &&
      (onLogin || onSetPassword || onSelectTenant)
    ) {
      router.replace('/')
    }
  }, [session, loading, needsPasswordSetup, needsTenantSelection, segments, router])

  // Enquanto a sessão carrega, a logo pulsa no AnimatedSplash por cima; ao
  // terminar, o Stack monta por baixo e a splash sai revelando-o.
  return (
    <View style={styles.root}>
      {!loading && <Stack screenOptions={{ headerShown: false }} />}
      {!splashDone && <AnimatedSplash ready={!loading} onFinish={handleSplashFinish} />}
    </View>
  )
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DataProviders>
            <RootGate />
          </DataProviders>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
  },
})
