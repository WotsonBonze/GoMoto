import { useEffect } from 'react'
import { StyleSheet, useColorScheme } from 'react-native'
import * as SplashScreen from 'expo-splash-screen'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

/**
 * Espelho do plugin `expo-splash-screen` em app.config.ts — o primeiro quadro
 * desta tela precisa ser idêntico à splash nativa para a troca não aparecer.
 * A nativa segue o tema do SO (não a preferência salva no app), por isso
 * useColorScheme e não useTheme.
 */
const SPLASH_BG = { light: '#F8FAFC', dark: '#0B1120' } as const
const LOGO_SIZE = 200

interface AnimatedSplashProps {
  /** Quando vira true, a logo encerra o pulso e sai (cresce e some). */
  ready: boolean
  /** Chamado ao fim da animação de saída — o pai desmonta o overlay. */
  onFinish: () => void
}

/**
 * Continuação animada da splash nativa: assume a tela no primeiro layout,
 * esconde a nativa, pulsa a logo enquanto o app carrega (sessão etc.) e sai
 * quando `ready`. Requer `SplashScreen.preventAutoHideAsync()` no módulo raiz.
 */
export function AnimatedSplash({ ready, onFinish }: AnimatedSplashProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light'
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.06, { duration: 700, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    )
    return () => cancelAnimation(scale)
  }, [scale])

  useEffect(() => {
    if (!ready) return
    cancelAnimation(scale)
    scale.value = withTiming(1.8, { duration: 500, easing: Easing.in(Easing.cubic) })
    opacity.value = withTiming(
      0,
      { duration: 500, easing: Easing.in(Easing.quad) },
      (finished) => {
        if (finished) scheduleOnRN(onFinish)
      },
    )
  }, [ready, scale, opacity, onFinish])

  const containerStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))
  const logoStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.container, { backgroundColor: SPLASH_BG[scheme] }, containerStyle]}
      onLayout={() => {
        void SplashScreen.hideAsync()
      }}
    >
      <Animated.Image
        source={require('../../assets/splash-icon.png')}
        style={[styles.logo, logoStyle]}
        resizeMode="contain"
      />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
})
