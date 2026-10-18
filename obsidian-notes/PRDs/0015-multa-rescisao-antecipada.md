---
status: aprovado
versão: 1.0
autor: Alan (com agente IA)
data: 2026-09-12
adr: "[[decisions/0026-acerto-final-caucao-e-credito]]"
related:
  - "[[Telas/Locações]]"
  - "[[Banco de Dados]]"
tags:
  - prd
  - multa-rescisao-antecipada
  - locacoes
---

# PRD 0015 — Multa por Rescisão Antecipada de Contrato

> 🟢 **Status: aprovado v1.0** em 2026-09-12. Multa e prazo mínimo de contrato deixam de ser valores fixos da plataforma e passam a ser configuráveis por locação, com cobrança real no encerramento antecipado. Próximo passo: `/spec-generator obsidian-notes/PRDs/0015-multa-rescisao-antecipada.md`.

---

## 1. Visão Geral

### 1.1 Contexto

Hoje, o valor da multa por rescisão antecipada de contrato e o prazo mínimo de vigência são regras estáticas do sistema: um valor fixo de multa e um prazo mínimo que varia apenas pelo tipo de contrato (locação comum ou compra programada), iguais para todos os contratos da plataforma.

Quando o operador encerra uma locação antes do prazo mínimo, a tela de encerramento apenas **exibe um aviso** informando que a multa contratual seria aplicável — não existe nenhuma ação que gere a cobrança, nem forma de abatê-la da caução ou do saldo de crédito do cliente. Na prática, a multa nunca é efetivamente cobrada, apesar do sistema já saber identificar quando ela deveria se aplicar.

O sistema está em evolução contínua e precisa deixar de depender de valores e mensagens fixas no financeiro, dando ao operador controle real sobre a política contratual de cada locação.

### 1.2 Resumo executivo

- O valor da multa por rescisão antecipada e o prazo mínimo de contrato passam a ser configuráveis por locação individual, de forma opcional.
- A configuração pode ser feita na criação da locação ou adicionada/alterada depois, via edição, enquanto a locação estiver ativa.
- No encerramento antecipado (dentro do prazo mínimo configurado), o sistema exibe a multa aplicável e o operador decide, ali, se cobra ou não.
- Ao cobrar, o operador escolhe como quitar a multa — caução, saldo de crédito do cliente, cobrança em aberto, ou combinação entre elas — como uma decisão independente de qualquer outra dívida da locação.
- Locações criadas antes desta feature permanecem sem multa/prazo mínimo configurado; podem ser editadas para receber essa configuração.

### 1.3 Problema

Não é possível configurar o valor da multa nem o prazo mínimo por contrato, e mesmo quando a condição de multa é identificada no encerramento, não existe ação que efetivamente cobre o cliente por isso — a empresa fica sem proteção real contra devoluções antecipadas de veículo, que são um evento comum na operação, não uma exceção rara.

---

## 2. Glossário *(opcional)*

Nenhum termo novo. Para evitar ambiguidade com o conceito já existente de "multa" (infração de trânsito, módulo próprio), este PRD usa sempre o termo **"multa contratual"** ou **"multa por rescisão antecipada"** para se referir ao conceito desta feature.

---

## 3. Objetivos e Escopo

### 3.1 Objetivos de negócio

- Eliminar a dependência de valores fixos de multa/prazo mínimo no financeiro, permitindo que cada contrato carregue sua própria política.
- Tornar a multa por rescisão antecipada uma cobrança real e cobrável, não apenas um aviso informativo.

### 3.2 Objetivos do usuário

- Definir, na criação da locação, um valor de multa por rescisão antecipada e um prazo mínimo de contrato específicos para aquele contrato (ambos opcionais).
- Editar uma locação já existente para adicionar ou alterar essa configuração depois da criação.
- No encerramento antecipado, ver a multa aplicável e decidir, ali, se cobra ou não.
- Ao cobrar, abater o valor da multa da caução e/ou do saldo de crédito do cliente, com o que sobrar virando cobrança normal em aberto.

### 3.3 Métricas de sucesso / KPIs

- Toda rescisão antecipada de uma locação com multa configurada resulta em uma decisão explícita e registrada do operador (cobrar ou não cobrar) — nenhum caso passa em silêncio como hoje.
- Toda multa cobrada gera uma cobrança real e rastreável, com o abatimento de caução e/ou saldo de crédito refletido nela quando aplicável.
- Zero locações dependem de valor de multa ou prazo mínimo fixo pelo sistema — cada contrato carrega sua própria configuração (ou nenhuma, se o operador optar por não configurar).

### 3.4 Incluído em V1

