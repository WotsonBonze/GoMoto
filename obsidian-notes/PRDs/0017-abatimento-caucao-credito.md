---
status: aprovado
versão: 1.0
autor: Alan (com agente IA)
data: 2026-09-18
related:
  - "[[Telas/Locações]]"
  - "[[PRDs/0016-encerramento-retroativo-cobrancas]]"
  - "[[PRDs/0015-multa-rescisao-antecipada]]"
tags:
  - prd
  - abatimento-caucao-credito
  - locacoes
  - financeiro
---

# PRD 0017 — Distribuição dirigida de caução e crédito no encerramento

> 🟢 **Status: aprovado** em 2026-09-18. O operador passa a distribuir caução e crédito do cliente, dívida a dívida, entre todas as dívidas em aberto da locação — em vez do abatimento agregado e cego de hoje. Próximo passo: `/spec-generator obsidian-notes/PRDs/0017-abatimento-caucao-credito.md`.

---

## 1. Visão Geral

### 1.1 Contexto

No encerramento de uma locação, quando o cliente tem caução e/ou crédito acumulado, o sistema resolve o abatimento de forma agregada: soma todas as dívidas em aberto da locação em um único valor ("valor em aberto") e o operador escolhe devolver, reter ou abater esse total de uma vez. A tela não mostra quais cobranças específicas compõem esse valor, e o operador não pode dirigir o abatimento para uma dívida em particular.

Isso já vale mesmo para a multa por rescisão antecipada, que hoje tem um mecanismo próprio e separado de abatimento (PRD 0015) — uma exceção pontual que este PRD absorve num mecanismo único, válido para qualquer dívida da locação.

### 1.2 Resumo executivo

- O operador enxerga, individualmente, todas as dívidas em aberto da locação sendo encerrada — cobrança de ciclo, multa, entrada, despesa rateada, qualquer origem.
- Ele distribui a caução do cliente entre essas dívidas, dívida a dívida.
- Ele distribui o crédito do cliente entre essas dívidas, dívida a dívida — decisão independente da caução.
- O que sobrar de caução e/ou crédito depois da distribuição segue as opções que já existem hoje: manter ou devolver.
- A multa por rescisão antecipada deixa de ter um fluxo de abatimento próprio: vira só mais uma linha na lista de dívidas.

### 1.3 Problema

O abatimento é cego: o operador decide um valor agregado sem controle nem visibilidade de qual dívida está sendo paga com o dinheiro do cliente. Isso pode resultar em abatimento aplicado onde ele não pretendia (ex.: quitar uma cobrança que preferia manter em aberto para negociação, enquanto outra fica sem tratamento), e dificulta explicar ao cliente exatamente o que foi feito com a caução e o crédito dele.

---

## 2. Glossário

Nenhum termo novo. A feature reutiliza vocabulário já estabelecido no produto: caução, crédito do cliente, cobrança, dívida/valor em aberto.

---

## 3. Objetivos e Escopo

### 3.1 Objetivos de negócio

- Dar transparência e controle ao operador sobre como caução e crédito do cliente quitam dívidas específicas no encerramento, eliminando o abatimento cego.

### 3.2 Objetivos do usuário

- O operador enxerga cada dívida aberta da locação individualmente e decide, dívida a dívida, quanto de caução e quanto de crédito aplicar ali — duas decisões independentes, com visão do que já foi alocado e do que resta.

### 3.3 Métricas de sucesso / KPIs

- O operador consegue apontar exatamente qual dívida foi paga com qual parte da caução/crédito, sem ambiguidade — critério qualitativo: a tela nunca mais aplica um valor agregado sem que ele veja o destino.

### 3.4 Incluído em V1

- Lista de todas as dívidas em aberto da locação sendo encerrada — qualquer origem (cobrança de ciclo, multa, entrada, despesa rateada), não só cobrança de ciclo.
- Distribuição livre da caução entre essas dívidas — o operador informa quanto aplicar em cada uma.
- Distribuição livre do crédito entre essas dívidas — decisão independente da caução, mesmo mecanismo.
- Ao final da distribuição, o que sobrar de caução segue as opções já existentes: manter em custódia (se ainda houver dívida) ou devolver.
- Ao final da distribuição, o que sobrar de crédito segue as opções já existentes: manter como saldo do cliente ou devolver.
- Absorção do abatimento específico da multa por rescisão antecipada (PRD 0015) no mecanismo genérico.

### 3.5 Não Incluído / Não-objetivos (V1)

