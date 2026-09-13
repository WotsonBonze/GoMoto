---
status: aprovado
versão: 1.0
modo: lite
autor: Alan (com agente IA)
data: 2026-09-12
related:
  - "[[Telas/Locações]]"
  - "[[PRDs/0004-locacao-e-cobrancas]]"
  - "[[PRDs/0006-cadastro-de-veiculos-revisao]]"
tags:
  - prd
  - prd-lite
  - km-locacao
  - locacoes
---

# PRD 0014 — Registro de KM na Locação

> 🟢 **Status: aprovado v1.0** (modo lite) em 2026-09-12. Passa a registrar o km do veículo na criação (km inicial) e no encerramento (km final) de cada locação. Próximo passo: gerar a Spec técnica (`/spec-generator obsidian-notes/PRDs/0014-registro-km-locacao.md`).

> **Por que lite?** Feature pequena (dois campos novos num fluxo já existente, sem entidade nova, sem multi-persona). A interação com o km atual do veículo entra como Regra de Negócio explícita, sem virar módulo à parte.

---

## 1. Visão Geral

### 1.1 Contexto e problema

Hoje a locadora não tem um retrato confiável de quantos km um veículo rodou durante um contrato específico. O sistema guarda apenas um único "km atual" do veículo, atualizado manualmente na tela de Manutenção — sem vínculo com qual locação estava em vigor naquele momento. Isso tem duas consequências: (1) não há como saber quanto um cliente específico rodou durante sua locação (relevante para desgaste do veículo, disputas de devolução e eventual cálculo de excedente), e (2) o km impresso no contrato de locação é apenas o "km atual" do veículo no instante em que o PDF é gerado — não necessariamente o km real de entrega da moto àquele cliente, podendo já estar desatualizado.

### 1.2 Resultado esperado

- Cada locação passa a guardar o km de entrega (início) e o km de devolução (encerramento) do veículo.
- O contrato impresso passa a refletir o km real de entrega, congelado no momento da criação da locação — não mais um valor que pode já estar desatualizado quando o contrato é (re)impresso.

---

## 2. Personas e User Stories

| Persona | Frequência |
|---|---|
| Operador | Diária (cria e encerra locações) |

- **US-001** — Como Operador, quero registrar o km do veículo ao criar e ao encerrar uma locação, para ter um retrato confiável de quanto o veículo rodou naquele contrato e manter o km do veículo sempre atualizado.

---

## 3. Fluxo

### 3.1 Caminho feliz

1. Operador inicia a criação de uma locação normalmente (cliente, veículo, condições).
2. Formulário exibe o campo "Km inicial", pré-preenchido com o km atual do veículo e editável.
3. Operador confirma o km inicial e conclui a criação da locação.
4. Sistema grava o km inicial na locação e atualiza o km atual do veículo para esse valor.
5. Ao devolver o veículo, Operador acessa o encerramento da locação e informa o "Km final".
6. Sistema valida o valor informado, grava o km final na locação, atualiza o km atual do veículo, e encerra o contrato.
7. A tela de detalhe da locação passa a exibir km inicial, km final e o km total rodado.

### 3.2 Erro principal

Operador informa um km (inicial ou final) menor que o km já registrado no veículo. Sistema recusa a operação e exibe mensagem indicando o km mínimo aceito, tanto na criação quanto no encerramento.

---

## 4. Requisitos e Critérios de Aceite

### RF-001 — Registrar km inicial na criação da locação

- **CA-001 (vincula RF-001):**
  - **Dado** um veículo com km atual 15.000
  - **Quando** o Operador cria uma locação informando km inicial 15.000
  - **Então** a locação é criada com km inicial 15.000

### RF-002 — Registrar km final no encerramento da locação

- **CA-002 (vincula RF-002):**
  - **Dado** uma locação ativa com km inicial 15.000
  - **Quando** o Operador encerra a locação informando km final 15.800
  - **Então** a locação é encerrada com km final 15.800 e passa a exibir "800 km rodados"

### RF-003 — Exibir km inicial, km final e km rodado no detalhe da locação

- **CA-003 (vincula RF-003):**
  - **Dado** uma locação encerrada com km inicial 15.000 e km final 15.800
  - **Quando** o Operador abre o detalhe da locação
  - **Então** vê os três valores (15.000 / 15.800 / 800 km)

### RF-004 — Km inicial da locação passa a ser a fonte do km impresso no contrato

- **CA-004 (vincula RF-004):**
  - **Dado** uma locação criada com km inicial 15.000
  - **Quando** o contrato dessa locação é gerado (na criação ou reimpresso depois)
  - **Então** o km exibido no PDF é 15.000, mesmo que o km atual do veículo já tenha mudado depois

### Regras de Negócio

- **RN-001** — Registrar km inicial ou km final atualiza o km atual do veículo para o valor informado.
- **RN-002** — Nenhum km informado (inicial ou final) pode ser menor que o km atual já registrado no veículo no momento do registro.
- **RN-003** — O km final de uma locação nunca pode ser menor que o km inicial da mesma locação.
- **RN-004** — Km inicial é obrigatório para concluir a criação da locação; km final é obrigatório para concluir o encerramento.

### Requisitos Não Funcionais

Nenhum requisito não funcional específico além dos já cobertos pelo padrão de tela existente (mensagens de erro claras, resposta imediata de validação).

---

## 5. Dependências e Riscos

### 5.1 Dependências

- [[Telas/Locações]] — telas de criação e encerramento afetadas.
- [[PRDs/0004-locacao-e-cobrancas]] — fluxo base de criação/encerramento que esta feature estende.
- [[PRDs/0006-cadastro-de-veiculos-revisao]] — dono original do conceito "km atual" do veículo, reaproveitado aqui.

### 5.2 Riscos

- Operador pode não ter o hodômetro em mãos no exato momento da entrega/devolução (ex.: entrega remota) e digitar um valor aproximado. Mitigação: nenhuma automação prevista nesta versão (sem leitura de hodômetro por hardware/OCR); o campo aceita edição manual e é responsabilidade do Operador.
- A trava de "não retroceder km" (RN-002) só se aplica aos pontos novos (criação/encerramento de locação). A atualização manual de km que já existe na tela de Manutenção continua sem essa trava — ver Questão Aberta abaixo.

---

## 6. Aprovação

### 6.1 Questões abertas

- [x] A trava de "não retroceder km" (RN-002) deve valer também para a atualização manual de km na tela de Manutenção? Hoje ela pode "voltar" o km mesmo depois de uma locação já ter avançado esse valor. — **adiado para vNext**, fora do escopo desta versão.

### 6.2 Checklist mínimo

- [x] Sem `<!-- preencher -->` remanescente
- [x] Cada RF tem ≥1 CA
- [x] Personas com ≥1 US cada
- [x] Fluxo principal + erro principal documentados
- [x] PRD descreve produto (sem detalhes técnicos de implementação)

**Aprovado por:** Alan em 2026-09-12