- Campo de valor da multa (R$, fixo) e campo de prazo mínimo de contrato, opcionais, na criação da locação.
- Edição desses dois campos em uma locação já existente.
- Locações criadas antes da feature permanecem sem multa/prazo mínimo configurado (sem herdar os valores fixos atuais).
- No encerramento antecipado de uma locação com multa configurada, exibição da multa aplicável e oferta da decisão de cobrar ou não.
- Ao optar por cobrar: geração da cobrança da multa e possibilidade de abatê-la da caução e/ou do saldo de crédito do cliente; o valor não coberto vira cobrança normal em aberto.

### 3.5 Não Incluído / Não-objetivos (V1)

- **Multa como percentual ou progressiva** (ex.: % do valor do ciclo, ou reduzindo com o tempo) — V1 mantém multa como valor fixo em R$, mesmo formato de hoje. Motivo: não foi solicitado; manter simples.
- **Valor padrão de multa/prazo mínimo em nível de tenant/configurações** — adiado para vNext. Motivo: a configuração é livre e opcional por locação; um padrão de tenant é evolução natural, mas não foi pedido agora.
- **Diferenciação por tipo de contrato** (locação comum vs. compra programada) — não existe mais como regra do sistema; fica inteiramente a critério do operador em cada locação.

---

## 4. Stakeholders *(opcional)*

Dono único: Alan. Sem stakeholders externos.

---

## 5. Personas e User Stories

### 5.1 Personas

| Persona | Como interage | Frequência |
|---|---|---|
| Operador | Qualquer usuário do tenant que cria, edita e encerra locações — sem distinção de papel/aprovação para a decisão sobre a multa | Frequente (devolução antecipada de veículo é comum, não é caso raro) |

### 5.2 User Stories

- **US-001** — Como Operador, quero definir o valor da multa por rescisão antecipada e o prazo mínimo de contrato ao criar uma locação, para proteger a empresa contra devoluções antecipadas sem custo para o cliente.
- **US-002** — Como Operador, quero editar uma locação já existente para adicionar ou alterar essa configuração de multa/prazo mínimo, para poder aplicar essa proteção também a contratos que já estão em andamento.
- **US-003** — Como Operador, quero ver a multa aplicável ao encerrar uma locação antes do prazo mínimo e decidir, na hora, se cobro ou não, para ter flexibilidade quando a rescisão antecipada for amigável ou negociada.
- **US-004** — Como Operador, quero que a multa cobrada seja abatida automaticamente da caução e/ou do saldo de crédito do cliente, para não ter que cobrar separadamente algo que a empresa já tem em mãos.

---

## 6. Fluxos Funcionais

### 6.1 Fluxo principal

1. Operador cria uma locação e, opcionalmente, define o valor da multa por rescisão antecipada e o prazo mínimo de contrato.
2. A locação segue ativa normalmente.
3. O cliente decide devolver o veículo antes do prazo mínimo configurado.
4. Operador inicia o encerramento da locação (informa data de encerramento e km final, como já é feito hoje).
5. Como a data de encerramento cai dentro do prazo mínimo configurado, o sistema exibe a multa aplicável.
6. Operador decide cobrar a multa.
7. Operador escolhe como quitar a multa: abater da caução, abater do saldo de crédito do cliente, ou deixar virar cobrança em aberto — podendo combinar as opções.
8. Operador confirma o encerramento. O sistema gera a cobrança da multa, aplica os abatimentos escolhidos e encerra a locação.

### 6.2 Fluxos alternativos

- **A1 — Sem multa configurada**: a locação não tem multa/prazo mínimo definidos → o encerramento antecipado segue como hoje, sem nenhuma menção a multa.
- **A2 — Fora do prazo mínimo**: a locação tem multa configurada, mas o encerramento ocorre depois do prazo mínimo → nenhuma multa é exibida ou cobrada.
- **A3 — Operador opta por não cobrar**: dentro do prazo mínimo, o sistema exibe a multa aplicável, mas o operador decide não cobrar → o encerramento segue sem gerar cobrança de multa.
- **A4 — Configuração via edição**: uma locação já em andamento, criada sem multa/prazo mínimo, é editada para receber essa configuração — passa a valer a partir dali para um encerramento futuro.
- **A5 — Quitação combinada**: a multa é parcialmente coberta pela caução, parcialmente pelo saldo de crédito, e o restante (se houver) vira cobrança em aberto.

### 6.3 Fluxos de erro

