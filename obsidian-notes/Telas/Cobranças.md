# 💳 Tela: Cobranças — [[GoMoto]]

Rota: `/cobrancas` | Tipo: Client Component

> [!warning] Nota parcialmente defasada
> As seções de **tabela**, **abas de filtro** e **KPIs** ainda descrevem o mundo
> pré-[[ADR 0024]]: `status='paid'`, `payment_date`, `observations`, status
> `loss`, ações "Editar" e "Excluir". Nada disso existe — documento emitido é
> imutável (Princípio 5) e saldo nunca é coluna (Princípio 2). Só a seção
> **Ações Especiais → Registrar pagamento** está em dia com o código.

## Layout

- 6 KPI cards financeiros
- Abas de filtro (5 status)
- Busca textual
- Tabela com 7 colunas + ações especiais

## Abas de Filtro

`Todas` / `Pendentes` / `Vencidas` / `Pagas` / `Prejuízo` — cada uma com contador.

## Busca Textual

Em `customers.name` e `description` (case-insensitive).

## Colunas da Tabela

| Coluna | Conteúdo |
|---|---|
| Cliente | Nome + ícone WhatsApp (`wa.me/55{phone}`) |
| Descrição | Texto da cobrança |
| Valor | `formatCurrency(amount)` |
| Vencimento | `formatDate(due_date)` |
| Status | `<StatusBadge />` |
| Dt. Pagamento | `formatDate(payment_date)` ou "—" |
| Ações | Editar, Marcar Pago, Prejuízo, Excluir |

## Ações Especiais

**Registrar pagamento** (aparece se a cobrança está aberta ou vencida):

Uma implementação só — `components/financial/RegistrarPagamentoModal.tsx` —
usada tanto pela lista quanto pela tela de detalhe. Eram dois modais separados
que divergiram: um recusava valor acima do saldo, o outro deixava passar, e a
conta do devido estava duplicada (a cópia do detalhe perdeu o `round2` e exibia
250,00000000000003 onde a lista dava 250,00). Quem for mexer, mexe nos dois de
uma vez porque só existe um.

O modal mostra:

| Bloco | Conteúdo |
|---|---|
| Cabeçalho | Nº da cobrança, cliente, **vencimento** e dias de atraso |
| Data do recebimento | Default hoje; futura é recusada. Muda a data → refaz o encargo |
| Valor recebido | Trava no devido: acima disso volta ao máximo e explica dentro do modal |
| Detalhamento | Principal / Multa / Juros · N dias / Total a receber |
| Forma de pagamento | PIX / Dinheiro / Cartão / Transferência / Outro |

O encargo é **projetado** até o recebimento e realizado com a data escolhida
(R-06 / ADR 0024) — não existe "consolidar encargo" à parte. Excedente não vira
pagamento: para receber a mais, registre o devido e conceda o resto como crédito
na ficha do cliente.

**Cobrar pelo gateway** (só na tela de detalhe, cobrança aberta ou vencida):

O rótulo do botão vem do **gateway eleito**, resolvido no servidor e passado
como `gatewayMethod` — não é fixo. O que ele gera depende do provedor:

| Gateway eleito | Botão | Modal |
|---|---|---|
| Mercado Pago, Cora | *Gerar Pix* | QR + copia-e-cola |
| InfinitePay | *Gerar link de pagamento* | URL copiável + abrir checkout |

A InfinitePay não devolve código Pix: devolve uma **URL de checkout hospedado**,
e quem escolhe Pix ou cartão é o cliente, na página deles
([[decisions/0032-integracao-infinitepay-checkout|ADR 0032]]). Por isso o
payload grava `checkout_url` e não `emv` — gravar como `emv` faria a tela
mostrar uma URL como copia-e-cola e o cliente tentaria colá-la no app do banco.

O modal **acompanha a confirmação** (`usePaymentIntentStatus`, 5s): o pagamento
chega por webhook, fora do navegador. Ao confirmar, `router.refresh()` reexecuta
o Server Component e os botões de ação somem junto com o status.

Nenhum chamador nomeia meio de pagamento. `getOrCreateIntent` resolve a conta
eleita primeiro e usa `descriptor.methods[0]` — antes era `'pix'` fixo, o que
quebraria a cobrança assim que um gateway de checkout fosse eleito.

