import type { ReactNode } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView } from 'react-native-safe-area-context'
import { LightThemeScope, useTheme } from '../theme'
import { Icon } from './ui'

/**
 * Moldura das telas de acesso (login, definir senha, escolher locadora):
 * faixa de marca azul-marinho com o logo e, por cima dela, a folha branca
 * do formulário.
 *
 * Sempre no tema claro — ver `LightThemeScope`.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <LightThemeScope>
      <AuthShellBody title={title} subtitle={subtitle}>{children}</AuthShellBody>
    </LightThemeScope>
  )
}

function AuthShellBody({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <View style={[styles.root, { backgroundColor: theme.brand }]}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.flex} edges={['top']}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* View, não ScrollView: no Android (Expo Go, adjustResize) o
              ScrollView com flexGrow fazia o teclado abrir e fechar na hora
              ao tocar no campo. */}
          <View style={styles.flex}>
            <View style={styles.brandArea}>
              <Image source={require('../../assets/icon.png')} style={styles.logo} />
              <Text style={[styles.brandName, { color: theme.brandText }]}>GoMoto</Text>
              <Text style={[styles.brandTagline, { color: theme.brandTextSoft }]}>
                Sua locação na palma da mão
              </Text>
            </View>

            <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
              <View style={styles.sheetInner}>
                <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
                {subtitle ? <Text style={[styles.subtitle, { color: theme.textSoft }]}>{subtitle}</Text> : null}
                <View style={styles.content}>{children}</View>
              </View>
              <View style={styles.secure}>
                <Icon name="shield-checkmark-outline" size={14} color={theme.textMute} />
                <Text style={[styles.secureText, { color: theme.textMute }]}>Conexão segura e criptografada</Text>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  brandArea: {
    alignItems: 'center',
    paddingTop: 40,
    paddingBottom: 36,
    gap: 6,
  },
  logo: {
    width: 68,
    height: 68,
    borderRadius: 20,
    marginBottom: 10,
  },
  brandName: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  brandTagline: { fontSize: 14 },
  sheet: {
    flex: 1,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 24,
    justifyContent: 'space-between',
    gap: 24,
  },
  sheetInner: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { fontSize: 15, lineHeight: 21, marginTop: 6 },
  content: { marginTop: 24, gap: 16 },
  secure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  secureText: { fontSize: 12 },
})
