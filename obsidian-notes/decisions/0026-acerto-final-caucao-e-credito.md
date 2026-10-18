# ADR 0026 — Acerto final no encerramento: caução e crédito

- **Status:** Aceita — revisada por Alan em 2026-08-29
- **Data:** 2026-08-29
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[Specs/0014-redesenho-financeiro]], [[Checklist de Testes Manuais — Financeiro]], [[Specs/0017-abatimento-caucao-credito]]

> **Atualização (2026-09-21, Spec 0017):** a *decisão* daqui segue de pé — abater
> vem antes de devolver, reter só existe contra dívida, motivo obrigatório para
> abater caução, sem gate por papel. O que mudou foi o *mecanismo*: o abatimento
> deixou de ser agregado (`closeRentalFinancial` e `applyCreditToRentalDebt`, que
> espalhavam o valor da cobrança mais antiga para a mais nova, em chamadas
> separadas e não atômicas) e passou a ser **dirigido** — o operador informa quanto
> de caução e de crédito vai para cada dívida — e a rodar **dentro** de
> `terminate_rental`, na mesma transação que fecha a locação. As duas actions
> foram removidas; a devolução da sobra virou `returnRemainingDeposit`. O texto
> abaixo descreve o mecanismo anterior e vale como histórico.

## Contexto

Encerrar uma locação é o momento em que a relação financeira com o cliente se
fecha. Nesse momento podem existir três quantias ao mesmo tempo:

- **dívida do cliente** — cobranças emitidas e não pagas;
- **caução** — dinheiro do cliente em custódia, vinculado à LOCAÇÃO;
- **crédito do cliente** — dívida da empresa com ele, vinculada ao CLIENTE.

A tela de encerramento trata as três de formas diferentes, e só uma dessas
diferenças se justifica.

### O caso que expôs o problema

Contrato TE1-0001, Bruno Costa, testando o bloco 7 do checklist:

| | |
|---|---|
| Cobranças em aberto | R$ 1.200,00 (4 cobranças) |
| Caução em custódia | R$ 500,00 |
| Crédito do cliente | R$ 500,00 |
| **Sobra real após abater tudo** | **R$ 200,00** |

A tela pede que o operador marque *"Encerrar mesmo com R$ 1.200,00 em aberto"* —
tecnicamente correto e economicamente enganoso: a empresa está com R$ 1.000 do
próprio cliente. A conta que importa, R$ 200, não aparece em lugar nenhum e é
feita de cabeça.

### O que a tela oferece hoje

| Quantia | Tratamento |
|---|---|
| Caução | Decisão obrigatória: devolver tudo / reter parte / reter tudo, com motivo |
| Crédito | Texto de aviso + link para a ficha do cliente |

E o caminho para resolver o crédito, uma vez na ficha, é só **devolver em
dinheiro** (`SettleCreditButton`). **Abater crédito em dívida não existe fora da
tela de uma cobrança**, uma cobrança por vez: para consumir os R$ 500 do Bruno é
preciso abrir quatro cobranças e aplicar crédito em cada uma.

### Por que a assimetria existe — e até onde ela vale

A razão é real: **caução é da locação, crédito é do cliente**. Encerrado o
contrato, o passivo da caução não tem mais motivo para existir e precisa de
destino; o crédito sobrevive, e se o cliente tiver outra moto ele abate a
próxima cobrança.

Isso justifica **não obrigar** uma decisão sobre o crédito. Não justifica **não
oferecer** — que é o que acontece hoje.

### O razão já trata os dois como a mesma coisa

Esta é a evidência mais forte de que a assimetria é só de tela. Em
`packages/core/src/rules/ledger.ts`, as duas quantias têm exatamente os mesmos
dois desfechos, mudando apenas a conta de passivo:

| | Abater a dívida | Devolver em dinheiro |
|---|---|---|
| **Caução** | `deposit_retained`<br>`caucoes_a_devolver → contas_a_receber` | `deposit_returned`<br>`caucoes_a_devolver → caixa` |
| **Crédito** | `credit_applied`<br>`creditos_de_clientes → contas_a_receber` | `credit_settled`<br>`creditos_de_clientes → caixa` |

Dois passivos, os mesmos dois movimentos. A contabilidade está pronta; a
orquestração no encerramento é que não existe.

## Decisão

**Princípio: no encerramento, abater vem antes de devolver.**

