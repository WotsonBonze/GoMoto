---
status: aprovado
versão: 1.1
modo: lite
autor: Alan (com agente IA)
data: 2026-09-17
related:
  - "[[Telas/Locações]]"
  - "[[decisions/0035-ajuste-de-periodo-da-locacao]]"
tags:
  - prd
  - prd-lite
  - encerramento-retroativo-cobrancas
  - locacoes
---

# PRD 0016 — Encerramento retroativo de contrato com decisão sobre cobranças já emitidas

> 🟢 **Status: aprovado** (modo lite) em 2026-09-17, **revisado no mesmo dia** durante a implementação. Contrato encerrado com data retroativa cancela automaticamente toda cobrança (emitida ou planejada) fora do período que sobrevive, e permite ao operador cancelar por opção qualquer cobrança dentro desse período.

> **Por que lite?** Toca uma única tela (Encerrar contrato), uma persona, nenhuma entidade nova — apenas uma nova decisão automática/opcional sobre dado que já existe (cobranças emitidas e planejadas).

> **Revisão de 2026-09-17 (v1.1):** o desenho original (v1.0) pedia decisão manual, cobrança a cobrança, só para cobrança **emitida** fora do período. Ao implementar, o humano pediu para simplificar e ampliar: fora do período passa a ser **sempre cancelado, automaticamente** (emitida ou não) — RF-002 original ("operador decide, cobrança a cobrança") deixou de se aplicar a esse grupo. Em troca, o operador ganhou a opção de cancelar, por vontade própria, qualquer cobrança ou parcela **dentro** do período — capacidade que não existia na v1.0. RN-001 (imunidade de cobrança com valor reduzido) continua valendo dos dois lados. Os RF abaixo já refletem a v1.1; a numeração (RF-001 a RF-005, RN-001 a RN-003) foi mantida para não quebrar a rastreabilidade com a Spec.

---

## 1. Visão Geral

### 1.1 Contexto e problema

Um contrato pode ficar ativo além da data em que deveria ter sido encerrado — por exemplo, o cliente devolveu a moto há um mês, mas ninguém registrou o encerramento no sistema. Enquanto isso, o sistema continua emitindo normalmente as cobranças de ciclo previstas no contrato, porque para ele o contrato segue ativo.

Quando o operador finalmente registra o encerramento com uma data retroativa (a data real da devolução), o sistema hoje só cancela parcelas que **ainda não viraram cobrança**. Cobranças que **já foram emitidas** para períodos depois dessa data — geradas durante o tempo em que o contrato ficou aberto por engano — continuam em aberto e cobráveis do cliente indefinidamente, mesmo representando um período em que o contrato já deveria estar encerrado. Não existe hoje uma forma de o operador decidir cancelar essas cobranças no próprio ato de encerrar.

### 1.2 Resultado esperado

- Ao encerrar um contrato com data retroativa, o operador enxerga TODA cobrança viva do cronograma — vencida, emitida ou ainda planejada —, dividida entre o que fica **dentro** do período que sobrevive e o que fica **fora** dele.
- Cobrança **fora** do período é cancelada automaticamente, sem exigir marcação — é consequência direta de escolher aquela data.
- Cobrança **dentro** do período é mantida por padrão, mas o operador pode marcá-la para cancelar mesmo assim, individualmente ou todas de uma vez.

---

## 2. Personas e User Stories

| Persona | Frequência |
|---|---|
| Operador | Eventual (toda vez que um encerramento chega atrasado) |

- **US-001** — Como Operador, quero decidir o que fazer com cobranças já emitidas para períodos posteriores à data de encerramento retroativo, para não deixar o cliente sendo cobrado por um período em que o contrato já deveria estar encerrado, nem perder controle sobre cobranças que a empresa realmente quer manter.

---

## 3. Fluxo

### 3.1 Caminho feliz

