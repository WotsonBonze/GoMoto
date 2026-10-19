/**
 * Cliente HTTP da InfinitePay — API de Checkout (ADR 0032).
 *
 * Dois endpoints, nenhum token:
 *
 *   POST /links          cria o link de checkout
 *   POST /payment_check  consulta se foi pago
 *
 * **A autenticação é o `handle`** — a InfiniteTag, um nome de usuário público
 * que viaja no CORPO da requisição. Não há header de autorização, chave nem
 * assinatura. Isso não é simplificação nossa: é a superfície que eles expõem.
 *
 * **Centavos moram aqui.** A InfinitePay trabalha com inteiros em centavos; o
 * resto do GoMoto fala reais decimais. A conversão acontece neste arquivo e
 * nenhum valor em centavos atravessa a fronteira.
 */

import { codedError } from '../../types'

/**
 * O handle não serve para cobrar.
 *
 * Cobre os dois motivos, que a API NÃO distingue — os dois voltam como 404
 * `external_checkout_not_enabled`:
 *
 *   1. a InfiniteTag não existe (digitação errada);
 *   2. existe, mas o comerciante não ligou o Checkout Externo no app.
 *
 * Por isso a mensagem precisa carregar as duas leituras e o link do painel que
 * eles próprios devolvem. Tratar como "handle inválido" mandaria o operador
 * conferir a digitação de um handle que está certo.
 */
export class InfinitePayHandleError extends Error {
  constructor(
    message: string,
    /** Painel onde se liga o Checkout Externo, quando a API o informa. */
    readonly panelUrl: string | null = null,
  ) {
    super(message)
    this.name = 'InfinitePayHandleError'
  }
}

function apiBase(): string {
  return (process.env.INFINITEPAY_API_BASE ?? 'https://api.checkout.infinitepay.io').replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

/** Reais decimais → centavos inteiros. `350.00` vira `35000`. */
export function toCents(amount: number): number {
  // `Math.round` e não `Math.trunc`: 350.1 * 100 dá 35009.999... em ponto
  // flutuante, e truncar cobraria um centavo a menos.
  const cents = Math.round(amount * 100)
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`Valor inválido para a InfinitePay: ${amount}`)
  }
  return cents
}

/** Centavos inteiros → reais decimais. `35000` vira `350`. */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/**
 * Formato da InfiniteTag, para recusar lixo antes de gastar a rede.
 *
 * O `$` é como ela aparece no app ("$alan-goncalves-25") e é justamente o que a
 * API NÃO aceita. Normalizar em vez de recusar: colar do app com o cifrão é o
 * erro mais provável do operador, e ele não é ambíguo.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^\$+/, '').toLowerCase()
}

export function isValidHandleFormat(handle: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(handle)
}

// ---------------------------------------------------------------------------
// Dados do cliente — pré-preenchimento do checkout
// ---------------------------------------------------------------------------

/**
 * Telefone do cadastro → E.164, o formato do exemplo deles (`+5511999887766`).
 *
 * EXCLUSIVO DA INFINITEPAY. `customers.phone` é texto livre ("(11) 91000-0001",
 * "11910000001", "+55 11 ..."), e os outros provedores nem recebem telefone.
 * A conversão mora aqui para que nenhum deles passe a depender dela.
 *
 * Devolve `null` quando não dá para ter certeza do número: não enviar só faz o
 * checkout pedir o telefone, enquanto um número que a API recuse derrubaria a
 * geração do link inteira — o cliente ficaria sem como pagar.
 */
export function toInfinitePayPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = raw.replace(/\D/g, '')
  // Prefixo de discagem de longa distância ("0 11 ...").
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length === 12 && digits.startsWith('0')) digits = digits.slice(1)
  // Já veio com o código do país.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2)

  // DDD (dois dígitos, sem zero) + 8 dígitos (fixo) ou 9 começando em 9 (celular).
  const ddd = digits.slice(0, 2)
  const numero = digits.slice(2)
  if (!/^[1-9][1-9]$/.test(ddd)) return null
  const fixo = numero.length === 8 && /^[2-5]/.test(numero)
  const celular = numero.length === 9 && numero.startsWith('9')
  if (!fixo && !celular) return null

  return `+55${ddd}${numero}`
}

type LinkAddress = {
  cep: string
  street: string
  number: string
  neighborhood: string
  complement?: string
}

/**
 * Endereço do cadastro → objeto `address` do checkout.
 *
 * EXCLUSIVO DA INFINITEPAY, pelo mesmo motivo do telefone. A API não tem campo
 * de cidade nem de estado: ela os deduz do CEP.
 *
 * Tudo ou nada nos campos que o checkout pede. Mandar o endereço pela metade
 * repete o problema do `name: null` (ver `createCheckoutLink`): a página abre
 * com o que faltou travado em branco. Incompleto, não vai — e o cliente
 * preenche lá, como hoje. Só o complemento é opcional.
 */
