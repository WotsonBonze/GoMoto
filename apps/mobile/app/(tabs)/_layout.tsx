import { Tabs } from 'expo-router'
import type { ColorValue } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { useStatusBarStyle, useTheme } from '../../src/theme'
import { Icon, type IconName } from '../../src/components/ui'

/** Contorno quando inativa, preenchido quando ativa — padrão iOS/Material 3. */
function tabIcon(outline: IconName, filled: IconName) {
  return ({ focused, color }: { focused: boolean; color: ColorValue }) => (
    <Icon name={focused ? filled : outline} size={24} color={color} />
  )
}

export default function TabsLayout() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  // As telas de acesso deixam a barra clara (fundo azul-marinho); aqui ela
  // volta a seguir o tema, senão os ícones somem no fundo claro.
  const statusBarStyle = useStatusBarStyle()
  return (
    <>
      <StatusBar style={statusBarStyle} />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: theme.primary,
          tabBarInactiveTintColor: theme.textMute,
          tabBarStyle: {
            backgroundColor: theme.surface,
            borderTopColor: theme.border,
            height: 60 + insets.bottom,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 8),
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginTop: 2 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: 'Início', tabBarIcon: tabIcon('home-outline', 'home') }}
        />
        <Tabs.Screen
          name="cobrancas"
          options={{ title: 'Cobranças', tabBarIcon: tabIcon('wallet-outline', 'wallet') }}
        />
        <Tabs.Screen
          name="manutencoes"
          options={{ title: 'Manutenção', tabBarIcon: tabIcon('construct-outline', 'construct') }}
        />
        <Tabs.Screen
          name="vistorias"
          options={{ title: 'Vistorias', tabBarIcon: tabIcon('camera-outline', 'camera') }}
        />
        <Tabs.Screen
          name="suporte"
          options={{ title: 'Conta', tabBarIcon: tabIcon('person-circle-outline', 'person-circle') }}
        />
      </Tabs>
    </>
  )
}