1. Operador abre a tela de encerramento do contrato e escolhe uma data de encerramento retroativa.
2. A tela mostra toda cobrança viva do cronograma — vencida, emitida ou planejada —, dividida em duas listas: **fora do período** (será cancelada, sem escolha) e **dentro do período** (mantida por padrão).
3. Para cada item da lista "dentro do período", o operador pode marcar: cancelar mesmo assim ou manter — ou usa o atalho "cancelar todas elegíveis" quando quiser cancelar todas de uma vez.
4. A apuração financeira do encerramento (valor em aberto, acerto com caução/crédito) é recalculada considerando o que será cancelado — automaticamente (fora do período) e por opção (dentro dele).
5. Operador confirma o encerramento.
6. Tudo que ficou fora do período, e tudo que foi marcado dentro dele, deixa de ser cobrável; o restante permanece em aberto normalmente. O contrato encerra na data escolhida e o veículo volta a ficar disponível, como já acontece hoje.

### 3.2 Erro principal

Operador tenta marcar para cancelar, dentro do período, uma cobrança que já teve seu valor reduzido — por pagamento (total ou parcial) ou por crédito do cliente aplicado. O sistema não oferece essa opção para ela (fica mantida, sem botão de cancelar) e, se de alguma forma a marcação chegar ao servidor, recusa e explica que cobrança nessa condição não pode ser cancelada por aqui: desfazer um recebimento é estorno de pagamento, e desfazer um abatimento de crédito é uma operação própria — ambas feitas separadamente. O mesmo vale para uma cobrança **fora** do período que já tem valor reduzido: ela não é cancelada automaticamente, fica sinalizada para tratamento à parte.

---

## 4. Requisitos e Critérios de Aceite

### RF-001 — Sistema identifica e divide toda cobrança viva entre dentro e fora do período

Ao escolher uma data de encerramento, o sistema identifica automaticamente TODA cobrança viva do cronograma — vencida, emitida ou ainda planejada — e a divide em duas listas: as cujo período de referência é **posterior** à data (fora do período) e as demais (dentro do período).

- **CA-001 (vincula RF-001):**
  - **Dado** um contrato ativo com uma cobrança já emitida cujo período começa depois da data escolhida pelo operador
  - **Quando** o operador seleciona essa data de encerramento
  - **Então** a tela lista essa cobrança na seção "fora do período", distinta das linhas planejadas e das que ficam dentro do período

### RF-002 — Cobrança fora do período é sempre cancelada, sem escolha do operador

Toda cobrança — emitida ou ainda não — cujo período de referência é posterior à data de encerramento é cancelada automaticamente ao confirmar. Não há marcação individual para esse grupo: a decisão já foi tomada ao escolher a data.

- **CA-002 (vincula RF-002):**
  - **Dado** duas cobranças fora do período, nenhuma com valor reduzido
  - **Quando** o operador confirma o encerramento
  - **Então** as duas são canceladas automaticamente, sem que o operador precise marcar nenhuma

### RF-003 — Cobrança com valor já reduzido nunca é cancelada por este fluxo

Cobrança — dentro ou fora do período — que já teve parte do valor reduzido — por pagamento (total ou parcial) ou por crédito do cliente aplicado — nunca é cancelada por este fluxo, nem automaticamente (fora do período) nem por marcação (dentro dele). O sistema explica o motivo e indica que a alternativa é tratar isso separadamente (estorno de pagamento, ou desfazer o abatimento de crédito).

- **CA-003 (vincula RF-003):**
  - **Dado** uma cobrança fora do período com parte do valor já paga pelo cliente
  - **Quando** o operador confirma o encerramento
  - **Então** essa cobrança NÃO é cancelada automaticamente — fica sinalizada, e o sistema informa que exige estorno de pagamento à parte

- **CA-006 (vincula RF-003):**
  - **Dado** uma cobrança dentro do período cujo valor foi parcialmente abatido por crédito do cliente, sem nenhum pagamento em dinheiro
  - **Quando** o operador tenta marcá-la para cancelamento
  - **Então** o sistema não oferece essa opção para ela (sem botão de cancelar) e, se a marcação ainda assim chegar ao servidor, a recusa informando que cobrança com crédito já aplicado não pode ser cancelada por aqui