export function toInfinitePayAddress(address: {
  zip_code: string | null
  street: string | null
  street_number: string | null
  complement: string | null
  neighborhood: string | null
} | null | undefined): LinkAddress | null {
  if (!address) return null
  const cep = (address.zip_code ?? '').replace(/\D/g, '')
  const street = address.street?.trim()
  const number = address.street_number?.trim()
  const neighborhood = address.neighborhood?.trim()
  if (cep.length !== 8 || !street || !number || !neighborhood) return null

  const complement = address.complement?.trim()
  return { cep, street, number, neighborhood, ...(complement ? { complement } : {}) }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

type LinkItem = { quantity: number; price: number; description: string }

type CreateLinkBody = {
  handle: string
  items: LinkItem[]
  order_nsu?: string
  webhook_url?: string
  customer?: { name?: string; email?: string; phone_number?: string }
  address?: LinkAddress
}

/**
 * Cria o link e devolve a URL do checkout.
 *
 * **A resposta é `{"url": "..."}` e NADA MAIS.** Verificado ao vivo: sem slug,
 * sem id de fatura, sem nome do comerciante. É a razão de `provider_intent_id`
 * guardar o nosso `order_nsu` e não um identificador deles — o `invoice_slug`
 * só passa a existir quando o webhook chega, e amarrar o intent a um valor que
 * ainda não existe deixaria o pagamento sem dono.
 */
export async function createCheckoutLink(params: {
  handle: string
  amount: number
  orderNsu: string
  description: string
  webhookUrl?: string | null
  customer?: { name: string | null; email: string | null; phone?: string | null }
  address?: Parameters<typeof toInfinitePayAddress>[0]
}): Promise<{ url: string }> {
  const body: CreateLinkBody = {
    handle: params.handle,
    items: [{
      quantity: 1,
      price: toCents(params.amount),
      description: params.description,
    }],
    order_nsu: params.orderNsu,
  }

  if (params.webhookUrl) body.webhook_url = params.webhookUrl

  // Só o que temos. Mandar `name: null` faz a API tratar como preenchido e o
  // checkout abre com o campo travado em branco — pior do que não mandar.
  // Cada campo que chega aqui é uma pergunta a menos no checkout. O cliente já
  // se identificou pelo CPF no login e a cobrança aponta para o cadastro dele,
  // então não há o que perguntar de novo.
  const nome = params.customer?.name?.trim()
  const email = params.customer?.email?.trim()
  const phone = toInfinitePayPhone(params.customer?.phone)
  if (nome || email || phone) {
    body.customer = {
      ...(nome ? { name: nome } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone_number: phone } : {}),
    }
  }

  const address = toInfinitePayAddress(params.address)
  if (address) body.address = address

  const res = await fetch(`${apiBase()}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  const data = parseJson(text)

  if (!res.ok) throw linkError(res.status, data, text)

  const url = (data as { url?: unknown }).url
  if (typeof url !== 'string' || !url) {
    // 200 sem URL é resposta que não serve para nada. Falhar aqui evita gravar
    // uma tentativa pendente que ocupa o índice de "um pagamento ativo por
    // dívida" sem que o cliente tenha como pagar.
    throw codedError('INTERNAL', 'InfinitePay respondeu sem a URL do checkout')
  }

  return { url }
}

/**
 * Sonda o handle criando um link de verificação.
 *
 * É a ÚNICA prova disponível de que o handle cobra. `POST /payment_check` não
 * serve: verificado ao vivo, ele responde `200 {"success": false}` tanto para
 * pedido inexistente quanto para pedido real ainda não pago — não distingue
 * nada.
 *
 * O link fica na conta do comerciante, sem ser pago. É o custo de não gravar um
 * gateway que só falharia na primeira cobrança de verdade.
 */
export async function verifyHandle(handle: string): Promise<{ checkoutUrl: string }> {
  const { url } = await createCheckoutLink({
    handle,
    // O piso da API é R$ 1,00, então a sonda custa o piso.
    amount: 1,
    orderNsu: `gomoto-verificacao-${Date.now()}`,
    description: 'Verificação de conta Locaw',
  })
  return { checkoutUrl: url }
}

// ---------------------------------------------------------------------------

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function linkError(status: number, data: unknown, raw: string): Error {
  const d = (data ?? {}) as { error?: unknown; message?: unknown; redirect_url?: unknown; errors?: unknown }

  if (d.error === 'external_checkout_not_enabled' || status === 404) {
    return new InfinitePayHandleError(
      'A InfinitePay não reconheceu esta InfiniteTag para cobrar. '
      + 'Confira a digitação e verifique se o Checkout Externo está habilitado na sua conta.',
      typeof d.redirect_url === 'string' ? d.redirect_url : null,
    )
  }

  // 422 traz `errors.items` com a regra violada. O piso já é barrado antes, em
  // `getOrCreateIntent`, então chegar aqui significa regra que ainda não
  // conhecemos — e o texto cru vale mais que uma paráfrase nossa.
  const detalhe = typeof d.message === 'string' ? d.message : raw.slice(0, 200)
  return codedError('INTERNAL', `InfinitePay recusou a criação do link (${status}): ${detalhe}`)
}