Devolver dinheiro a quem deve à empresa é a ordem errada — sai caixa e a dívida
continua de pé, para ser cobrada de alguém que acabou de receber um cheque.
Abater é o único movimento que não toca o caixa e reduz dois passivos de uma vez.

A tela passa a ter uma seção única — **Acerto final** — que mostra a conta
fechada e pede uma decisão por quantia:

```
Dívida do cliente                    R$ 1.200,00
  − caução abatida                   R$   500,00     sobra R$ 0,00
  − crédito abatido                  R$   500,00     sobra R$ 0,00
  ──────────────────────────────────────────────
  Restante a receber                 R$   200,00
```

Com dívida menor que o dinheiro em custódia, o mesmo bloco mostra a sobra e o
seu destino — é ela que vira devolução:

```
Dívida do cliente                    R$   300,00
  − caução abatida                   R$   300,00     sobra R$ 200,00 → devolver
  − crédito abatido                  R$     0,00     sobra R$ 500,00 → deixar como crédito
  ──────────────────────────────────────────────
  Restante a receber                 R$     0,00
  Sai do caixa                       R$   200,00
```

### Decisão por quantia: a mesma forma para as duas

Caução e crédito passam a ter **a mesma lógica**, e o controle tem sempre duas
partes: *quanto usar para abater* e *o que fazer com a sobra*.

| | Quanto abater | Sobra |
|---|---|---|
| **Caução** | de zero ao saldo, limitado à dívida | **devolver** |
| **Crédito** | de zero ao saldo, limitado à dívida | **devolver** ou **deixar como crédito** |

Defaults: havendo dívida, abater o máximo possível — caução primeiro; sem
dívida, abater zero e a sobra é o saldo inteiro. Para o crédito, o default da
sobra é *deixar* quando o cliente tem outra locação ativa e *devolver* quando
não tem.

"Reter" desaparece como opção separada: reter **é** abater, e o rótulo passa a
dizer isso. A justificativa continua obrigatória quando há abatimento de caução
— ela explica ao cliente por que a caução dele virou pagamento.

**A única assimetria que sobra** é o "deixar": crédito pode ficar porque
pertence ao cliente; caução não, porque o passivo é da locação e ela está
acabando. O equivalente simétrico seria **converter a sobra de caução em
crédito** — economicamente possível (é troca de um passivo por outro), mas não
adotada aqui: não há evento no razão para isso e ninguém pediu. Fica registrada
como considerada, para quem ler depois não achar que passou batido.

O **"deixar como crédito"** é o que preserva a diferença de escopo que
justifica a assimetria — mas agora como escolha visível e consciente, não como
ausência de opção.

### Retenção de caução existe apenas contra dívida

**Reter é abater.** Não existe reter caução "para a empresa": ou existe dívida e
a caução a abate, ou não existe dívida e a caução é **devolvida**. Sem dívida, a
opção de reter não é oferecida.

Quando o operador precisa reter por um motivo que ainda não virou dívida — a
avaria é o caso clássico —, o caminho é **criar a dívida primeiro**, e o produto
já tem o caminho certo: lançar a avaria em **Despesas**, com responsabilidade do
cliente e repasse por cobrança. Isso emite a cobrança, e a caução passa a ter o
que abater.

O desvio tentador seria a tela criar uma "cobrança de retenção" genérica, ou
lançar a retenção direto como receita. Os dois perdem informação que o modelo
hoje guarda: o **custo** da avaria sai do DRE e o **repasse** deixa de aparecer
na linha de recuperação de despesa. A avaria é uma despesa da empresa que o
cliente paga — é assim que ela precisa entrar, e o rateio de Despesas já faz
exatamente isso ([[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]],
Princípio 7).

Consequência direta: **toda retenção passa a ter alocação**, e o defeito da
questão 1 do rascunho deixa de existir por construção, em vez de precisar de
tratamento para o caso "reteve sem ter onde alocar".

### Qual quantia usar é escolha do operador, não automatismo

A ordem sugerida é **caução primeiro** — ela precisa ser zerada de todo jeito, e
o crédito pode sobreviver ao contrato. Mas sugerir não é decidir por ele: o
operador escolhe **quais quantias entram no acerto**, podendo usar só o crédito
e devolver a caução em dinheiro, ou o contrário.

