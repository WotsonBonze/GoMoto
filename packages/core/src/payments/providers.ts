/**
 * Catálogo de gateways de pagamento (ADR 0030).
 *
 * Isto é a metade PURA do contrato de provedor: o que a tela precisa saber para
 * se desenhar, o que a validação precisa saber para recusar entrada, e o que o
 * app mobile precisa saber para pedir o método certo. Sem I/O, então serve os
 * três sem arrastar `fetch` para lugar nenhum.
 *
 * A outra metade — `connect`, `refresh`, `createIntent` — faz I/O e vive em
 * `apps/web/src/lib/payment`. Separar não é cerimônia: é o que permite a tela
 * listar "Cora — conexão por certificado, ainda não conectado" sem que o bundle
 * do cliente carregue o cliente HTTP do Cora.
 *
 * Somar um gateway começa aqui: uma entrada no catálogo. O banco não precisa
 * mudar — `payment_provider_accounts.provider` é texto com CHECK de formato,
 * não lista fechada.
 */

import { z } from 'zod'

/**
 * Meio de pagamento que um gateway sabe GERAR.
 *
 * Distinto de `PaymentMethod` (em `rules/rentals`), que é como o dinheiro
 * chegou — e inclui `cash`, `credit`, `deposit_retention`, coisas que nenhum
 * gateway emite. São conceitos diferentes e os nomes precisam dizer isso.
 *
 * Espelha o CHECK de `payment_intents.method`. Antes disto, `method` era string
 * livre: a rota aceitava `boleto`, o provedor ignorava e gerava PIX, e a
 * confirmação gravava `pix` no razão. Três pontos concordando em silêncio sobre
 * uma coisa que ninguém tinha pedido.
 */
export const GatewayMethodSchema = z.enum(['pix', 'boleto', 'credit_card', 'payment_link'])
export type GatewayMethod = z.infer<typeof GatewayMethodSchema>

/**
 * Como o tenant entrega a credencial ao GoMoto.
 *
 * - `oauth` — redireciona, autoriza, volta com código (Mercado Pago, Cora).
 * - `api_key` — cola uma chave num formulário (Asaas, Pagar.me).
 * - `certificate` — chave + certificado mTLS.
 * - `handle` — cola um NOME DE USUÁRIO PÚBLICO (InfinitePay).
 *
 * `handle` não é `api_key` com outro nome, e a distinção é de segurança, não de
 * vocabulário. Uma chave é segredo: quem a tem, age pela conta. Um handle é a
 * InfiniteTag — qualquer pessoa pode criar links para qualquer comerciante que
 * tenha o checkout externo ligado. Nada na API prova posse.
 *
 * A consequência prática é que o risco muda de lado: não é vazamento, é
 * DIGITAÇÃO. Handle errado manda o aluguel para a conta de um estranho, em
 * silêncio e para sempre. Por isso a tela deste modo confirma antes de gravar,
 * em vez de só mascarar o campo como faria com uma chave (ADR 0032).
 *
 * O ramo de cada modo entra junto com o provedor que o usa, não antes:
 * formulário sem provedor por trás é a mesma tela que aceita e descarta que a
 * ADR 0030 foi escrita para corrigir. `api_key` nasce com o Asaas (ADR 0037);
 * `certificate` segue sem implementação, de propósito.
 */
export const ProviderConnectionModeSchema = z.enum(['oauth', 'api_key', 'certificate', 'handle'])
export type ProviderConnectionMode = z.infer<typeof ProviderConnectionModeSchema>

export type PaymentProviderDescriptor = {
  /** Slug estável. É o que fica gravado em `payment_provider_accounts.provider`. */
  id: string
  /** Nome que o usuário lê. */
  label: string
  /** Uma linha explicando o que o tenant ganha ao conectar. */
  description: string
  connectionMode: ProviderConnectionMode
  /** Meios que ESTE provedor sabe gerar. Validado antes de criar a tentativa. */
  methods: GatewayMethod[]
  /**
   * Menor valor que este gateway aceita cobrar, em REAIS.
   *
   * Existe porque a recusa vem tarde e feia: a Cora responde 400 com
   * `services[0].amount must be greater than or equal to 500` (centavos), e sem
   * este campo isso virava "Não foi possível gerar o Pix. Tente novamente." —
   * conselho que nunca ia funcionar, porque o valor da cobrança não muda por
   * tentar de novo.
   *
   * Conferido contra a API de cada provedor, não estimado.
   */
  minAmount: number
  /**
   * `false` enquanto a implementação não existe. A tela mostra o provedor como
   * "em breve" em vez de escondê-lo: o tenant vê para onde a integração vai, e
   * ninguém clica num botão que não faz nada.
   */
  available: boolean
  /**
   * O código de pagamento carrega multa e juros e o banco do PAGADOR os
   * calcula na hora de pagar (Pix com vencimento, ADR 0037).
   *
   * Muda duas coisas: a emissão manda os termos de `embeddedLateChargeTerms`
   * em vez de um valor congelado, e uma tentativa pendente pode ser
   * reaproveitada de um dia para o outro — o próprio código soma os dias.
   * Nos demais, o valor é congelado na geração e reaproveitar depois de o
   * encargo crescer entrega um código que quita a dívida a menor (ADR 0038, P1).
   */
  accruesLateChargesNatively?: boolean
}

