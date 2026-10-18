/**
 * Geração da imagem do QR (ADR 0031 §4).
 *
 * A Cora devolve só o EMV. O app mostra imagem. Sem esta normalização, a
 * primeira cobrança pela Cora apareceria sem QR nenhum na tela do cliente.
 */

import { describe, it, expect } from 'vitest'
import { ensureQrImage } from './qr'

const EMV = '00020101021226830014br.gov.bcb.pix2561qrcode-h.cora.com.br/v1/cobv/abc5204000053039865802BR5912TESTE6009SAO PAULO62070503***6304F445'

describe('ensureQrImage', () => {
  it('gera a imagem a partir do emv quando o provedor não a devolve', async () => {
    const out = await ensureQrImage({ emv: EMV, qr_code: EMV })
    expect(typeof out.qr_code_base64).toBe('string')
    expect((out.qr_code_base64 as string).length).toBeGreaterThan(100)
    // PNG em base64 começa com o magic number iVBORw0KGgo
    expect(out.qr_code_base64 as string).toMatch(/^iVBORw0KGgo/)
  })

  it('não sobrescreve a imagem que o provedor já entregou', async () => {
    const out = await ensureQrImage({ emv: EMV, qr_code_base64: 'JA-VEIO-DO-PROVEDOR' })
    expect(out.qr_code_base64).toBe('JA-VEIO-DO-PROVEDOR')
  })

  it('cai para qr_code quando não há emv — o Mercado Pago nomeia assim', async () => {
    const out = await ensureQrImage({ qr_code: EMV })
    expect(out.qr_code_base64 as string).toMatch(/^iVBORw0KGgo/)
  })

  it('devolve o payload intacto quando não há código nenhum', async () => {
    const out = await ensureQrImage({ url: 'https://exemplo' })
    expect(out).toEqual({ url: 'https://exemplo' })
  })
})