- Distribuir caução/crédito para dívidas de **outras locações** do mesmo cliente — decisão de produto (não é limitação técnica): fica restrito às dívidas desta locação.
- Estender esse tratamento a **outras telas** que hoje aplicam crédito/caução (ex.: ficha do cliente) — fica restrito à tela de Encerramento por enquanto.
- **Sugestão automática** de distribuição (ex.: quitar as mais antigas primeiro) — a distribuição é livre, o operador preenche do zero.

---

## 4. Stakeholders

Dono único: Alan. Sem stakeholders externos.

---

## 5. Personas e User Stories

### 5.1 Personas

| Persona | Como interage | Frequência |
|---|---|---|
| Operador | Distribui caução e crédito ao encerrar uma locação com saldo em aberto | Eventual (todo encerramento com caução e/ou crédito em jogo) |

### 5.2 User Stories

- **US-001** — Como Operador, quero ver todas as dívidas em aberto da locação que estou encerrando, para saber exatamente o que o cliente deve antes de decidir o que fazer com a caução e o crédito dele.
- **US-002** — Como Operador, quero distribuir a caução do cliente entre as dívidas específicas que eu escolher, para controlar exatamente o que está sendo quitado, em vez de um abatimento agregado e cego.
- **US-003** — Como Operador, quero distribuir o crédito do cliente entre as dívidas específicas que eu escolher, de forma independente da caução, pelo mesmo motivo.
- **US-004** — Como Operador, quero manter ou devolver o que sobrar de caução e de crédito depois da distribuição, para não perder as opções que já uso hoje.

---

## 6. Fluxos Funcionais

### 6.1 Fluxo principal

1. Operador abre a tela de Encerramento da locação e chega ao ponto em que hoje a tela mostra saldo de caução e/ou crédito do cliente (só aparece quando há saldo, como já acontece).
2. A tela lista todas as dívidas em aberto dessa locação — cobrança de ciclo, multa, entrada, despesa rateada, qualquer origem —, cada uma com seu valor devido.
3. Se há saldo de caução, o operador informa, dívida a dívida, quanto da caução aplicar em cada uma.
4. Se há saldo de crédito, o operador informa, dívida a dívida, quanto do crédito aplicar em cada uma — decisão independente da caução, mas nunca somando mais do que a dívida ainda deve depois do que a caução já abateu nela.
5. Terminada a distribuição, se sobrar caução e/ou crédito, o operador escolhe manter em custódia/como saldo do cliente ou devolver o restante — como já funciona hoje.
6. Operador confirma o encerramento. As dívidas são baixadas conforme distribuído; o saldo restante segue a decisão de manter/devolver.

### 6.2 Fluxos alternativos

- **Sem caução nem crédito:** a seção de distribuição não aparece — comportamento inalterado.
- **Há saldo (caução ou crédito), mas nenhuma dívida em aberto:** não há o que distribuir; o operador vai direto para manter/devolver o saldo total.
- **Operador não distribui nada:** equivale a manter tudo em aberto e decidir manter/devolver o saldo integral — mesmo resultado que "não abater" tem hoje.

### 6.3 Fluxos de erro

- **Alocação maior que a dívida da linha:** operador tenta aplicar, numa dívida de R$100, um valor de caução (ou crédito) maior que R$100. Sistema impede e mostra o limite daquela linha.
- **Soma das alocações maior que o saldo disponível:** operador distribui, entre várias dívidas, mais caução (ou mais crédito) do que o saldo total dele permite. Sistema impede de ultrapassar o saldo disponível.
- **Ação concorrente:** enquanto o operador distribui, outro processo já alterou uma dessas dívidas (ex.: pagamento chegou, outro operador já baixou). Ao confirmar, o sistema recusa e avisa que o estado mudou, sem aplicar nada pela metade.

---

## 7. Requisitos Funcionais