### App do cliente (mobile — `apps/mobile/src/screens/BillingsScreen.tsx`)

**Layout (redesenho 2026-10-14)**, no padrão de apps bancários e com o kit de
componentes da [[decisions/0040-identidade-visual-app-mobile-v2|ADR 0040]]:

- **Card de resumo** no topo, na superfície de marca (azul-marinho): *Total a pagar* (todas
  as cobranças emitidas em aberto — vencidas + a vencer), selo *N cobranças vencidas
  · R$ X* ou *Tudo em dia*, e um atalho para a cobrança mais urgente
  (*Regularizar agora* / *Pagar próxima cobrança*).
- **Abas A pagar / Pagas** no lugar do antigo botão "Ver histórico".
  - *A pagar*: **todas** as cobranças em aberto, em duas seções com subtotal —
    *Vencidas* e *A vencer* — ordenadas por vencimento. (2026-10-16) Antes eram
    *Em atraso*, *Próximo aluguel* e *Outras cobranças*: "Próximo aluguel"
    mostrava só **uma** cobrança de locação, regra herdada da geração upfront
    ([[decisions/0009-geracao-cobracas-upfront-vs-cron|ADR 0009]], substituída).
    Desde a ADR 0024 só existe o que foi emitido, e o recorte escondia
    cobranças reais (ex.: duas semanas emitidas e não vencidas → uma sumia).
  - *Pagas*: só `status = 'paid'`, **paginadas** (`useMyPaidCharges`, 30 por
    página, `due_date desc, charge_id desc`, botão *Carregar mais*), agrupadas
    por mês do vencimento com total do mês. Antes vinha de `useMyCharges(false)`,
    que baixava **todas** as cobranças e filtrava no aparelho: crescia sem
    limite, mandava `.in()` com centenas de ids na URL e esbarrava no
    `max_rows = 1000` do PostgREST, que corta a resposta em silêncio.
  - **Data de pagamento** (2026-10-16): a linha mostra *Pago em dd/mm/aaaa* e o
    detalhe ganha a linha *Pagamento*. `paid_at` em `MyChargeRow` vem de
    `enrichMyCharges`: o `payments.paid_at` mais recente entre os pagamentos
    **não estornados** alocados à cobrança (`payment_allocations →
    payments`, políticas `customer_read_own_*`), ou seja, quando ela foi
    quitada. Só consulta cobranças com `paid_amount > 0`. É instante
    (timestamptz), formatado no fuso do aparelho (`formatLocalDate`) — cortar a
    string daria a data UTC e um Pix das 22h apareceria no dia seguinte. A
    ordem da aba continua por vencimento (a paginação depende dela).
- **Linha**: selo de data (dia/mês) colorido pelo tom — vencida (danger), vence
  hoje (warning), até 3 dias (pending), futura (primary), paga (success);
  descrição, *Locação/Avulsa · placa*, frase de vencimento e valor.
- **Detalhe**: valor em destaque com status, alerta de atraso explicando o
  encargo, **composição item a item** (`useChargeDetail`, política
  `customer_read_own_charge_items`) com subtotal / já pago / encargos, bloco de
  detalhes (origem, veículo, emissão, vencimento, pagamento quando paga,
  número) e botão **Pagar**
  fixo no rodapé. Com tentativa já gerada, o botão vira *Ver pagamento em
  andamento* em vez de gerar outra.
- **Pagamento**: selo *Aguardando pagamento…* enquanto o polling roda, botão
  *Copiar código Pix* que confirma no próprio botão (sem `Alert`), passo a
  passo de como pagar e tela de sucesso dedicada quando o webhook confirma.

"Hoje" é a data **local** do aparelho: `toISOString()` (UTC) fazia a cobrança
que vence hoje aparecer como vencida depois das 21h.

O detalhe da cobrança tem um único botão **Pagar R$ X**, que chama
`POST /api/charges/[id]/payment-intent` **sem `method`** — o meio é o do
gateway eleito, como no cockpit. O antigo seletor *Pix / Boleto (em breve) /
Cartão (em breve)* foi removido: o app nunca escolheu meio nenhum.

A resposta é `PaymentIntentResult`; o que varia por provedor mora em `payload`,
e o modal de pagamento se orienta por `method`:

