# 📉 Tela: Despesas — [[GoMoto]]

Rotas: `/despesas` (listagem) · `/despesas/[id]` (detalhe)
Tipo: listagem é Client Component; detalhe é Server Component (padrão ADR 0002,
igual `/cobrancas/[id]`).

> ⚠️ Nota reescrita em 2026-09-29 — a versão anterior descrevia a tabela legada
> `expenses` (categoria livre, `DELETE`, accordion por categoria, upload de NF).
> Isso não existe mais desde a Spec 0014 / ADR 0024: a tela roda sobre
> `payables`, com responsabilidade financeira (empresa/cliente/compartilhada) e
> rateio em valor, não percentual (Princípio 7).

## Visão geral

Contas a pagar da empresa. Cada despesa carrega **quem é responsável** por ela
— só empresa, só cliente, ou rateada — e a parte do cliente vira **cobrança**
(se a empresa executou o serviço) ou **crédito** (se o cliente antecipou o
pagamento), tudo numa transação atômica no banco (`fn_create_payable`).

Leitura via `usePayables()` (`@gomoto/data`); mutações via `actions.ts`
(`createExpenseAction`, `payExpenseAction`, `cancelExpenseAction`) — padrão
canônico (ADR 0002).

## KPI Cards

| Card | Conteúdo |
|---|---|
| Em aberto | Soma de `company_amount` das despesas `open` |
| Pago | Soma de `company_amount` das despesas `paid` |
| Repassado | Soma de `customer_amount` de todas não-canceladas — separado do custo porque repasse reduz custo, não é receita (ADR 0024, R-03) |

## Filtros

- Abas: Em aberto / Pagas / Canceladas / Todas.
- Busca textual em `description` + `vendor_name`.

## Colunas da Tabela

| Coluna | Conteúdo |
|---|---|
| Descrição | `description` + `vendor_name` (cinza, ao lado) |
| Tipo | Rótulo da categoria (`EXPENSE_CATEGORIES`, mapeado de `expense_account_code`) |
| Veículo | Placa via `vehicle_id` (lookup em `useVehicles()`), ou "—" |
| Competência | `formatDate(competence_date)` |
| Vencimento | `formatDate(due_date)` |
| Pago em | `formatDate(paid_at)` só quando `status='paid'`; senão "—" |
| Total | `amount` |
| Empresa | `company_amount` (= `amount − customer_amount`, derivado no hook, não gravado) |
| Cliente | `customer_amount`, ou "—" se zero |
| Situação | `StatusBadge` (open/paid/cancelled) |
| Ações | Ver detalhes (olho, sempre) + Registrar pagamento (✓, só `open`) + Cancelar (✗, `open` **e** `paid`) |

## Modal "Nova despesa"

| Campo | Obs |
|---|---|
| Descrição | — |
| Categoria | `EXPENSE_CATEGORIES` → `expense_account_code` (`AccountCode` de `@gomoto/core`) |
| Valor total | — |
| Competência / Vencimento | Datas |
| **Já paga** | Checkbox — ver seção própria abaixo |
| Veículo (opcional) | — |
| Fornecedor (opcional) | Texto livre |
| Responsabilidade financeira | Empresa / Cliente / Compartilhada |
| Cliente, Locação | Só se responsabilidade ≠ Empresa |
| Parte do cliente (R$) | Só em "Compartilhada" — **valor**, não percentual; prévia mostra o rateio fechado |
| Como o cliente devolve | "Cobrar do cliente" (empresa executou) ou "Gerar crédito" (cliente executou e a empresa deve a ele) |

### "Já paga"

Para quando o operador está só registrando uma conta que **já saiu do caixa**
(ex.: dado retroativo) e não quer voltar na lista para dar baixa em seguida.
Encadeia `createExpenseAction` + `payExpenseAction` no client — **não é uma
transação só**: se a baixa falhar depois do create, a despesa fica criada e em
aberto, que é um estado normal (resolvido com um clique a mais), não um dado
quebrado.

