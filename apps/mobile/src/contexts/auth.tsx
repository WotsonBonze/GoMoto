import type { Session } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import * as Linking from 'expo-linking'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cpfShellEmail, normalizeCpf, validateCpfDigits } from '@gomoto/core'

import { supabase } from '../lib/supabase'

export type TenantOption = {
  id: string
  name: string
  suspended_at: string | null
  contact_phone: string | null
  contact_email: string | null
}

type AuthContextValue = {
  session: Session | null
  loading: boolean
  needsPasswordSetup: boolean
  tenants: TenantOption[]
  activeTenantId: string | null
  needsTenantSelection: boolean
  signIn: (cpf: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  setPassword: (password: string) => Promise<{ error: string | null }>
  selectTenant: (tenantId: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const NOT_A_CUSTOMER_ERROR = 'Esta conta não tem acesso ao app.'
const ACTIVE_TENANT_KEY = 'gomoto.activeTenantId'

async function fetchCustomerTenants(userId: string): Promise<TenantOption[]> {
  // RLS de `customers.user_id = auth.uid()` + read policy nos tenants visíveis pelo
  // próprio link garantem que essa query só devolve tenants em que esse user é cliente.
  const { data } = await supabase
    .from('customers')
    .select('tenant_id, tenants:tenant_id ( id, name, suspended_at, contact_phone, contact_email )')
    .eq('user_id', userId)

  if (!data) return []

  const map = new Map<string, TenantOption>()
  for (const row of data) {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants
    if (tenant?.id && tenant?.name) {
      map.set(tenant.id, {
        id: tenant.id,
        name: tenant.name,
        suspended_at: tenant.suspended_at ?? null,
        contact_phone: tenant.contact_phone ?? null,
        contact_email: tenant.contact_email ?? null,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// Magic link da invite vem como `gomoto://auth-callback#access_token=...&refresh_token=...&type=invite`.
// Em Expo Go o scheme é trocado para `exp://` — o handler tolera ambos extraindo só o fragmento.
async function consumeAuthCallback(url: string | null): Promise<void> {
  if (!url) return
  const hashIdx = url.indexOf('#')
  if (hashIdx === -1) return
  const params = new URLSearchParams(url.slice(hashIdx + 1))
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  if (!accessToken || !refreshToken) return
  await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [tenants, setTenants] = useState<TenantOption[]>([])
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null)

  // Carrega tenants do cliente e resolve qual fica ativo. Chamada após cada
  // mudança de session (login, logout, refresh via magic link).
  async function syncTenantsFor(userId: string | null): Promise<TenantOption[]> {
    if (!userId) {
      setTenants([])
      setActiveTenantId(null)
      await AsyncStorage.removeItem(ACTIVE_TENANT_KEY)
      return []
    }
    const list = await fetchCustomerTenants(userId)
    setTenants(list)

    const stored = await AsyncStorage.getItem(ACTIVE_TENANT_KEY)
    if (list.length === 1) {
      // Único tenant — entra direto. Sobrescreve qualquer escolha antiga inválida.
      setActiveTenantId(list[0].id)
      await AsyncStorage.setItem(ACTIVE_TENANT_KEY, list[0].id)
    } else if (stored && list.some((t) => t.id === stored)) {
      setActiveTenantId(stored)
    } else {
      // Sem escolha salva ou escolha não pertence mais ao cliente: força picker.
      setActiveTenantId(null)
    }
    return list
  }

  useEffect(() => {
    // try/finally: qualquer falha no bootstrap (rede, RLS, storage) precisa
    // soltar o gate de loading — senão o app fica preso no spinner.
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (data.session) {
          const list = await syncTenantsFor(data.session.user.id)
          if (list.length === 0) {
            // Não é cliente em nenhum tenant — encerra a sessão.
            await supabase.auth.signOut()
            setSession(null)
          } else {
            setSession(data.session)
          }
        }
      } catch (err) {
        console.warn('[auth] falha ao restaurar sessão', err)
      } finally {
        setLoading(false)
      }
    })()

    Linking.getInitialURL().then(consumeAuthCallback)
    const linkingSub = Linking.addEventListener('url', (event) => {
      void consumeAuthCallback(event.url)
    })

    // O callback NÃO pode aguardar chamadas ao supabase: o auth-js aguarda os
    // subscribers dentro do initialize(). Ao abrir o app com o access token
    // vencido, o initialize() faz refresh e emite TOKEN_REFRESHED; se o callback
    // aguardar uma query, a query chama getSession(), que aguarda o initialize(),
    // que aguarda o callback → deadlock e spinner infinito (na 2ª abertura o
    // token já foi renovado e salvo, por isso "funcionava"). O setTimeout tira
    // o trabalho de dentro do ciclo de notificação, como a doc do Supabase manda.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setTimeout(() => {
        syncTenantsFor(next?.user?.id ?? null).catch((err) => {
          console.warn('[auth] falha ao sincronizar tenants', err)
        })
      }, 0)
    })

    return () => {
      linkingSub.remove()
      sub.subscription.unsubscribe()
    }
  }, [])

  async function signIn(cpf: string, password: string) {
    const digits = normalizeCpf(cpf)
    if (digits.length !== 11) {
      return { error: 'Informe um CPF válido (11 dígitos).' }
    }
    if (!validateCpfDigits(digits)) {
      return { error: 'CPF inválido: dígito verificador incorreto.' }
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: cpfShellEmail(digits),
      password,
    })
    if (error) return { error: 'CPF ou senha incorretos.' }

    if (data.user) {
      const list = await syncTenantsFor(data.user.id)
      if (list.length === 0) {
        await supabase.auth.signOut()
        return { error: NOT_A_CUSTOMER_ERROR }
      }
    }

    return { error: null }
  }

  async function signOut() {
    await supabase.auth.signOut()
    await syncTenantsFor(null)
  }

  async function setPassword(password: string) {
    const { error } = await supabase.auth.updateUser({
      password,
      data: { password_set: true },
    })
    if (error) return { error: error.message }
    // updateUser não emite SIGNED_IN; força refresh do session para o gate ver o flag novo.
    const { data } = await supabase.auth.getSession()
    setSession(data.session)
    return { error: null }
  }

  async function selectTenant(tenantId: string) {
    if (!tenants.some((t) => t.id === tenantId)) return
    setActiveTenantId(tenantId)
    await AsyncStorage.setItem(ACTIVE_TENANT_KEY, tenantId)
  }

  const needsPasswordSetup =
    !!session && session.user.user_metadata?.password_set !== true

  const needsTenantSelection = !!session && tenants.length > 1 && !activeTenantId

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        needsPasswordSetup,
        tenants,
        activeTenantId,
        needsTenantSelection,
        signIn,
        signOut,
        setPassword,
        selectTenant,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth precisa ser usado dentro de <AuthProvider>')
  return ctx
}