- **E1 — Cobertura parcial**: caução e saldo de crédito, juntos, não cobrem o valor total da multa → o valor restante vira cobrança em aberto para o cliente pagar depois; o encerramento não é bloqueado por isso.
- **E2 — Locação já encerrada**: operador tenta editar a multa/prazo mínimo de uma locação que já foi encerrada → sistema recusa a edição (mesma regra hoje aplicada a outras configurações financeiras de contrato encerrado).
- **E3 — Falha parcial no encerramento**: o encerramento da locação é concluído, mas a geração da cobrança da multa (ou o abatimento na caução/crédito) falha por erro técnico → o sistema informa claramente qual parte falhou, sem deixar a operação ambígua para o operador.
- **E4 — Ação concorrente**: duas tentativas de encerrar a mesma locação ao mesmo tempo → apenas uma é aceita, a outra recebe erro claro.

---

## 7. Requisitos Funcionais

- **RF-001** — Sistema permite, na criação de uma locação, informar de forma opcional o valor da multa por rescisão antecipada e o prazo mínimo de contrato.
- **RF-002** — Sistema permite, em uma locação ativa, adicionar ou alterar o valor da multa e o prazo mínimo de contrato após a criação.
- **RF-003** — Ao iniciar o encerramento de uma locação com multa configurada, cuja data de encerramento cai dentro do prazo mínimo, o sistema exibe o valor da multa aplicável.
- **RF-004** — Sistema permite ao operador optar por cobrar ou não a multa exibida, antes de confirmar o encerramento.
- **RF-005** — Ao optar por cobrar, o sistema gera uma cobrança no valor da multa configurada, vinculada ao cliente e à locação encerrada.
- **RF-006** — No mesmo ato do encerramento, o sistema permite abater o valor da multa cobrada da caução da locação e/ou do saldo de crédito do cliente.
- **RF-007** — Quando a caução e o saldo de crédito, juntos, não cobrem o valor total da multa, o restante permanece como cobrança em aberto para o cliente.
- **RF-008** — Sistema impede alterar a configuração de multa/prazo mínimo de uma locação já encerrada.

---

## 8. Requisitos Não Funcionais

- **RNF-001** — A exibição da multa aplicável e a geração da cobrança correspondente não introduzem atraso perceptível no fluxo de encerramento de locação em relação ao comportamento atual (sem multa).
- **RNF-002** — A configuração, edição e decisão sobre a multa seguem o mesmo isolamento por tenant já aplicado a toda locação — um tenant nunca vê nem altera a configuração de multa de uma locação de outro tenant.

> RNF descreve qualidade percebida pelo usuário ou negócio. Mecanismos técnicos ficam na Spec.

---

## 9. Regras de Negócio

- **RN-001** — O prazo mínimo de contrato é contado a partir da data de início da própria locação, usando o valor configurado nela — não existe mais um valor fixo por tipo de contrato.
- **RN-002** — A multa só é aplicável quando a locação tem um valor de multa configurado **e** a data de encerramento cai antes do fim do prazo mínimo configurado.
- **RN-003** — Uma locação sem multa e/ou sem prazo mínimo configurado nunca exibe nem cobra multa no encerramento.
- **RN-004** — A decisão de cobrar ou não a multa é tomada no momento do encerramento e não pode ser desfeita ou alterada depois que o encerramento é confirmado.
- **RN-005** — Quando o operador decide cobrar a multa, o destino dela (caução, saldo de crédito do cliente, cobrança em aberto, ou combinação entre elas) é uma decisão específica para a multa, independente de qualquer outra cobrança em aberto que a locação já tenha.
- **RN-006** — A soma dos valores abatidos da caução e do saldo de crédito para a multa nunca pode exceder o valor da própria multa; e o valor abatido de cada fonte nunca pode exceder o saldo disponível dessa fonte.
- **RN-007** — A configuração de multa e prazo mínimo de uma locação não pode ser alterada depois que a locação é encerrada.
- **RN-008** — Toda decisão tomada sobre a multa (configuração, edição, cobrar/não cobrar no encerramento) fica registrada de forma consultável posteriormente, associada a quem a realizou.
- **RN-009** — Uma operação de encerramento que falha parcialmente (por exemplo, a locação é encerrada mas a cobrança da multa ou algum abatimento não é concluído) nunca deixa o estado ambíguo para o operador — o sistema informa exatamente o que foi concluído e o que não foi.
- **RN-010** — Apenas uma tentativa de encerrar a mesma locação pode ser concluída com sucesso; tentativas concorrentes são rejeitadas.

---

## 10. Critérios de Aceite

### CA-001 (vincula RF-001)
- **Dado** que o operador está criando uma locação
- **Quando** ele preenche o valor da multa e o prazo mínimo de contrato
- **Então** a locação salva carrega essa configuração

### CA-002 (vincula RF-001)
- **Dado** que o operador está criando uma locação
- **Quando** ele não preenche multa nem prazo mínimo
- **Então** a locação é criada sem essa configuração, sem nenhum valor padrão aplicado