Escondido quando a despesa **já nasce paga sozinha** — só quando o cliente
devolve por **crédito** (`customerAmount > 0 && reimbursement === 'credit'`,
`bornAlreadyPaid` na page): é o único caso em que a empresa nunca chega a
dever ao fornecedor (`fn_create_payable`). Responsabilidade "Cliente" com
"Cobrar do cliente" **não** nasce paga — a empresa ainda deve ao fornecedor até
cobrar de volta, só muda quem banca no fim. Checar só
`responsibility === 'customer'` (versão anterior, corrigida em 2026-09-29)
escondia o checkbox também nesse caso, que é aberto de verdade.

## Página de Detalhe (`/despesas/[id]`, Server Component)

Status + valor no topo (empresa/cliente separados quando há rateio), seção
"Despesa" (categoria, fornecedor, competência, vencimento, pago em), "Vínculo"
(cliente/veículo/locação, com link para cada), "Responsabilidade e repasse"
(só quando `customer_amount > 0`: responsabilidade, como devolve, e link para a
cobrança de repasse ou o crédito gerado), e "Ações" (`PayableActions.tsx`,
Client Component — reaproveita `payExpenseAction`/`cancelExpenseAction` de
`actions.ts`, sem action nova).

A cobrança de repasse é localizada por `charges.source_module = payable.
source_module AND charges.source_id = COALESCE(payable.source_id, payable.id)`
— a mesma regra que `fn_create_payable` usa para criá-la, então funciona tanto
para despesa lançada direto em `/despesas` (sem origem externa, `source_id`
nasce nulo) quanto para uma que veio de outro módulo (manutenção, multa) com
`source_id` próprio. O crédito é mais simples: `customer_credits.payable_id`
aponta direto para o payable.

## Modal "Registrar pagamento"

Data de pagamento explícita (não é mais `new Date()` do navegador — decide em
que mês a saída cai no DRE). `max` = hoje no fuso do tenant (`businessToday`);
data futura é recusada pelo servidor de todo jeito. Se a despesa tem parte do
cliente, avisa que só a parte da empresa sai do caixa aqui — o resto volta pela
cobrança.

## Cancelamento

Não existe excluir (apagar registro financeiro viola o Princípio 3 —
append-only). Cancelar estorna o lançamento original (`fn_cancel_payable`,
ADR 0029): o custo sai do DRE, `contas_a_pagar` some, e se houver cobrança de
repasse ela também é cancelada — **exceto** se já recebeu pagamento (recusa com
mensagem pedindo estornar o pagamento primeiro) ou se o crédito gerado já foi
usado (recusa pedindo estornar o abatimento primeiro). Despesa paga cancela
normalmente desde a ADR 0029 — o estorno da baixa acontece junto.

## Corrigir a categoria de uma despesa lançada errada

**Não há campo de edição** — e a razão não é falta de tela: `expense_account_code`
não é um rótulo solto, ele já virou o **débito lançado no razão** no momento da
criação (`fn_create_payable`), e — havendo rateio — decide também a conta de
repasse usada na cobrança/crédito gerado (`despesa_manutencao→repasse_manutencao`,
`despesa_multa→repasse_multa`, qualquer outra→`repasse_operacional`). Um UPDATE
direto na coluna deixaria a lista mostrando a categoria nova com o razão (e a
cobrança de repasse, se houver) ainda apontando pra antiga — divergência
silenciosa entre tela e razão.

**Caminho correto hoje, sem código novo:** cancelar a despesa errada (estorna o
lançamento) e recriar com a categoria certa. Só trava se já houver cobrança de
repasse paga — nesse caso a trava está certa, precisa estornar o pagamento
primeiro. Decidido em 2026-09-29: não vale a pena uma ação dedicada de "editar
categoria" (que exigiria uma RPC nova para reclassificar a perna do razão) só
pra evitar dois cliques que já resolvem o caso com o caminho existente.

## Tags
`#projeto/tela` `#gomoto/financeiro`
