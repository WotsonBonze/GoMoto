import { View } from 'react-native'
import { useTheme } from '../../theme'
import { Icon, type IconName } from './Icon'
import { radius, toneColors, type Tone } from './tokens'

/** Ícone sobre um quadrado arredondado tingido — "avatar" de linha e de cartão. */
export function IconCircle({
  name,
  tone = 'primary',
  size = 40,
}: {
  name: IconName
  tone?: Tone
  size?: number
}) {
  const theme = useTheme()
  const { fg, bg } = toneColors(theme, tone)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size >= 40 ? radius.md : radius.sm,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={name} size={Math.round(size * 0.5)} color={fg} />
    </View>
  )
}
