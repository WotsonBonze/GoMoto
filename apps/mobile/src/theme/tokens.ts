/**
 * Tokens de tema do app do cliente (Expo) — identidade v2 (ADR 0040).
 *
 * Direção: "banco digital" — neutros frios de alto contraste, um azul royal
 * profundo como cor de ação, e uma superfície de marca (`brand`) reservada
 * para o que é mais importante na tela (resumo financeiro, veículo): azul
 * claro no tema claro, azul-marinho no escuro.
 * Status com saturação contida: comunicam sem gritar.
 *
 * O azul continua da família "Frota Confiável" do cockpit web (ADR 0019/0021):
 * mesma marca, só que mais denso. Nada aqui afeta o web.
 *
 * pending/critical seguem a ADR 0020: critical é igual em claro/escuro por
 * definição (alarme raro, não deve variar).
 */
export interface ThemeTokens {
  bg: string
  surface: string
  surfaceAlt: string
  border: string
  text: string
  textSoft: string
  textMute: string
  primary: string
  primaryPressed: string
  primaryContrast: string
  primaryTint: string
  success: string
  successBg: string
  warning: string
  warningBg: string
  danger: string
  dangerBg: string
  info: string
  infoBg: string
  pending: string
  pendingBg: string
  critical: string
  criticalBg: string
  /** Marcador de categoria (ex.: tipo de cobrança avulsa) — não é status. */
  indigo: string
  indigoBg: string
  /** Marcador de categoria (ex.: cobrança complementar) — não é status. */
  violet: string
  violetBg: string
  /**
   * Superfície de marca: cartões de destaque, o "cartão" do app. Segue o tema
   * (azul claro no claro, azul-marinho no escuro) — um cartão escuro no tema
   * claro parecia "tema errado".
   */
  brand: string
  /** Borda/realce sobre `brand`. */
  brandBorder: string
  brandText: string
  brandTextSoft: string
  /** Acento legível sobre `brand` (links, ícones). */
  brandAccent: string
  /** Status sobre `brand`: os tons comuns perdem contraste no azul-marinho. */
  brandPositive: string
  brandNegative: string
  /** Bandeja de dados dentro de `brand` (ex.: valor/início/término do veículo). */
  brandInset: string
  /** Botão de ação sobre `brand` (variante `onBrand` do Button). */
  brandButton: string
  brandButtonText: string
  /** Sombra dos cartões. No escuro a profundidade vem da borda, não da sombra. */
  shadowColor: string
  shadowOpacity: number
}

export const lightTheme: ThemeTokens = {
  bg: '#F3F5F9', surface: '#FFFFFF', surfaceAlt: '#EDF0F5', border: '#E1E6EE',
  text: '#0C1424', textSoft: '#4A5468', textMute: '#8590A3',
  primary: '#2251D1', primaryPressed: '#1B42AE', primaryContrast: '#FFFFFF', primaryTint: '#ECF1FE',
  success: '#0C8A5B', successBg: '#E3F5EC',
  warning: '#C2620A', warningBg: '#FEF1E2',
  danger: '#CF3329', dangerBg: '#FDEBEA',
  info: '#0B72B0', infoBg: '#E4F2FA',
  pending: '#A67700', pendingBg: '#FDF5DA',
  critical: '#B91C1C', criticalBg: '#FECACA',
  indigo: '#4B49D6', indigoBg: '#ECECFD',
  violet: '#8A3FD1', violetBg: '#F4ECFD',
  brand: '#E3EBFD', brandBorder: '#CCDAFA', brandText: '#0C1424', brandTextSoft: '#4A5878', brandAccent: '#2251D1',
  brandPositive: '#0C8A5B', brandNegative: '#CF3329',
  brandInset: '#FFFFFF', brandButton: '#2251D1', brandButtonText: '#FFFFFF',
  shadowColor: '#0C1424', shadowOpacity: 0.06,
}

export const darkTheme: ThemeTokens = {
  bg: '#080C15', surface: '#101624', surfaceAlt: '#171F31', border: '#222B3F',
  text: '#EEF2F8', textSoft: '#A2ADC1', textMute: '#69748A',
  primary: '#4D76F5', primaryPressed: '#6B8EF8', primaryContrast: '#FFFFFF', primaryTint: 'rgba(77,118,245,0.16)',
  success: '#2EBD85', successBg: 'rgba(46,189,133,0.14)',
  warning: '#F0973A', warningBg: 'rgba(240,151,58,0.14)',
  danger: '#F2594F', dangerBg: 'rgba(242,89,79,0.14)',
  info: '#45AEE8', infoBg: 'rgba(69,174,232,0.14)',
  pending: '#E3B328', pendingBg: 'rgba(227,179,40,0.14)',
  critical: '#FF3B30', criticalBg: 'rgba(255,59,48,0.16)',
  indigo: '#9B9BFF', indigoBg: 'rgba(155,155,255,0.14)',
  violet: '#D08BF5', violetBg: 'rgba(208,139,245,0.14)',
  brand: '#14213F', brandBorder: '#26375F', brandText: '#FFFFFF', brandTextSoft: 'rgba(255,255,255,0.64)', brandAccent: '#9CB6FF',
  brandPositive: '#4ADE9B', brandNegative: '#FF8077',
  brandInset: 'rgba(255,255,255,0.06)', brandButton: '#FFFFFF', brandButtonText: '#14213F',
  shadowColor: '#000000', shadowOpacity: 0,
}