| `method` | Gateway | Modal |
|---|---|---|
| `pix` | Mercado Pago, Cora | QR (`payload.qr_code_base64`) + copia-e-cola (`payload.emv`, fallback `qr_code`) |
| `payment_link` | InfinitePay | Abre `payload.checkout_url` no navegador **dentro do app** (`expo-web-browser`: Custom Tabs / SFSafariViewController) assim que o link é gerado; o modal fica por trás com *Abrir página de pagamento* |
| outro | — | Aviso "forma de pagamento não suportada nesta versão do app" em vez de QR vazio |

`expo-web-browser` e não `Linking.openURL`: o checkout abre sobre o app e o
cliente volta fechando a página, sem trocar de aplicativo.

A confirmação usa o **mesmo mecanismo do cockpit**: `usePaymentIntentStatus`
lê `payment_intents.status` a cada 5s (política `customer_read_own_payment_intents`)
até virar `paid`. Aí o modal mostra *Pagamento confirmado!* (reabrindo-se se o
cliente o tinha fechado), fecha o checkout hospedado no iOS
(`WebBrowser.dismissBrowser`) e, após 2,5s, fecha o detalhe e recarrega as listas
"em aberto" e histórico. Fechar o modal de pagamento não encerra o polling:
ele segue enquanto o detalhe da cobrança estiver aberto.

Até 2026-09-25 o app esperava a cobrança aparecer como `paid` em
`useMyCharges(true)` — que só devolve cobranças **em aberto**. Paga, ela sumia
da lista e o feedback nunca aparecia.

Até 2026-09-25 o app lia `emv`/`qr_code_base64` no **primeiro nível** da
resposta, onde nunca estiveram desde que o payload virou agnóstico de gateway
— o QR saía `base64,undefined` e o copia-e-cola vazio para os três provedores.

**Cliente de mais de uma locadora.** Um login tem um cadastro em `customers`
**por tenant** (PRD 0001). A rota resolvia o cliente com
`.eq('user_id', …).maybeSingle()`: com dois cadastros o PostgREST devolve erro e
o cliente ouvia *"Cliente não encontrado"* (produção, 2026-09-25). Agora a rota
lê todos os cadastros do login e aceita a cobrança se ela pertencer a um deles,
na locadora dele. A rota de envio de vistoria periódica
(`/api/inspections/schedules/[id]/submit`) tinha o mesmo defeito e recebeu a
mesma correção. Teste de regressão: `api-payment-intent.spec.ts`, *"cliente de
DUAS locadoras alcança a própria cobrança"*.

**Validação da sessão no "Pagar" (2026-10-16).** A rota responde 401 só quando o
GoTrue *recusa* o token (vencido, revogado, assinatura inválida). Falha do GoTrue
(rede, timeout de 8s, 5xx, 429) responde **503 `AUTH_UNAVAILABLE`** "Não foi
possível confirmar sua sessão. Tente novamente." Antes, as duas respondiam 401
"Não autorizado", e cliente logado com token válido via erro de autenticação toda
vez que o GoTrue de produção engolia a requisição. No app: falha de rede ao renovar
o token mostra mensagem de conexão (antes "Não autenticado"); um 401 renova a sessão
uma vez e repete o pedido (cobre sessão revogada e relógio do aparelho atrasado); um
segundo 401 desloga o aparelho e manda para o login; o `fetch` tem teto de 30s.
A rota de vistoria (`/api/inspections/schedules/[id]/submit`) ainda usa o padrão
antigo.

**Conceder desconto** (só na tela de detalhe, cobrança aberta com saldo em
aberto — `components/financial/BillingActions.tsx`):

Reduz o que a cobrança ainda deve sem editar item nenhum: o documento emitido é
imutável (ADR 0024, Princípio 5). Ao confirmar, `applyDiscountAction` insere um
item **negativo** (`source_module = 'discount'`) por conta de origem dos itens
já lançados, e estorna a receita no razão na mesma proporção — uma cobrança que
mistura aluguel e repasse de multa, por exemplo, tem o desconto rateado entre
as duas contas, não debitado só contra uma (`distributeProportionally`,
`@gomoto/core`).

O teto é o **saldo já lançado** (`open_amount`), nunca o valor com juros ainda
em projeção — descontar sobre juros que ainda não viraram item cobraria de
menos algo que a cobrança ainda não cobra (R-06). Motivo é obrigatório (mínimo
3 caracteres) e vai para a descrição do item e para `logAction`.