O que a decisão exige em troca é **transparência antes de confirmar**: a tela
mostra o efeito de cada escolha na conta, atualizado enquanto ele decide, e o
que será escrito. Nunca "confirme e descubra".

### Rótulos dizem o que fazem

"Reter tudo" hoje soa como *"a empresa fica com o dinheiro"*. O que ele faz é
abater a dívida do cliente (`deposit_retained` + `allocateWithoutCash`). O
rótulo passa a ser **"Abater da dívida (R$ X)"**, com o restante explícito — e,
não havendo dívida, ele simplesmente não aparece.

## Alternativas consideradas

**Deixar como está e documentar.** Descartada: o problema não é o operador não
saber, é a tela pedir uma decisão (encerrar com R$ 1.200 em aberto) com o número
errado na frente. Documentar um número enganoso não o conserta.

**Obrigar decisão sobre o crédito, como na caução.** Descartada: quebraria o
caso legítimo do cliente com outra locação ativa, forçando devolver ou abater um
saldo que faz sentido continuar existindo.

**Abater automaticamente, sem perguntar.** Descartada: abater é irreversível na
prática (gera alocação e lançamento) e há casos em que o operador não quer —
crédito reservado para um acerto combinado, caução em disputa por avaria. A
automação certa é o *default*, não a ausência de escolha.

**Resolver tudo na ficha do cliente, e o encerramento só linkar.** É o que
existe hoje. Descartada: tira o operador do meio de um fluxo transacional e não
garante que ele volte — e a ficha nem oferece abatimento.

## O que já existe e o que falta

Nenhuma regra financeira nova é necessária. As quatro peças existem e têm
cobertura:

| Operação | Onde |
|---|---|
| Caução: devolver / reter / parcial | `closeRentalFinancial` (`locacoes/actions.ts`) |
| Crédito: abater em UMA cobrança | `fn_apply_customer_credit` via `applyCustomerCredits` |
| Abater em VÁRIAS, da mais antiga | `allocateWithoutCash` (`lib/financial/payments.ts`) |
| Crédito: devolver em dinheiro | `settleCustomerCredit` (`clientes/[id]/actions.ts`) |

Falta: a orquestração no encerramento, o cálculo do líquido, e o caminho de
**criar a dívida** a partir da tela quando o operador precisa reter e não há o
que abater — que é uma despesa com rateio, não uma cobrança inventada (ver
*Retenção de caução existe apenas contra dívida*).

## Defeito que a decisão dissolve

`closeRentalFinancial` lança `deposit_retained` (credita `contas_a_receber`) e
chama `allocateWithoutCash`. **Sem cobrança em aberto, não há onde alocar**: o
valor volta em `unallocated` e o chamador **ignora**. Sobra um recebível
creditado sem contrapartida e um `payments` sem alocação. *Achado por leitura de
`locacoes/actions.ts:1272-1295`, não reproduzido.*

Com a regra "retenção só contra dívida", o caminho que produz esse estado deixa
de ser oferecido. Ainda assim a guarda precisa existir no banco, não só na tela:
a action é chamável direto, e a lição de
[[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]] é que invariante
de dinheiro não mora no cliente.

### Devolver dinheiro não exige papel específico

Devolver caução ou crédito é saída de caixa, e o produto já sabe gatear por
papel — `getOwnerTenant()` restringe a política de encargo e a integração de
pagamento ao Owner. **Aqui não gateia:** quem recebe a moto de volta é quem faz
o acerto, e exigir Owner travaria o fluxo diário.

