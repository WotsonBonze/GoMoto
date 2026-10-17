import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { applyPhoneMask, type TenantContact } from '@gomoto/core'
import { useTenantContacts } from '@gomoto/data'
import { useAuth, type TenantOption } from '../../src/contexts/auth'
import { supabase } from '../../src/lib/supabase'
import { useTheme, useThemePreference, type ThemeTokens, type ThemePreference } from '../../src/theme'
import {
  Badge,
  Card,
  Icon,
  ListItem,
  ModalHeader,
  ScreenHeader,
  SectionHeader,
  SegmentedControl,
  type SegmentOption,
  type IconName,
  type Tone,
} from '../../src/components/ui'

const THEME_OPTIONS: SegmentOption<ThemePreference>[] = [
  { value: 'auto', label: 'Sistema', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Claro', icon: 'sunny-outline' },
  { value: 'dark', label: 'Escuro', icon: 'moon-outline' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openWhatsApp(phone: string) {
  const digits = phone.replace(/\D/g, '')
  const number = digits.startsWith('55') ? digits : `55${digits}`
  void Linking.openURL(`https://wa.me/${number}`)
}

function openMail(email: string) {
  void Linking.openURL(`mailto:${email}`)
}

function callPhone(phone: string) {
  void Linking.openURL(`tel:${phone.replace(/\D/g, '')}`)
}

/**
 * Número sozinho abre direto pelo tipo que a locadora definiu (WhatsApp ou
 * ligação). Com e-mail junto, pergunta qual canal usar.
 */
function openContact(contact: TenantContact) {
  const { phone, email } = contact
  const openPhone = phone
    ? () => (contact.phone_kind === 'whatsapp' ? openWhatsApp(phone) : callPhone(phone))
    : null

  if (openPhone && !email) return openPhone()
  if (email && !openPhone) return openMail(email)

  Alert.alert(contact.label, contactSummary(contact), [
    { text: contact.phone_kind === 'whatsapp' ? 'WhatsApp' : 'Ligar', onPress: openPhone! },
    { text: 'E-mail', onPress: () => openMail(email!) },
    { text: 'Cancelar', style: 'cancel' },
  ])
}

function contactSummary(contact: TenantContact): string {
  return [contact.phone ? applyPhoneMask(contact.phone) : null, contact.email].filter(Boolean).join(' · ')
}

function contactIcon(contact: TenantContact): { icon: IconName; tone: Tone } {
  if (!contact.phone) return { icon: 'mail-outline', tone: 'primary' }
  return contact.phone_kind === 'whatsapp'
    ? { icon: 'logo-whatsapp', tone: 'success' }
    : { icon: 'call-outline', tone: 'primary' }
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
  const { session, tenants, activeTenantId, signOut, selectTenant } = useAuth()
  const router = useRouter()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const { preference, setPreference } = useThemePreference()

  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null
  const appVersion = Constants.expoConfig?.version ?? '—'

  const [profile, setProfile] = useState<CustomerProfile>({ name: null, phone: null })
  const [tenantPickerOpen, setTenantPickerOpen] = useState(false)

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

  // As listas já trocam sozinhas (a queryKey leva a locadora); voltar ao Início
  // descarta o estado local da tela atual, como um Pix gerado na outra locadora.
  function handleSwitchTenant(tenant: TenantOption) {
    setTenantPickerOpen(false)
    if (tenant.id === activeTenantId) return
    void selectTenant(tenant.id).then(() => router.replace('/'))
  }

  function handleSignOut() {
    Alert.alert('Sair', 'Tem certeza que deseja encerrar a sessão?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: () => void signOut() },
    ])
  }

  // Só o que a locadora cadastrou em Configurações (tenant_contacts). Sem
  // contato cadastrado, a seção inteira some — o telefone/e-mail gerais da
  // empresa (tenants.contact_*) não são exibidos ao cliente.
  const contacts = useTenantContacts().data ?? []

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
              <Text style={styles.profileMeta} numberOfLines={1}>{activeTenant.name}</Text>
            ) : null}
          </View>
        </Card>

        {/* Locadora — só para quem é cliente de mais de uma */}
        {tenants.length > 1 ? (
          <View style={styles.section}>
            <SectionHeader title="Locadora" />
            <Card padded={false}>
              <ListItem
                icon="business-outline"
                label={activeTenant?.name ?? '—'}
                sublabel="Acessando agora"
              />
              <ListItem
                icon="swap-horizontal-outline"
                iconTone="neutral"
                label="Trocar de locadora"
                onPress={() => setTenantPickerOpen(true)}
                last
              />
            </Card>
          </View>
        ) : null}

        {/* Aparência */}
        <View style={styles.section}>
          <SectionHeader title="Aparência" />
          <SegmentedControl value={preference} options={THEME_OPTIONS} onChange={setPreference} />
        </View>

        {/* Fale com a locadora — só aparece se a locadora cadastrou contatos */}
        {contacts.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Fale com a locadora" />
            <Card padded={false}>
              {contacts.map((contact, index) => (
                <ListItem
                  key={contact.id}
                  icon={contactIcon(contact).icon}
                  iconTone={contactIcon(contact).tone}
                  label={contact.label}
                  sublabel={contactSummary(contact)}
                  caption={contact.business_hours ? `Atendimento: ${contact.business_hours}` : undefined}
                  onPress={() => openContact(contact)}
                  last={index === contacts.length - 1}
                />
              ))}
            </Card>
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

      <Modal
        visible={tenantPickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setTenantPickerOpen(false)}
      >
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <ModalHeader
            title="Escolha a locadora"
            subtitle="Com qual deseja continuar?"
            onClose={() => setTenantPickerOpen(false)}
          />
          <ScrollView contentContainerStyle={styles.content}>
            <Card padded={false}>
              {tenants.map((tenant, i) => {
                const active = tenant.id === activeTenantId
                const suspended = !!tenant.suspended_at
                return (
                  <ListItem
                    key={tenant.id}
                    icon="business-outline"
                    iconTone={active ? 'primary' : 'neutral'}
                    label={tenant.name}
                    sublabel={active ? 'Acessando agora' : suspended ? 'Temporariamente indisponível' : undefined}
                    trailing={
                      active ? (
                        <Icon name="checkmark-circle" size={20} color={theme.primary} />
                      ) : suspended ? (
                        <Badge label="Indisponível" size="sm" />
                      ) : undefined
                    }
                    onPress={active || suspended ? undefined : () => handleSwitchTenant(tenant)}
                    last={i === tenants.length - 1}
                  />
                )
              })}
            </Card>
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
})
