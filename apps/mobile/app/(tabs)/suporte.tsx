import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Constants from 'expo-constants'
import { useAuth } from '../../src/contexts/auth'
import { supabase } from '../../src/lib/supabase'
import { useTheme, useThemePreference, type ThemeTokens, type ThemePreference } from '../../src/theme'
import {
  Card,
  ListItem,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  type SegmentOption,
} from '../../src/components/ui'

const THEME_OPTIONS: SegmentOption<ThemePreference>[] = [
  { value: 'auto', label: 'Sistema', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Claro', icon: 'sunny-outline' },
  { value: 'dark', label: 'Escuro', icon: 'moon-outline' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  return raw.replace(/\D/g, '').length >= 10 ? raw : null
}

function openWhatsApp(phone: string) {
  const digits = phone.replace(/\D/g, '')
  const number = digits.startsWith('55') ? digits : `55${digits}`
  void Linking.openURL(`https://wa.me/${number}`)
}

function openMail(email: string) {
  void Linking.openURL(`mailto:${email}`)
}

function initials(name: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase()
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type CustomerProfile = { name: string | null; phone: string | null }

export default function ContaTab() {
  const { session, tenants, activeTenantId, signOut } = useAuth()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const { preference, setPreference } = useThemePreference()

  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null
  const appVersion = Constants.expoConfig?.version ?? '—'

  const [profile, setProfile] = useState<CustomerProfile>({ name: null, phone: null })

  useEffect(() => {
    const userId = session?.user.id
    setProfile({ name: null, phone: null })
    if (!userId || !activeTenantId) return
    // Um login tem um cadastro em `customers` POR locadora (PRD 0001): só
    // `user_id` devolve várias linhas para quem é cliente de duas, e o
    // `.maybeSingle()` falhava — o perfil ficava "—".
    supabase
      .from('customers')
      .select('name, phone')
      .eq('user_id', userId)
      .eq('tenant_id', activeTenantId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setProfile({ name: data.name ?? null, phone: data.phone ?? null })
      })
  }, [session?.user.id, activeTenantId])

  function handleSignOut() {
    Alert.alert('Sair', 'Tem certeza que deseja encerrar a sessão?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: () => void signOut() },
    ])
  }

  const tenantPhone = formatPhone(activeTenant?.contact_phone)
  const tenantEmail = activeTenant?.contact_email ?? null

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Conta" />

      <ScrollView contentContainerStyle={styles.content}>
        {/* Perfil */}
        <Card style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(profile.name)}</Text>
          </View>
          <View style={styles.profileBody}>
            <Text style={styles.profileName} numberOfLines={1}>{profile.name ?? '—'}</Text>
            {profile.phone ? <Text style={styles.profileMeta}>{profile.phone}</Text> : null}
            {activeTenant ? (
              <Text style={styles.profileMeta} numberOfLines={1}>Cliente {activeTenant.name}</Text>
            ) : null}
          </View>
        </Card>

        {/* Aparência */}
        <View style={styles.section}>
          <SectionHeader title="Aparência" />
          <SegmentedControl value={preference} options={THEME_OPTIONS} onChange={setPreference} />
        </View>

        {/* Minha locadora */}
        {activeTenant ? (
          <View style={styles.section}>
            <SectionHeader title="Fale com a locadora" />
            <Card padded={false}>
              <ListItem
                icon="business-outline"
                label="Empresa"
                value={activeTenant.name}
                last={!tenantPhone && !tenantEmail}
              />
              {tenantPhone ? (
                <ListItem
                  icon="logo-whatsapp"
                  iconTone="success"
                  label="WhatsApp"
                  sublabel={tenantPhone}
                  onPress={() => openWhatsApp(tenantPhone)}
                  last={!tenantEmail}
                />
              ) : null}
              {tenantEmail ? (
                <ListItem
                  icon="mail-outline"
                  label="E-mail"
                  sublabel={tenantEmail}
                  onPress={() => openMail(tenantEmail)}
                  last
                />
              ) : null}
            </Card>
            {!tenantPhone && !tenantEmail ? (
              <Text style={styles.footnote}>A locadora ainda não informou um contato.</Text>
            ) : null}
          </View>
        ) : null}

        {/* Sobre + sair */}
        <View style={styles.section}>
          <SectionHeader title="Sobre" />
          <Card padded={false}>
            <ListItem icon="information-circle-outline" iconTone="neutral" label="Versão do app" value={appVersion} last />
          </Card>
        </View>

        <Card padded={false}>
          <ListItem icon="log-out-outline" label="Sair da conta" onPress={handleSignOut} destructive last />
        </Card>
      </ScrollView>
    </SafeAreaView>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 48,
    gap: 24,
  },
  section: {
    gap: 10,
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: theme.brandText,
    fontSize: 20,
    fontWeight: '700',
  },
  profileBody: {
    flex: 1,
    gap: 2,
  },
  profileName: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
  },
  profileMeta: {
    color: theme.textSoft,
    fontSize: 13.5,
  },
  footnote: {
    color: theme.textMute,
    fontSize: 13,
    paddingHorizontal: 4,
  },
})
