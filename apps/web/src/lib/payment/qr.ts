/**
 * Imagem do QR Pix a partir do EMV (ADR 0031 §4).
 *
 * O app do cliente mostra o QR como imagem. O Mercado Pago devolve o PNG
 * pronto; a Cora devolve apenas `pix.emv`, o código copia-e-cola.
 *
 * A alternativa era ensinar o app a desenhar o QR — `react-native-svg` mais
 * `react-native-qrcode-svg`. Duas dependências nativas a mais no Expo, cujo
 * acoplamento com a versão do SDK já derrubou este app antes, para resolver um
 * problema que é do servidor: normalizar o que provedores diferentes devolvem.
 *
 * Aqui a geração acontece UMA vez, na criação da tentativa, e fica gravada em
 * `payment_intents.payload` — não é recalculada a cada abertura da tela.
 */

import QRCode from 'qrcode'

/** Nível M: tolera ~15% de dano e mantém o código legível na tela de um celular. */
const OPTIONS = { errorCorrectionLevel: 'M' as const, margin: 1, width: 320 }

/**
 * Devolve o payload com `qr_code_base64` garantido quando há um EMV.
 *
 * Não sobrescreve o que o provedor já entregou: se o Mercado Pago mandou a
 * imagem dele, é a dele que vale.
 */
export async function ensureQrImage(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof payload.qr_code_base64 === 'string' && payload.qr_code_base64) return payload

  const emv = typeof payload.emv === 'string' && payload.emv
    ? payload.emv
    : typeof payload.qr_code === 'string' ? payload.qr_code : ''

  if (!emv) return payload

  try {
    const dataUrl = await QRCode.toDataURL(emv, OPTIONS)
    return { ...payload, qr_code_base64: dataUrl.replace(/^data:image\/png;base64,/, '') }
  } catch (err) {
    // Sem imagem o cliente ainda paga pelo copia-e-cola. Derrubar a cobrança
    // inteira por causa do desenho seria trocar um incômodo por uma falha.
    console.error('[qr] falha ao gerar imagem do EMV:', err)
    return payload
  }
}
