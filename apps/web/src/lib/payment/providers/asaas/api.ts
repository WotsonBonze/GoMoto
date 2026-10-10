/**
 * Cliente HTTP do Asaas (ADR 0037).
 *
 * Autenticação por CHAVE DE API no header `access_token`, mais `User-Agent`
 * obrigatório. O prefixo da chave diz o ambiente — `$aact_prod_` ou
 * `$aact_hmlg_` — e a base URL sai dele: chave de um ambiente na URL do outro
 * responde 401 `invalid_environment`.
 *
 * Tudo aqui foi sondado contra o sandbox em 2026-10-09; os comentários dizem o
 * que a API respondeu, não o que a documentação promete.
 *
 * **A chave nunca aparece em log nem em mensagem de erro.** Erros carregam o
 * `code` e a `description` que o Asaas devolveu, e só.
 */

import { codedError } from '../../types'

export type AsaasEnvironment = 'production' | 'sandbox'

const BASES: Record<AsaasEnvironment, string> = {
  production: 'https://api.asaas.com/v3',
  sandbox: 'https://api-sandbox.asaas.com/v3',
}

const USER_AGENT = 'GoMoto/1.0'

/** A chave foi recusada: inválida, revogada, desabilitada por inatividade. */
export class AsaasAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsaasAuthError'
  }
}

/**
 * A chave serve, mas não para o GoMoto — mensagem pronta para o operador.
 *
 * Separada de `AsaasAuthError` porque o conselho é outro: aqui não é "reconecte",
 * é "crie outra chave", e a tela mostra o texto como veio.
 */
export class AsaasKeyRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsaasKeyRejectedError'
  }
}

/** Recusa de regra de negócio do Asaas (400), com o código dele. */
export class AsaasRequestError extends Error {
  constructor(readonly status: number, readonly asaasCode: string | null, description: string) {
    super(description)
    this.name = 'AsaasRequestError'
  }
}

// ---------------------------------------------------------------------------
// Ambiente
// ---------------------------------------------------------------------------

/** Ambiente pela forma da chave; `null` se não parece chave do Asaas. */
export function environmentOfKey(key: string): AsaasEnvironment | null {
  if (/^\$aact_prod_\S{20,}$/.test(key)) return 'production'
  if (/^\$aact_hmlg_\S{20,}$/.test(key)) return 'sandbox'
  return null
}

/**
 * Ambiente que ESTE deploy aceita.
 *
 * Produção só aceita chave de produção: uma chave de sandbox gravada num tenant
 * real geraria Pix que nenhum banco paga, e o erro só apareceria quando o
 * cliente tentasse pagar. Explícito por `ASAAS_ENVIRONMENT`; sem ele, o deploy
 * de produção da Vercel é produção e todo o resto é sandbox.
 */