- **RF-001** — Ao chegar na etapa de destino de caução/crédito, o sistema lista cada dívida em aberto da locação individualmente — cobrança de ciclo, multa, entrada, despesa rateada, qualquer origem —, com o valor ainda devido de cada uma.
- **RF-002** — Durante a distribuição, o sistema mostra, para caução e para crédito separadamente, quanto do saldo já foi alocado às dívidas e quanto ainda resta por distribuir.
- **RF-003** — O operador informa, dívida a dívida, quanto do saldo de caução aplicar em cada uma.
- **RF-004** — O operador informa, dívida a dívida, quanto do saldo de crédito aplicar em cada uma — decisão independente da distribuição de caução.
- **RF-005** — O sistema nunca aceita, numa dívida específica, uma soma de caução + crédito alocados que ultrapasse o valor ainda devido daquela dívida.
- **RF-006** — O sistema nunca aceita que a soma de todas as alocações de caução ultrapasse o saldo de caução disponível do cliente.
- **RF-007** — O sistema nunca aceita que a soma de todas as alocações de crédito ultrapasse o saldo de crédito disponível do cliente.
- **RF-008** — Depois da distribuição, se sobrar caução, o operador escolhe mantê-la em custódia (contra dívida que ainda reste) ou devolvê-la — mesma decisão que já existe hoje, recalculada sobre o saldo pós-distribuição.
- **RF-009** — Depois da distribuição, se sobrar crédito, o operador escolhe mantê-lo como saldo do cliente ou devolvê-lo — mesma decisão que já existe hoje, recalculada sobre o saldo pós-distribuição.
- **RF-010** — Ao confirmar o encerramento, cada dívida listada é baixada exatamente pelos valores de caução e crédito que o operador alocou a ela — nunca um valor agregado sem relação com a distribuição feita na tela.

---

## 8. Requisitos Não Funcionais

Nenhum RNF novo além dos já vigentes na tela de Encerramento. A distribuição é cálculo local (feedback instantâneo, sem round-trip por dígito); a única validação server-side acontece na confirmação final, mesmo perfil de volume/latência/concorrência que a tela já trata hoje.

---

## 9. Regras de Negócio

- **RN-001** — A soma de caução + crédito alocados a uma dívida nunca ultrapassa o valor ainda devido dela — a dívida nunca é "sobre-paga" pela distribuição.
- **RN-002** — A soma de todas as alocações de caução nunca ultrapassa o saldo de caução disponível do cliente naquela locação.
- **RN-003** — A soma de todas as alocações de crédito nunca ultrapassa o saldo de crédito disponível do cliente.
- **RN-004** — Distribuir caução e distribuir crédito são decisões independentes entre si — alocar uma não obriga nem limita a outra, exceto pelo teto conjunto de RN-001 em cada dívida.
- **RN-005** — Só dívida com saldo em aberto maior que zero é candidata a receber alocação.
- **RN-006** — A confirmação reconfere o estado de cada dívida no servidor; se alguma mudou entre a leitura da tela e a confirmação (ex.: pagamento chegou nesse meio-tempo), a operação inteira é recusada — nada é aplicado pela metade.
- **RN-007** — A multa por rescisão antecipada, quando cobrada, passa a ser tratada como qualquer outra dívida da locação nesta distribuição — deixa de ter um fluxo de abatimento exclusivo e separado (que existe hoje, PRD 0015).

---

## 10. Critérios de Aceite

### CA-001 (vincula RF-001)

- **Dado** uma locação com cobrança de ciclo em aberto, multa por rescisão em aberto e despesa rateada em aberto
- **Quando** o operador chega na etapa de destino de caução/crédito
- **Então** a tela lista as três dívidas individualmente, cada uma com seu valor devido

### CA-002 (vincula RF-002)

- **Dado** que o operador já alocou parte da caução numa dívida
- **Quando** ele continua distribuindo
- **Então** a tela mostra, atualizado em tempo real, quanto da caução já foi alocado e quanto ainda resta

### CA-003 (vincula RF-003)

- **Dado** um cliente com R$500 de caução disponível e duas dívidas abertas
- **Quando** o operador aloca R$300 na primeira e R$200 na segunda
- **Então**, ao confirmar, as duas dívidas são baixadas exatamente nesses valores via caução

### CA-004 (vincula RF-004)

- **Dado** um cliente com crédito disponível e a mesma lista de dívidas
- **Quando** o operador aloca crédito numa dívida diferente da que recebeu caução
- **Então** as duas alocações valem de forma independente, cada uma no seu destino

### CA-005 (vincula RF-005)

- **Dado** uma dívida de R$100
- **Quando** o operador tenta alocar R$150 de caução nela
- **Então** o sistema recusa e indica que o máximo para aquela dívida é R$100 (descontado o que outra fonte já tiver alocado ali)

### CA-006 (vincula RF-006)

- **Dado** um saldo de caução de R$500
- **Quando** a soma das alocações do operador ultrapassaria R$500
- **Então** o sistema recusa a alocação que excede o saldo disponível

### CA-007 (vincula RF-007)