### CA-003 (vincula RF-002)
- **Dado** uma locação ativa sem multa configurada
- **Quando** o operador a edita para adicionar valor de multa e prazo mínimo
- **Então** a configuração passa a valer para essa locação a partir dali

### CA-004 (vincula RF-002)
- **Dado** uma locação ativa já com multa configurada
- **Quando** o operador altera o valor ou o prazo mínimo
- **Então** a nova configuração substitui a anterior

### CA-005 (vincula RF-003)
- **Dado** uma locação com multa configurada e data de encerramento anterior ao fim do prazo mínimo
- **Quando** o operador inicia o encerramento
- **Então** o sistema exibe o valor da multa aplicável

### CA-006 (vincula RF-003)
- **Dado** uma locação com multa configurada e data de encerramento igual ou posterior ao fim do prazo mínimo
- **Quando** o operador inicia o encerramento
- **Então** nenhuma multa é exibida

### CA-007 (vincula RF-004)
- **Dado** que o sistema exibiu a multa aplicável
- **Quando** o operador escolhe não cobrar
- **Então** o encerramento prossegue sem gerar cobrança de multa

### CA-008 (vincula RF-004)
- **Dado** que o sistema exibiu a multa aplicável
- **Quando** o operador escolhe cobrar
- **Então** o sistema apresenta a decisão de destino da multa (caução/crédito/em aberto) antes de confirmar o encerramento

### CA-009 (vincula RF-005)
- **Dado** que o operador confirmou a decisão de cobrar a multa
- **Quando** o encerramento é concluído
- **Então** uma cobrança no valor da multa é criada, vinculada ao cliente e à locação

### CA-010 (vincula RF-006)
- **Dado** que a multa foi cobrada e a locação tem caução com saldo suficiente
- **Quando** o operador escolhe abater da caução
- **Então** o saldo da caução é reduzido no valor escolhido

### CA-011 (vincula RF-006)
- **Dado** que a multa foi cobrada
- **Quando** o operador escolhe abater parte do saldo de crédito do cliente
- **Então** o saldo de crédito é reduzido no valor escolhido

### CA-012 (vincula RF-007)
- **Dado** que a multa cobrada não foi totalmente coberta pelos abatimentos de caução e crédito escolhidos
- **Quando** o encerramento é confirmado
- **Então** o valor restante aparece como cobrança em aberto vinculada ao cliente

### CA-013 (vincula RF-008)
- **Dado** uma locação já encerrada
- **Quando** alguém tenta editar sua multa ou prazo mínimo
- **Então** o sistema recusa a alteração

---

## 11. Dependências e Riscos

### 11.1 Dependências

- PRDs relacionados: [[PRDs/0004-locacao-e-cobrancas]] (base do módulo de locação e cobranças), [[PRDs/0010-entrada-locacao]] (mesmo padrão de campo opcional configurável na criação), [[PRDs/0014-registro-km-locacao]] (última evolução da tela de encerramento).
- ADR existente relevante: [[decisions/0026-acerto-final-caucao-e-credito]] — define como caução e crédito do cliente são hoje liquidados no encerramento; esta feature estende esse acerto para incluir a multa como uma decisão de destino própria (RN-005).
- ADR a criar: esta feature muda a multa por rescisão antecipada de uma regra fixa da plataforma para uma configuração por contrato, e introduz uma nova cobrança que se soma ao acerto financeiro do encerramento. Será registrada uma ADR em `obsidian-notes/decisions/` cobrindo como essa nova cobrança se encaixa no modelo de razão e liquidação já existente.
- Nenhum sistema externo ou biblioteca nova envolvida.

### 11.2 Riscos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Operador esquece de configurar a multa em contratos que deveriam tê-la, perdendo a proteção pretendida (produto) | Média | Média | Fora do V1 — poderia virar um padrão de tenant ou lembrete futuro (já registrado como não-objetivo) |
| Nova cobrança de multa precisa se integrar aos mecanismos já existentes de emissão e liquidação (caução/crédito) sem quebrar as invariantes financeiras do razão (técnico) | Baixa | Alta | Reutilizar os padrões já validados e cobrir com testes automatizados antes de liberar |
| Locações já existentes ficam sem multa/prazo mínimo configurado (dados) | Baixa | Baixa | Já é o comportamento esperado (RN-003) — não é uma falha |
| Confusão entre "multa contratual" (esta feature) e "multa de trânsito" (módulo já existente, mesmo nome popular) (operacional) | Média | Baixa | Nomenclatura explícita na interface distinguindo os dois conceitos |

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

**Aprovado por:** Alan em 2026-09-12