Diferente de registrar um pagamento parcial: pagamento parcial deixa a
diferença **em aberto** (dívida que continua existindo); desconto **extingue**
a diferença. As duas ações não se confundem porque vivem em modais separados,
com títulos e campos próprios.

**Contabilizar como Prejuízo** (aparece se `pending` ou `overdue`):
- Modal de confirmação com aviso em vermelho
- Salva: `status='loss'`

## Detalhe da cobrança — origem do pagamento ([[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]])

A tabela de **Pagamentos** em `/cobrancas/[id]` tem uma coluna **Origem** entre "Forma" e "Valor".

O problema que ela resolve: um recebimento de R$ 100 aparecia como "PIX" tanto se a Cora confirmou sozinha quanto se alguém digitou à mão — e são situações que exigem coisas diferentes de quem confere. A do gateway tem contrapartida no extrato do provedor; a manual depende de uma pessoa ter digitado certo.

| Caso | O que aparece |
|---|---|
| Confirmado por gateway | o **nome do provedor** — "Cora", "Mercado Pago", "InfinitePay" |
| Registrado à mão | **"Manual"**, e o nome de quem registrou quando ele é resolvível |

A origem sai de duas fontes, em ordem de confiança:

1. **`payments.received_by_system`** (`gateway:cora`) — gravado pela própria RPC de confirmação. É o que o caminho do dinheiro registrou sobre si.
2. **o provedor do `payment_intent`** — cobre os recebimentos anteriores àquela coluna. Menos direto, mas suficiente: pagamento amarrado a uma tentativa de gateway veio de gateway.

Sem nenhuma das duas, foi manual. **Não é inferência frouxa:** `fn_confirm_gateway_payment` sempre marca a origem, então a ausência das duas só sobra para o caminho manual.

O nome de quem recebeu vem de `list_tenant_members` (SECURITY DEFINER — `payments.received_by` é id de `auth.users`, que `authenticated` não lê direto). Essa RPC é **owner/admin apenas**, então para um Operator a coluna diz "Manual" sem o nome. É degradação honesta: melhor omitir o nome do que inventar um.

## Formulário de Criação/Edição

| Campo | Tipo | Required |
|---|---|---|
| Cliente | select (clientes ativos) | ✓ |
| Contrato | select (contratos do cliente selecionado) | — |
| Descrição | text | ✓ (Ex: "Semanal — 10/03 a 16/03") |
| Valor (R$) | number (step=0.01) | ✓ |
| Vencimento | date | ✓ |
| Observações | textarea (2 linhas) | — |

Status inicia sempre como `pending` na criação.

## 6 KPI Cards (useMemo)

| Card | Cálculo |
|---|---|
| **Total Recebido** | SUM(amount) WHERE paid + ticket médio |
| **A Receber** | SUM(amount) WHERE pending + valor vencendo em 30d |
| **Vencidas** | SUM(amount) WHERE overdue + cobrança mais antiga (cliente + dias) |
| **Inadimplência** | `(overdue+loss) / total × 100` + pontualidade (paid on time %) |
| **Valores Não Pagos** | pending + overdue + tempo médio de recebimento |
| **Prejuízos** | SUM(amount) WHERE loss + maior prejuízo por cliente |

## Queries Supabase

```sql
-- Fetch principal
SELECT *, customers(name, phone), contracts(id)
FROM billings ORDER BY due_date DESC

-- Selects do formulário
SELECT id, name FROM customers WHERE active = true ORDER BY name
SELECT id, customer_id, customers(name) FROM contracts WHERE status = 'active'

-- Criar
INSERT INTO billings (customer_id, contract_id, description, amount, due_date, status, observations)

-- Editar
UPDATE billings SET (...) WHERE id = ?

-- Marcar pago
UPDATE billings SET status='paid', payment_date=?, observations=? WHERE id = ?

-- Prejuízo
UPDATE billings SET status='loss' WHERE id = ?

-- Deletar
DELETE FROM billings WHERE id = ?
```

## Lógica de Negócio

- Cálculo de atraso: `Math.floor((today - new Date(due_date)) / 86400000)` dias
- Observações de método são **cumulativas** (concatena com `\n` ao marcar pago)
- `filtered` e `metrics` em useMemo para performance

## Tags
`#projeto/tela` `#gomoto/cobrancas`