- **Dado** um saldo de crédito de R$200
- **Quando** a soma das alocações do operador ultrapassaria R$200
- **Então** o sistema recusa a alocação que excede o saldo disponível

### CA-008 (vincula RF-008)

- **Dado** que sobrou R$100 de caução depois da distribuição
- **Quando** o operador confirma o encerramento
- **Então** ele já escolheu, antes de confirmar, manter esse saldo em custódia ou devolvê-lo

### CA-009 (vincula RF-009)

- **Dado** que sobrou crédito depois da distribuição
- **Quando** o operador confirma o encerramento
- **Então** ele já escolheu manter como saldo do cliente ou devolver

### CA-010 (vincula RF-010)

- **Dado** uma distribuição de R$300 de caução na dívida A e R$150 de crédito na dívida B
- **Quando** o operador confirma
- **Então** a dívida A é baixada em R$300 via caução, a dívida B em R$150 via crédito, e nenhuma outra dívida é tocada

### CA-011 (vincula RF-010, RN-006)

- **Dado** que uma das dívidas foi quitada por outro caminho entre a tela carregar e o operador confirmar
- **Quando** ele confirma a distribuição original
- **Então** o sistema recusa a confirmação inteira e avisa que o estado mudou — nenhuma parte da distribuição é aplicada

### CA-012 (vincula RF-001, RN-007)

- **Dado** uma locação com multa por rescisão antecipada cobrada
- **Quando** a tela lista as dívidas em aberto
- **Então** a multa aparece como mais uma linha da lista, sujeita à mesma distribuição de caução/crédito das demais — sem seção própria separada

---

## 11. Dependências e Riscos

### 11.1 Dependências

- Reaproveita a capacidade de abater caução/crédito contra uma cobrança específica, que já existe no produto (hoje usada, por exemplo, no abatimento dedicado da multa por rescisão antecipada — PRD 0015). Esta feature generaliza esse mecanismo para qualquer dívida da locação, em vez de um caso especial só para a multa.
- Depende diretamente da Spec 0016 (encerramento retroativo), implementada na mesma tela pouco antes desta: aquela feature decide quais cobranças serão canceladas (automaticamente fora do período, ou por opção dentro dele). Esta feature precisa considerar essa interação — não faz sentido oferecer alocação de caução/crédito para uma dívida que já será cancelada na mesma confirmação.
- Absorve e substitui o fluxo de abatimento específico da multa por rescisão antecipada (PRD 0015, RF-006) — RN-007.
- Nenhum ADR previsto: não é uma decisão arquitetural nova, é a generalização de um mecanismo de abatimento que já existe e já é usado por mais de um fluxo do produto.

### 11.2 Riscos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Dívida que será cancelada (Spec 0016) aparece como candidata a receber caução/crédito, gerando abatimento sobre algo que vai deixar de existir | Média | Alto | A lista de dívidas desta feature exclui o que já está marcado para cancelar (automático ou por opção) na mesma confirmação |
| Estado de uma dívida muda entre a tela carregar e o operador confirmar (RN-006) | Baixa | Alto | Reconferência no servidor no momento da confirmação, mesmo padrão de recusa-sem-aplicar-pela-metade já usado no encerramento e no ajuste de período |
| Operador distribui errado e só percebe depois de confirmar | Média | Médio | Nada é persistido até o clique em Confirmar — o operador pode ajustar livremente a distribuição antes disso, com visão do que falta distribuir (RF-002) |
| Mudança do fluxo dedicado da multa para o genérico confunde quem já usa o sistema | Baixa | Baixo | Time de operação é pequeno (o próprio Alan); mudança comunicada no ato |

---

## 12. Questões Abertas + Aprovação Final

### 12.1 Questões Abertas

Nenhuma questão aberta — pronto para spec.

### 12.2 Checklist de validação

- [x] Sem ambiguidades abertas (§12.1 vazia ou explicitamente adiada)
- [x] Todos os RFs têm ao menos 1 CA correspondente
- [x] Todos os CAs apontam para um RF ou RN
- [x] Personas identificadas e cada uma com ≥1 US
- [x] Fluxos principais, alternativos e de erro documentados
- [x] Dependências e riscos mapeados
- [x] Frontmatter completo (sem `<!-- preencher -->`)
- [x] PRD descreve produto (problema, valor, regra de domínio, critério observável) — sem detalhes de implementação técnica (SQL, paths, pacotes, libs)

**Aprovado por:** Alan em 2026-09-18