export function acceptedEnvironment(): AsaasEnvironment {
  const explicit = process.env.ASAAS_ENVIRONMENT
  if (explicit === 'production' || explicit === 'sandbox') return explicit
  return process.env.VERCEL_ENV === 'production' ? 'production' : 'sandbox'
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

type Conn = { apiKey: string; environment: AsaasEnvironment }

type AsaasErrorBody = { errors?: { code?: unknown; description?: unknown }[] }

async function call<T>(
  conn: Conn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASES[conn.environment]}${path}`, {
    method,
    headers: {
      access_token: conn.apiKey,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (res.ok) return { status: res.status, data: data as T }

  const first = (data as AsaasErrorBody | null)?.errors?.[0]
  const code = typeof first?.code === 'string' ? first.code : null
  const description = typeof first?.description === 'string'
    ? first.description
    : `Asaas respondeu ${res.status}`

  if (res.status === 401) throw new AsaasAuthError(description)
  throw new AsaasRequestError(res.status, code, description)
}

// ---------------------------------------------------------------------------
// Conta
// ---------------------------------------------------------------------------

export type AsaasAccount = {
  walletId: string
  /** Nome (ou razão social) + documento mascarado — o que a tela mostra. */
  label: string
  /** E-mail da conta. Só usado como destino de alerta do webhook; não é gravado. */
  email: string | null
}

/**
 * Identidade da conta dona da chave.
 *
 * `walletId` é a identidade estável (uma carteira por conta). O resto de
 * `commercialInfo` — e-mail, telefone, endereço, data de nascimento — é dado
 * pessoal de quem abriu a conta e não sai daqui.
 */
export async function fetchAccount(conn: Conn): Promise<AsaasAccount> {
  const { data: wallets } = await call<{ data?: { id?: unknown }[] }>(conn, 'GET', '/wallets/')
  const walletId = wallets?.data?.[0]?.id
  if (typeof walletId !== 'string' || !walletId) {
    throw codedError('INTERNAL', 'O Asaas não informou a carteira desta conta')
  }

  const { data: info } = await call<{ name?: unknown; companyName?: unknown; cpfCnpj?: unknown; email?: unknown }>(
    conn, 'GET', '/myAccount/commercialInfo/',
  )
  const nome = [info?.companyName, info?.name].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  const doc = typeof info?.cpfCnpj === 'string' ? maskDocument(info.cpfCnpj) : null

  return {
    walletId,
    label: [nome?.trim(), doc].filter(Boolean).join(' · ') || walletId,
    email: typeof info?.email === 'string' && info.email ? info.email : null,
  }
}

/**
 * A chave tem permissão de saque/transferência?
 *
 * Verificado nos dois sentidos: `GET /transfers` responde 403
 * `insufficient_permission` ("…operações de saque via API") com a chave
 * padrão, e 200 com uma chave que tem saque habilitado. É uma LEITURA — a sonda
 * não move dinheiro.
 *
 * Qualquer outra resposta é "não sei", e "não sei" não autoriza gravar: o
 * GoMoto só guarda chave que provadamente NÃO tira dinheiro da conta.
 */
export async function keyCanWithdraw(conn: Conn): Promise<boolean> {
  try {
    await call(conn, 'GET', '/transfers?limit=1')
    return true
  } catch (err) {
    if (err instanceof AsaasRequestError && err.status === 403 && err.asaasCode === 'insufficient_permission') {
      return false
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** Eventos que o processamento lê (ADR 0037, decisão 4). */
export const WEBHOOK_EVENTS = [
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_DELETED',
  'ACCESS_TOKEN_DISABLED',
  'ACCESS_TOKEN_EXPIRING_SOON',
  'ACCESS_TOKEN_EXPIRED',
] as const

/**
 * Regras do Asaas para o `authToken`, sondadas: 32–255 caracteres, sem
 * espaço, e no máximo 4 caracteres iguais seguidos ("O token não pode conter
 * mais de 4 caracteres iguais consecutivos").
 */
export function isAcceptableWebhookToken(token: string): boolean {
  return token.length >= 32 && token.length <= 255 && !/\s/.test(token) && !/(.)\1{4}/.test(token)
}

function webhookConfig(): { url: string; authToken: string } {
  const url = process.env.ASAAS_WEBHOOK_URL
  const authToken = process.env.ASAAS_WEBHOOK_TOKEN
  // Sem webhook a conexão FALHA. Conta que gera Pix sem retorno é dinheiro que
  // entra na conta da locadora com a cobrança aberta para sempre.
  if (!url || !authToken) {
    throw codedError(
      'INTERNAL',
      'ASAAS_WEBHOOK_URL/ASAAS_WEBHOOK_TOKEN não configurados — sem eles o pagamento nunca seria confirmado.',
    )
  }
  if (!isAcceptableWebhookToken(authToken)) {
    throw codedError('INTERNAL', 'ASAAS_WEBHOOK_TOKEN não atende às regras do Asaas (32–255 caracteres, sem repetições longas)')
  }
  return { url, authToken }
}

/**
 * Garante o webhook do GoMoto na conta e devolve o id.
 *
 * O Asaas RECUSA um segundo webhook com a mesma URL e os mesmos eventos ("Já
 * existe uma configuração para os eventos com os mesmos atributos") — o que
 * acontece em toda reconexão e quando a mesma conta está em mais de um tenant.
 * Nesse caso o nosso é localizado pela URL e atualizado, o que também reativa
 * uma fila que tenha sido interrompida.
 *
 * `SEQUENTIALLY`: a ordem importa — estorno processado antes da confirmação
 * viraria no-op e a confirmação creditaria depois.
 *
 * `email` é OBRIGATÓRIO (a doc não marca; a API responde "O parâmetro email
 * deve ser informado"). É para lá que o Asaas avisa falhas de entrega e fila
 * pausada. `ASAAS_WEBHOOK_EMAIL` aponta para a operação do GoMoto — quem pode
 * consertar o endpoint —; sem ela, vai para o e-mail da própria conta.
 */
export async function ensureWebhook(conn: Conn, accountEmail: string | null): Promise<string> {
  const { url, authToken } = webhookConfig()
  const email = process.env.ASAAS_WEBHOOK_EMAIL || accountEmail
  if (!email) throw codedError('INTERNAL', 'Sem e-mail para os alertas do webhook do Asaas (ASAAS_WEBHOOK_EMAIL)')
  const config = {
    name: 'GoMoto',
    url,
    email,
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken,
    sendType: 'SEQUENTIALLY',
    events: [...WEBHOOK_EVENTS],
  }

  const existing = await findWebhookByUrl(conn, url)
  if (existing) {
    await call(conn, 'PUT', `/webhooks/${existing}`, config)
    return existing
  }

  const { data } = await call<{ id?: unknown }>(conn, 'POST', '/webhooks', config)
  if (typeof data?.id !== 'string') throw codedError('INTERNAL', 'O Asaas não devolveu o id do webhook')
  return data.id
}

async function findWebhookByUrl(conn: Conn, url: string): Promise<string | null> {
  const { data } = await call<{ data?: { id?: unknown; url?: unknown }[] }>(conn, 'GET', '/webhooks?limit=100')
  const found = data?.data?.find((w) => w.url === url && typeof w.id === 'string')
  return (found?.id as string | undefined) ?? null
}

export async function deleteWebhook(conn: Conn, webhookId: string): Promise<void> {
  await call(conn, 'DELETE', `/webhooks/${encodeURIComponent(webhookId)}`)
}

// ---------------------------------------------------------------------------
// Cobrança
// ---------------------------------------------------------------------------

/**
 * Pagador da cobrança, reaproveitado pelo documento.
 *
 * O Asaas ACEITA dois clientes com o mesmo CPF (verificado: `cus_…980` e
 * `cus_…981`), então criar sem procurar duplicaria o cadastro a cada Pix. A
 * busca não devolve removidos.
 *
 * `notificationDisabled: true` — sem isso o Asaas manda e-mail/SMS de cobrança
 * ao locatário por conta própria, em paralelo ao GoMoto, e pode tarifar a
 * locadora. Cliente que JÁ existia é da locadora e não é alterado.
 */
export async function findOrCreateCustomer(
  conn: Conn,
  customer: { name: string; document: string; email: string | null },
): Promise<string> {
  const doc = customer.document.replace(/\D/g, '')
  const { data: found } = await call<{ data?: { id?: unknown }[] }>(
    conn, 'GET', `/customers?cpfCnpj=${doc}&limit=1`,
  )
  const id = found?.data?.[0]?.id
  if (typeof id === 'string' && id) return id

  const { data: created } = await call<{ id?: unknown }>(conn, 'POST', '/customers', {
    name: customer.name,
    cpfCnpj: doc,
    ...(customer.email ? { email: customer.email } : {}),
    notificationDisabled: true,
  })
  if (typeof created?.id !== 'string') throw codedError('INTERNAL', 'O Asaas não devolveu o id do cliente')
  return created.id
}

export type PixChargeInput = {
  customerId: string
  value: number
  dueDate: string
  fine: { kind: 'percent' | 'fixed'; value: number } | null
  monthlyInterestPercent: number | null
  externalReference: string
  description: string
}

/**
 * Cria a cobrança Pix com vencimento (`cobv`) e devolve o código.
 *
 * Multa e juros vão DENTRO da cobrança: quem os calcula é o banco do pagador,
 * no dia em que paga (verificado: R$ 100, 2% + 1%/mês, 1 dia → o pagador vê
 * 102,03). O QR vale até 12 meses depois do vencimento, então não há
 * `expiresAt` a gravar.
 */
export async function createPixCharge(conn: Conn, input: PixChargeInput): Promise<{
  id: string
  invoiceUrl: string | null
  emv: string
  qrImageBase64: string | null
}> {
  const { data: payment } = await call<{ id?: unknown; invoiceUrl?: unknown }>(conn, 'POST', '/payments', {
    customer: input.customerId,
    billingType: 'PIX',
    value: input.value,
    dueDate: input.dueDate,
    externalReference: input.externalReference,
    description: input.description,
    ...(input.fine
      ? { fine: { value: input.fine.value, type: input.fine.kind === 'percent' ? 'PERCENTAGE' : 'FIXED' } }
      : {}),
    ...(input.monthlyInterestPercent ? { interest: { value: input.monthlyInterestPercent } } : {}),
  })

  if (typeof payment?.id !== 'string') throw codedError('INTERNAL', 'O Asaas não devolveu o id da cobrança')

  const { data: qr } = await call<{ payload?: unknown; encodedImage?: unknown }>(
    conn, 'GET', `/payments/${payment.id}/pixQrCode`,
  )
  if (typeof qr?.payload !== 'string' || !qr.payload) {
    // Cobrança sem código Pix é cobrança que o cliente não paga. Apaga em vez de
    // deixar órfã, e falha antes de ocupar o índice de "um código por dívida".
    await call(conn, 'DELETE', `/payments/${payment.id}`).catch(() => undefined)
    throw codedError('INTERNAL', `O Asaas criou a cobrança ${payment.id} sem código Pix`)
  }

  return {
    id: payment.id,
    invoiceUrl: typeof payment.invoiceUrl === 'string' ? payment.invoiceUrl : null,
    emv: qr.payload,
    qrImageBase64: typeof qr.encodedImage === 'string' && qr.encodedImage ? qr.encodedImage : null,
  }
}

/**
 * Remove a cobrança — o QR deixa de ser pagável pelo Asaas.
 *
 * Verificado: repetir dá 200 (idempotente). Cobrança já paga responde 400
 * `invalid_action` ("Só é possível remover cobranças pendentes ou vencidas") e
 * isso SOBE: não foi cancelada, e o dinheiro chega pela confirmação (ADR 0033).
 */
export async function deleteCharge(conn: Conn, paymentId: string): Promise<void> {
  await call(conn, 'DELETE', `/payments/${encodeURIComponent(paymentId)}`)
}

// ---------------------------------------------------------------------------

/** `15160686703` → `***.606.867-**`; CNPJ mantém só os 4 dígitos da filial. */
export function maskDocument(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
  if (d.length === 14) return `**.***.***/${d.slice(8, 12)}-**`
  return '***'
}