### RF-004 — Apuração financeira reflete todo cancelamento antes da confirmação

O valor em aberto do cliente e o acerto de caução/crédito mostrados na tela consideram tanto o que será cancelado automaticamente (fora do período) quanto o que foi marcado por opção (dentro dele) — o operador nunca decide o destino de caução/crédito com base em um valor que está prestes a deixar de existir.

- **CA-004 (vincula RF-004):**
  - **Dado** um cliente com uma cobrança em aberto fora do período (será cancelada automaticamente) ou marcada por opção dentro dele
  - **Quando** a tela recalcula o valor em aberto
  - **Então** essa cobrança deixa de compor o valor em aberto exibido, antes de o operador decidir o destino da caução e do crédito

### RF-005 — Operador pode cancelar, por opção, cobrança dentro do período

Cobrança ou parcela dentro do período — que por padrão sobrevive ao encerramento — pode ser marcada pelo operador para cancelar mesmo assim, individualmente ou todas de uma vez através de um atalho. Cobranças bloqueadas (RF-003) nunca são marcadas, nem pelo atalho.

- **CA-005 (vincula RF-005):**
  - **Dado** três cobranças dentro do período, sendo uma delas bloqueada por já ter pagamento
  - **Quando** o operador aciona "cancelar todas elegíveis"
  - **Então** as duas elegíveis são marcadas para cancelar e a bloqueada permanece mantida, sem opção de ser marcada

### Regras de Negócio

- **RN-001** — Cobrança com qualquer valor já reduzido — seja por pagamento em dinheiro/gateway, seja por crédito do cliente aplicado — é imune a cancelamento por este fluxo, em qualquer circunstância, dentro ou fora do período, inclusive pelo atalho de marcação em lote (RF-005). É a mesma regra já aplicada quando o período do contrato é reduzido sem ser encerrado.
- **RN-002** — Cobrança cujo período de referência começa **depois** da data de encerramento escolhida é considerada "fora do período" e cancelada automaticamente (RF-002), salvo bloqueio por RN-001. Cobrança de período anterior ou que cruza essa data é "dentro do período": mantida por padrão, cancelável só por opção do operador (RF-005).
- **RN-003** — Cancelar uma cobrança neste fluxo — automaticamente ou por opção — reverte integralmente o que ela gerou financeiramente (o cliente deixa de dever aquele valor); não existe cancelamento parcial de uma cobrança.

### Requisitos Não Funcionais

Nenhum RNF novo além dos já vigentes na tela de encerramento (a mudança não introduz volume, latência ou concorrência de natureza diferente do que a tela já trata).

---

## 5. Dependências e Riscos

### 5.1 Dependências

- Depende da capacidade de cancelamento de cobrança emitida com reversão financeira, que já existe no produto e é usada hoje pela tela de Ajuste de Período do contrato — este PRD reaproveita essa mesma capacidade de produto para o fluxo de Encerramento, que hoje não a possui.

### 5.2 Riscos

- **Duas pessoas mexendo no mesmo contrato ao mesmo tempo** (ex.: um operador ajustando o período enquanto outro encerra) — raro, mas possível numa operação com múltiplos usuários. Mitigação: o sistema deve recusar a operação se, no instante de confirmar, a cobrança já não estiver mais no estado esperado (mesmo tratamento hoje dado ao Ajuste de Período).
- **Confusão entre "cancelar cobrança" e "estornar pagamento/crédito"** — operador tenta usar este fluxo para desfazer um recebimento ou um abatimento de crédito. Mitigação: RF-003 bloqueia e explica a diferença no momento do erro.

---

## 6. Aprovação

### 6.1 Questões abertas

- [ ] Nenhuma questão aberta.

### 6.2 Checklist mínimo

- [x] Sem `<!-- preencher -->` remanescente
- [x] Cada RF tem ≥1 CA
- [x] Personas com ≥1 US cada
- [x] Fluxo principal + erro principal documentados
- [x] PRD descreve produto (sem detalhes técnicos de implementação)

**Aprovado por:** Alan em 2026-09-17
