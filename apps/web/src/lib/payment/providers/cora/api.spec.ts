/**
 * Conversão de dinheiro da Cora (ADR 0031 §3).
 *
 * A Cora fala centavos inteiros; o resto do GoMoto fala reais decimais. Errar a
 * conversão cobra cem vezes o devido, e o defeito passaria despercebido em
 * teste com valor redondo — R$ 100,00 e 10000 centavos "parecem" certos em
 * qualquer direção que se olhe. Por isso os casos aqui têm centavos quebrados.
 */

import { describe, it, expect } from 'vitest'
import { toCents, fromCents } from './api'

describe('toCents', () => {
  it('converte reais para centavos', () => {
    expect(toCents(350)).toBe(35000)
    expect(toCents(0.01)).toBe(1)
    expect(toCents(1234.56)).toBe(123456)
  })

  it('arredonda em vez de truncar', () => {
    // 350.1 * 100 dá 35009.999999999996 em ponto flutuante. Truncar cobraria um
    // centavo a menos — e um centavo a menos em toda cobrança de uma frota é
    // uma diferença que ninguém consegue explicar no fechamento.
    expect(toCents(350.1)).toBe(35010)
    expect(toCents(0.07)).toBe(7)
    expect(toCents(29.29)).toBe(2929)
    expect(toCents(8.87)).toBe(887)
  })

  it('é exato para todo valor de duas casas', () => {
    // O valor sempre chega de `calculateAmountDue`, que soma colunas
    // NUMERIC(14,2): duas casas, sempre. Este é o domínio real de entrada, e
    // dentro dele `Math.round(v * 100)` não erra.
    //
    // (Fora dele erra: `toCents(1.005)` dá 100, não 101, porque 1.005 em IEEE
    // 754 é 1.00499999999999989. Não é um caso que o sistema produz — nenhum
    // valor de três casas sai do banco — e "consertar" isso com aritmética de
    // string trocaria um problema inexistente por um código mais frágil.)
    for (let cents = 1; cents <= 20000; cents++) {
      expect(toCents(cents / 100)).toBe(cents)
    }
  })

  it('recusa valor que não vira cobrança', () => {
    expect(() => toCents(0)).toThrow(/inválido/i)
    expect(() => toCents(-10)).toThrow(/inválido/i)
    expect(() => toCents(Number.NaN)).toThrow(/inválido/i)
  })
})

describe('fromCents', () => {
  it('converte centavos para reais', () => {
    expect(fromCents(35000)).toBe(350)
    expect(fromCents(1)).toBe(0.01)
    expect(fromCents(123456)).toBe(1234.56)
  })
})

describe('ida e volta', () => {
  it('preserva o valor', () => {
    for (const v of [0.01, 0.99, 1, 37.5, 350.1, 1234.56, 9999.99]) {
      expect(fromCents(toCents(v))).toBe(v)
    }
  })
})