/**
 * Formato do slug, igual ao CHECK do banco
 * (`payment_provider_accounts_provider_slug`).
 */
export const ProviderIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,31}$/, 'Identificador de provedor inválido')

export const PAYMENT_PROVIDERS: PaymentProviderDescriptor[] = [
  {
    id: 'mercadopago',
    label: 'Mercado Pago',
    description: 'Cobrança Pix com QR code no app do cliente. Conexão pela sua conta Mercado Pago.',
    connectionMode: 'oauth',
    methods: ['pix'],
    // O Pix do Mercado Pago aceita a partir de um centavo.
    minAmount: 0.01,
    available: true,
  },
  {
    id: 'cora',
    label: 'Cora',
    description: 'Conta PJ com Pix e boleto. Você autoriza o Locaw entrando na sua conta Cora.',
    // Modalidade PARCERIA: OAuth2 authorization_code, sem certificado. O mTLS
    // da Cora é da "Integração Direta", modalidade em que a empresa gerencia a
    // própria conta — não é a nossa. Isto foi corrigido depois de ler a doc:
    // o ADR 0030 tinha registrado 'certificate' por suposição.
    connectionMode: 'oauth',
    methods: ['pix'],
    // R$ 5,00 — o número veio da própria API, em produção:
    // `services[0].amount must be greater than or equal to 500`.
    minAmount: 5,
    available: true,
  },
  {
    id: 'infinitepay',
    label: 'InfinitePay',
    description: 'Link de checkout com Pix e cartão em até 12x. Você informa a sua InfiniteTag.',
    // Sem OAuth, sem chave, sem assinatura: a credencial é a InfiniteTag, que é
    // pública. Ver o comentário de `ProviderConnectionModeSchema`.
    connectionMode: 'handle',
    // O ÚNICO provedor que não entrega um código de pagamento: entrega uma URL
    // e é o cliente quem escolhe Pix ou cartão, na página deles. Declarar `pix`
    // aqui seria mentir sobre o que o GoMoto controla — e faria a tela desenhar
    // um QR que não existe.
    methods: ['payment_link'],
    // R$ 1,00 — sondado contra a API, não estimado. A recusa vem como 422
    // `Total price must be greater than 1`: o número está em REAIS numa
    // mensagem sobre um campo que é em CENTAVOS, então ela se lê como "mais que
    // um centavo" e manda o leitor para o lugar errado. Conferido: 50 e 99 são
    // recusados, 100 passa — e "greater than" na verdade é "a partir de".
    minAmount: 1,
    available: true,
  },
  {
    id: 'asaas',
    label: 'Asaas',
    description: 'Pix com multa e juros calculados no pagamento, mesmo se o cliente pagar depois. Conexão por chave de API.',
    // Chave colada pelo tenant. Só é aceita chave SEM permissão de saque — a
    // conexão sonda e recusa a que tiver (ADR 0037, decisão 1).
    connectionMode: 'api_key',
    methods: ['pix'],
    // Sondado no sandbox: 4,99 é recusado com "não pode ser menor que R$ 5,00".
    minAmount: 5,
    // A conexão falha com mensagem nomeada se o deploy não tiver
    // ASAAS_WEBHOOK_URL/TOKEN: nunca fica conectado sem retorno de pagamento.
    available: true,
    accruesLateChargesNatively: true,
  },
]

export function findPaymentProvider(id: string): PaymentProviderDescriptor | null {
  return PAYMENT_PROVIDERS.find((p) => p.id === id) ?? null
}

/**
 * Descritor de um provedor que já pode ser conectado.
 *
 * Separado de `findPaymentProvider` de propósito: a tela precisa listar o que
 * ainda não está pronto, mas nenhuma escrita pode aceitar um provedor sem
 * implementação por trás.
 */
export function requireAvailableProvider(id: string): PaymentProviderDescriptor {
  const descriptor = findPaymentProvider(id)
  if (!descriptor) throw new Error(`Provedor de pagamento desconhecido: ${id}`)
  if (!descriptor.available) throw new Error(`Provedor ${descriptor.label} ainda não está disponível`)
  return descriptor
}

/** O provedor sabe gerar este meio de pagamento? */
export function supportsMethod(descriptor: PaymentProviderDescriptor, method: string): method is GatewayMethod {
  return (descriptor.methods as string[]).includes(method)
}

/**
 * Uma conta conectada, do ponto de vista de quem lê a tela.
 *
 * `secret_id` não está aqui e nunca estará: a credencial mora no Vault e só sai
 * por `fn_provider_credentials`, server-side. `account_label` está, porque é
 * como o usuário reconhece QUAL conta é aquela — e-mail no Mercado Pago, CNPJ
 * na Cora.
 */
export const ProviderAccountSchema = z.object({
  id: z.string().uuid(),
  provider: ProviderIdSchema,
  external_account_id: z.string(),
  account_label: z.string().nullable(),
  is_default: z.boolean(),
  active: z.boolean(),
})
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>