A proteção não é o cargo, é o rastro: o movimento vai para o razão com autor
(`logAction`) e é estornável. Limite por VALOR ("acima de R$ X precisa do
Owner") é outra feature, sem demanda até aqui; se for preciso, o gancho é
`getOwnerTenant()` e custa pouco.

## Consequências

- O encerramento passa a ser o lugar onde a relação financeira fecha por
  completo, em vez de fechar a metade que está vinculada à locação.
- O checkbox de forçar passa a falar do **restante real**, não do bruto.
- Dois caminhos que hoje só existem em outras telas (abater crédito, devolver
  crédito) ganham entrada aqui — sem duplicar lógica, chamando as mesmas actions.
- Encerramento com abatimento passa a escrever mais no razão numa transação só;
  a garantia de consistência continua sendo do banco ([[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]]).
- **Reter caução deixa de ser possível sem dívida.** É restrição nova sobre um
  caminho que hoje a tela aceita — e é o ponto que mais provavelmente vira
  atrito com quem já usa: quem quer "ficar com a caução" da avaria terá de
  lançar a avaria em Despesas antes. Em troca, o custo da moto aparece no DRE e
  a recuperação aparece na linha certa, em vez de a retenção sumir dentro de um
  recebível sem lastro.
- A justificativa da retenção passa a ter dois lugares possíveis (a despesa da
  avaria e o acerto) — vale checar na implementação se ela não fica duplicada.
- O encerramento passa a poder **tirar dinheiro do caixa** (devolução de caução
  e de crédito na mesma confirmação). A tela precisa dizer o valor que sai antes
  de confirmar, e o razão registra as duas saídas separadamente
  (`deposit_returned` e `credit_settled`), porque são passivos diferentes.

## Plano de execução

1. ~~**Fase 1 — só leitura.**~~ ✅ **Feita em 2026-08-29.** A tela ganhou o bloco
   *Acerto final* (dívida − caução abatida = fica em aberto, mais o crédito como
   *disponível* e onde abatê-lo), os rótulos da caução passaram a dizer "abater"
   em vez de "reter", e o checkbox de forçar mostra os dois números: o que a RPC
   confere e o que sobra depois do acerto. Nenhuma escrita mudou. O E2E
   `billings-rentals.spec.ts` selecionava o radio pelo rótulo antigo e foi
   ajustado junto.
2. ~~**Fase 2 — decisão de crédito no encerramento.**~~ ✅ **Feita em 2026-08-29.**
   O aviso virou seção *Destino do crédito* com as opções da tabela acima;
   `applyCreditToRentalDebt` (nova, em `locacoes/actions.ts`) abate no laço sobre
   `fn_apply_customer_credit`, da cobrança mais antiga para a mais nova e apenas
   nas cobranças DESTA locação; devolver reusa `settleCustomerCredit`. O
   default passou a ser *abater* quando há dívida, derivado dos saldos em vez de
   fixado no mount — os saldos vêm de hook e chegam depois do primeiro render.

   O default da CAUÇÃO também passou a *abater* havendo dívida, derivado do
   mesmo jeito.
3. ~~**Fase 3 — a regra da retenção.**~~ ✅ **Feita em 2026-08-29.** Migration
   `20260829234717_reter_caucao_so_contra_divida` cria
   `fn_retain_deposit_on_charge`, espelhando `fn_apply_customer_credit`: uma
   cobrança por chamada, trava no cliente, recusa acima do saldo da caução
   (`AMOUNT_EXCEEDS_DEPOSIT`) e acima do que a cobrança deve
   (`AMOUNT_EXCEEDS_CHARGE`). `closeRentalFinancial` deixou de usar
   `postTransaction` + `allocateWithoutCash` e passou a percorrer as cobranças
   abertas chamando a RPC; sobra de retenção sem dívida agora **falha** com a
   mensagem que aponta o caminho da despesa com rateio, em vez de virar
   recebível sem lastro em silêncio. Na tela, sem dívida a opção de abater não
   aparece e o texto explica por quê; o teto de "abater parte" passou a ser a
   dívida, não o saldo da caução.

## Verificação

- `pnpm test` — 21 unit tests, verdes.
- `billings-rentals.spec.ts` — 6 testes, verdes, incluindo um **novo**: *"a RPC
  recusa reter acima do que a cobrança deve"*, que prova a guarda e que a recusa
  não deixa pagamento órfão.
- `credito-e-encargo`, `ledger-invariants`, `reconciliacao` — 21 testes, verdes.
  A reconciliação varre o razão inteiro e é o que pegaria um recebível sem
  contrapartida.

Dois defeitos que os testes acharam durante a implementação:

1. O teste *"preserva Entrada e Caução"* passava com a caução **não liquidada**:
   o novo default (abater) exige justificativa, o formulário não a validava, e
   `closeRentalFinancial` recusava DEPOIS de a locação já ter sido encerrada. O
   encerramento é irreversível; o operador descobriria pela mensagem. Guarda
   adicionada antes do confirmar.
2. O mesmo teste dependia do default antigo sem dizer. Agora escolhe *Devolver
   tudo* explicitamente, com o motivo no comentário.

## Quando reavaliar

Se surgir cliente com mais de uma locação ativa em operação real — hoje o caso é
teórico e o default de "deixar como crédito" depende dele.
