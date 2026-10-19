/**
 * Adaptador da InfinitePay — as partes puras (ADR 0032).
 *
 * A conversão de dinheiro é a mesma armadilha da Cora: eles falam centavos
 * inteiros, o GoMoto fala reais decimais, e o erro cobra cem vezes o devido sem
 * aparecer em teste com valor redondo.
 *
 * A normalização do handle é uma armadilha própria deste provedor: a InfiniteTag
 * aparece no app com `$` na frente e é EXATAMENTE assim que o operador vai
 * copiá-la. A API recusa o `$`, e a recusa chega como o mesmo 404 de "handle não
 * existe" — mandando o operador conferir a digitação de um handle correto.
 */

import { describe, it, expect } from 'vitest'
import {
  toCents,
  fromCents,
  normalizeHandle,
  isValidHandleFormat,
  toInfinitePayPhone,
  toInfinitePayAddress,
} from './api'

describe('toCents', () => {
  it('converte reais para centavos', () => {
    expect(toCents(350)).toBe(35000)
    expect(toCents(1)).toBe(100)
    expect(toCents(1234.56)).toBe(123456)
  })

  it('arredonda em vez de truncar', () => {
    // 350.1 * 100 dá 35009.999999999996 em ponto flutuante.
    expect(toCents(350.1)).toBe(35010)
    expect(toCents(29.29)).toBe(2929)
    expect(toCents(8.87)).toBe(887)
  })

  it('recusa valor que não vira cobrança', () => {
    expect(() => toCents(0)).toThrow()
    expect(() => toCents(-10)).toThrow()
  })
})

describe('fromCents', () => {
  it('volta para reais', () => {
    // O caminho de volta é o do webhook: `amount` vem em centavos e vira o
    // valor que o razão credita.
    expect(fromCents(35000)).toBe(350)
    expect(fromCents(1)).toBe(0.01)
    expect(fromCents(1510)).toBe(15.1)
  })
})

describe('normalizeHandle', () => {
  it('remove o cifrão com que a InfiniteTag aparece no app', () => {
    expect(normalizeHandle('$alan-goncalves-25')).toBe('alan-goncalves-25')
    expect(normalizeHandle('alan-goncalves-25')).toBe('alan-goncalves-25')
  })

  it('tolera espaço colado e caixa alta', () => {
    // Colar de um app costuma trazer espaço em volta; a InfiniteTag é
    // minúscula, e mandar 'Alan' recusaria uma conta que existe.
    expect(normalizeHandle('  $Alan-Goncalves-25 ')).toBe('alan-goncalves-25')
  })
})

describe('isValidHandleFormat', () => {
  it('aceita o que a InfinitePay usa', () => {
    expect(isValidHandleFormat('alan-goncalves-25')).toBe(true)
    expect(isValidHandleFormat('loja.do.joao')).toBe(true)
    expect(isValidHandleFormat('ab')).toBe(true)
  })

  it('recusa antes de gastar a rede', () => {
    expect(isValidHandleFormat('')).toBe(false)
    expect(isValidHandleFormat('a')).toBe(false)
    // O `$` já devia ter saído em `normalizeHandle`; chegar aqui com ele
    // significa que alguém pulou a normalização.
    expect(isValidHandleFormat('$alan')).toBe(false)
    expect(isValidHandleFormat('com espaço')).toBe(false)
    expect(isValidHandleFormat('acentuação')).toBe(false)
  })
})

describe('toInfinitePayPhone', () => {
  it('converte o telefone do cadastro para E.164', () => {
    // O formato com máscara é o que a tela de clientes grava.
    expect(toInfinitePayPhone('(11) 91000-0001')).toBe('+5511910000001')
    expect(toInfinitePayPhone('11910000001')).toBe('+5511910000001')
    expect(toInfinitePayPhone('(21) 3456-7890')).toBe('+552134567890')
  })

  it('não duplica o código do país nem o zero de longa distância', () => {
    expect(toInfinitePayPhone('+55 11 91000-0001')).toBe('+5511910000001')
    expect(toInfinitePayPhone('5511910000001')).toBe('+5511910000001')
    expect(toInfinitePayPhone('011 91000-0001')).toBe('+5511910000001')
  })

  it('omite o que não dá para ter certeza, em vez de arriscar a recusa do link', () => {
    // Uma recusa da API derruba a geração inteira do link: sem telefone, o
    // checkout só pergunta; com telefone errado, o cliente fica sem pagar.
    expect(toInfinitePayPhone(null)).toBeNull()
    expect(toInfinitePayPhone('')).toBeNull()
    expect(toInfinitePayPhone('91000-0001')).toBeNull()
    expect(toInfinitePayPhone('(11) 81000-0001')).toBeNull()
    expect(toInfinitePayPhone('(01) 91000-0001')).toBeNull()
    expect(toInfinitePayPhone('não tem')).toBeNull()
  })
})

describe('toInfinitePayAddress', () => {
  const completo = {
    zip_code: '01310-100',
    street: 'Av. Paulista',
    street_number: '1000',
    complement: 'Apto 12',
    neighborhood: 'Bela Vista',
  }

  it('usa os nomes de campo do checkout, com CEP só em dígitos', () => {
    expect(toInfinitePayAddress(completo)).toEqual({
      cep: '01310100',
      street: 'Av. Paulista',
      number: '1000',
      neighborhood: 'Bela Vista',
      complement: 'Apto 12',
    })
  })

  it('complemento é opcional', () => {
    expect(toInfinitePayAddress({ ...completo, complement: null })).not.toHaveProperty('complement')
    expect(toInfinitePayAddress({ ...completo, complement: '  ' })).not.toHaveProperty('complement')
  })

  it('endereço incompleto não vai, para não travar campo em branco no checkout', () => {
    expect(toInfinitePayAddress(null)).toBeNull()
    expect(toInfinitePayAddress({ ...completo, zip_code: '0131' })).toBeNull()
    expect(toInfinitePayAddress({ ...completo, street: null })).toBeNull()
    expect(toInfinitePayAddress({ ...completo, street_number: '' })).toBeNull()
    expect(toInfinitePayAddress({ ...completo, neighborhood: '   ' })).toBeNull()
  })
})
