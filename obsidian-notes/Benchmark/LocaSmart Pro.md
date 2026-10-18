# Benchmark — LocaSmart Pro

> Análise de concorrente feita em **2026-10-10**, navegando em uma conta em **plano de teste** (`app.locasmartpro.com.br`, versão 9.7.1).
> Método: leitura de telas, menus, formulários e tooltips **sem salvar** (wizards abertos e cancelados). Itens marcados com 📜 vêm só do changelog oficial deles e **não foram vistos funcionando** (módulo bloqueado no plano de teste ou fora do alcance da navegação).
> Nenhum dado pessoal de cliente da conta foi registrado aqui.

Relacionado: [[GoMoto]] · [[Estado Atual]] · [[Roadmap]] · [[Fluxos de Negócio]]

---

## 1. Visão geral do produto

- **Público:** locadoras pequenas/médias de carro e moto (forte em moto/aplicativo — recorrência semanal é o padrão de fato).
- **Posicionamento:** "elimine planilhas" — ERP operacional + financeiro simples + cobrança via Asaas.
- **Stack percebida:** SPA web responsiva com navegação em **abas** (cada tela abre em uma aba interna), app nativo do locador e app do locatário (Android/iOS).
- **Ritmo:** changelog com ~40 versões entre jun/2025 e set/2026 — entregas quinzenais, muito focadas em "atalhos de operação".

### Planos e monetização

| Item | Preço | Observação |
|---|---|---|
| Plano PRO | a partir de R$ 79,90/mês | financeiro, contratos automáticos, manutenção/estoque, calendário de recebimentos, app do locatário |
| Plano AVANÇADO ("mais popular") | R$ 109,90/mês (de R$ 139,90) | + multas completas, vistorias, cobrança e baixa automática Asaas, assinatura digital, API, treinamento ao vivo |
| Trimestral/semestral/anual | desconto progressivo | 📜 v6.0.0 |
| Teste grátis | ~2 dias | contador visível no menu |
| **Meu Site** (add-on) | a partir de R$ 99,90/mês | site da locadora feito pela equipe deles, frota sincronizada |
| **LocaSmartCheck** (app de vistoria) | a partir de R$ 19,90/mês | produto separado, sincronizado |
| **Gestão de Risco** (add-on) | sob consulta | bloqueio/alerta automático sobre frota rastreada |
| **Afiliação** | 10% de cashback no Pix | da 1ª compra de cada empresa indicada; saque mínimo R$ 100 |

Recursos limitados por plano aparecem na própria UI ("Imagem — apenas para plano premium").

---

## 2. Mapa de funcionalidades (menu completo)

```
Dashboard
Cadastros
├── Manutenção: Serviços · Peças · Prestadores/Fornecedores · Usuário
├── Locação:    Veículos · Locatários · Contrato (modelos)
├── Financeiro: Categorias · Bancos
└── Unidades (filiais)
Movimentos
├── Operacional: Locações · Vistoria · Mapa de Veículos · Gestão de Risco
│               Manutenções (Registrar · Plano de Manutenção · Troca de Óleo · Estoque de Peças)
└── Financeiro:  Multa · Pagamento · Lançamento · Notas Fiscais
Relatórios: Geral · Financeiro · Auditoria
Afiliação · Meu Site · Central de Ajuda · Suporte · Planos
Minha Conta: Informações · Segurança · Assinatura · Configuração · Integrações · Notas Fiscais
```

Elementos transversais:
- **Acesso Rápido** (botão fixo no topo do menu): Criar Locação, Recebimentos, Mapa, Manutenção, Multas, Modelo de Contrato, Vistoria/Checklist, Troca de óleo, APP do Locatário.
- **Busca global** "Para onde deseja ir?".
- **Assistente LocaSmartPro** (IA de chat) em toda tela + botão "Pergunte à IA" dentro de cada formulário.
- **"Entenda como Funciona"** em cada wizard abre vídeo tutorial contextual.
- **Primeiros Passos** (checklist de onboarding com 7 etapas e % concluído), **Hub de Treinamento**, pesquisa de satisfação do suporte in-app.
- **Exportar** (Excel/PDF com escolha de colunas) e **Importar** (planilha) em quase toda listagem.
- **Atalho `Ctrl+Enter`** para avançar/salvar em todos os wizards.

---

## 3. Locação (núcleo)

### 3.1 Criação — wizard de 6 etapas

| Etapa | Campos / regras observadas |
|---|---|
| **1. Dados** | Veículo e Locatário — cada um com toggle **"Cadastrar novo" / "Existente"** (cadastro inline sem sair do fluxo). |
| **2. Contrato** | Km inicial · **Você receberá por**: Dia / Semana / Quinzena / Mês · **Prazo mínimo** (número + unidade Mês/Semana/Quinzena) · Fiador (texto livre) · ☐ **Locação em andamento** · ☐ **Opção de compra** · Opções avançadas: **Limite de quilometragem** |
| **3. Valores** | Valor do aluguel · Valor da caução · Data de retirada · Data do primeiro pagamento · Avançado: **Banco para recebimento** ("não transfere valores, só facilita a conciliação") · ☐ **Caução negociada** → parcelas da caução · **Lançamentos da locação** (até 5 lançamentos extras: descrição, valor, vencimento, categoria, status) · Observação · 📜 Comissão por filial sugerida/editável |
| **4. Juros e Multa** | Juros **por dia (R$ fixo/dia)** ou **ao mês** · Multa **Percentual** ou **Valor fixo** |
| **5. Lançamentos iniciais** | ☐ Já recebi o 1º aluguel · ☐ Já recebi a caução (dá baixa já na criação) |
| **6. Arquivo** | Upload do contrato assinado |

Regras e tooltips relevantes:
- **Locação em andamento** (migração de cliente antigo): "o prazo mínimo gera a previsão de pagamentos **a partir de hoje**, mas também serão criados pagamentos **desde o início da locação**" → importa o histórico retroativo de uma vez.
- **Opção de compra**: "comum em planos com promessa de compra; ao final do contrato o veículo passa a ser do locatário". No encerramento existe ☐ "vendi este veículo para o locatário".
- **Limite de km**: "No encerramento, será verificado automaticamente se o locatário excedeu este limite" (não ficou claro se gera cobrança).
- **Data de retirada**: "essencial para a inteligência do sistema controlar a quilometragem do veículo".
- **Caução parcelada**: quantidade de parcelas + 1º vencimento → tabela com vencimento, valor (editável) e ☐ **"Já pagou?"** por parcela. Changelog 9.7.0: forma de pagamento e parcelamento da caução escolhidos também no Asaas.
- **Edição** usa o mesmo wizard com 5 etapas (sem "Lançamentos iniciais"). Prazo exibido na lista como "22 meses e 14d".
- ⚠️ Na etapa 1 da criação, um veículo **já em locação ativa** apareceu disponível para seleção sem aviso (não testei salvar para ver se o backend bloqueia; o changelog 5.7.0 diz "possibilidade de locar mais de um veículo para o mesmo locatário", que é outra regra).

### 3.2 Pagamentos pré-gerados

- Ao criar, o sistema **gera todas as parcelas do prazo mínimo de uma vez** (na conta de teste: 122 pagamentos semanais de R$ 350, até 2028).
- "Regerar Pagamentos Previstos" refaz o cronograma.

### 3.3 Ações sobre a locação ("3 pontinhos")

| Ação | O que faz (observado) |
|---|---|
| Relatório Completo | **Laudo da locação** em PDF com seções configuráveis: dados, locatário, veículo, financeiro, multas, manutenções, trocas de óleo, vistorias com fotos |
| Encerrar Locação | Data de encerramento · Km final (obrigatório) · Gerar laudo antes · Observação · ☐ vendi o veículo ao locatário. **Regra: pagamentos agendados após a data de encerramento são excluídos; os demais permanecem.** Não há etapa de acerto de caução |
| Ativar/Inativar | suspende sem encerrar |
| **Substituir Veículo** | Novo veículo · data · km de saída do atual · km de entrada do novo → histórico de trocas |
| **Linha do Tempo** | feed cronológico unificado (pagamentos, eventos da locação, lançamentos) com filtros por tipo |
| Documentos | até 4 anexos por locação (aditivos etc.) |
| Contrato › | Gerar · Ver · Baixar · Assinar e copiar link para o locatário (Autentique) · Atualizar contrato assinado |
| Financeiro › Prolongar | "prolongar por mais N meses/semanas/quinzenas" → gera novas parcelas |
| Financeiro › Alterar dia de pagamento | a partir de data X, todas as pendentes mudam para o novo dia da semana/mês · ☐ **gerar pagamento da diferença de dias** (data + valor) |
| Financeiro › Atualizar valor do aluguel | a partir de data X, novo valor; **preserva pagamentos anteriores** |
| Financeiro › Consultar pagamentos | atalho filtrado |
| Financeiro › Vincular locação existente ao Asaas / Conciliar cobranças do Asaas / Conciliar banco | conciliação com gateway e banco |

---

## 4. Sistema de cobrança e financeiro

### 4.1 Dois objetos financeiros separados

| Objeto | Uso | Status |
|---|---|---|
| **Pagamento** | parcela de aluguel (e avulsos ligados a uma locação) | Pago · A Vencer · Em atraso |
| **Lançamento** | receita ou despesa genérica (caução, multa, manutenção, IPVA, seguro…) | Resolvido · A Vencer |

Não há razão contábil: caução é um **lançamento com categoria "CAUÇÃO"**. Categorias padrão: Estoque, Rastreador, Seguro, Outros, Licenciamento, Manutenção, Caução, IPVA, Multa (com cor; o tenant cria outras).

### 4.2 Tela de Pagamentos

- Filtros: busca (locação/locatário/veículo), período por **Vencimento ou Pagamento**, status, status da locação, atalho (Hoje, Esta semana, Quinzena, Este mês, Todos).
- **Totalizadores** condicionados ao filtro: Recebidos (R$ e qtd), A Vencer, Em Atraso, Locatários.
- **Ações em lote**: Baixar pagamentos · Cancelar pagamentos · Editar valor.
- Por linha: ✓ **Confirmação rápida** (baixa com 1 clique) · ✎ Edição e confirmação · **WhatsApp** (envia cobrança; exige telefone) · menu: Cancelar · Corrigir divergência (só se vinculado ao Asaas) · Excluir · **Parcelar pagamento** · Gerar recibo · Ir para / Emitir nota fiscal · Obter link da fatura (Asaas).
- **+ Novo Pagamento** (avulso): locação, valor, vencimento, descrição.

### 4.3 Baixa ("Edição e Confirmação de Pagamento")

- Valor recebido (mostra valor original) · data do recebimento · motivo/descrição.
- Opções avançadas:
  - ☐ alterar a data do vencimento original;
  - ☐ **gerar pendência** do valor não recebido ou juros → valor, vencimento e motivo da pendência (obrigatório) + ☐ "marcar o original como pago";
  - ☐ não contabilizar juros · ☐ não contabilizar multa (por pagamento);
  - banco (só para conciliação).
- Botões distintos: **Salvar edição** (não baixa) × **Confirmar pagamento** (baixa).

### 4.4 Parcelar um pagamento (renegociação)

Valor total a parcelar · quantidade · periodicidade (semanal, quinzenal, mensal) · 1º vencimento · descrição · ☐ sem juros em nenhuma parcela · ☐ sem multa em nenhuma parcela → **prévia** das parcelas com valor editável e flags por parcela → "Gerar N parcelas". Usado também para multas: "ao quitar todas as parcelas, a multa é marcada como paga" (📜 8.4.0).

### 4.5 Juros e multa

- Configurado **por locação** (não por tenant): juros em R$/dia ou % ao mês; multa % ou R$ fixo.
- No lançamento: "**Juros e multa são cobrados pelo Asaas**. Só valem para lançamentos de entrada, a vencer, ligados a uma locação que envia cobranças ao Asaas" → fora do Asaas, o cálculo é manual.

### 4.6 Lançamentos

Wizard de 5 etapas: **Dados** (valor, tipo Entrada/Saída, status, vencimento, data de pagamento, banco) → **Detalhamento** (categorias múltiplas, observação) → **Vínculos** (locação e/ou veículo opcionais + **Vendedor**, que alimenta a comissão) → **Juros e Multa** → **Adicionais** (☐ repetir em parcelas: 1ª data, recorrência, quantidade; arquivo; imagem só no premium). Ações em lote também.

### 4.7 Cobrança automática (Asaas) e meios

- Integração Asaas por **chave de API** (não OAuth). Por locação: "enviar esta locação para o Asaas" sem desligar a integração (9.7.0).
- Já integrado: alterar dia de pagamento, prolongar, juros/multa sincronizados, baixa manual com download da fatura, locações retroativas e diárias, caução com forma de pagamento e parcelamento.
- **Pix próprio**: chave Pix do tenant (CPF/CNPJ/e-mail/telefone/aleatória) gera QR Code e **Pix copia e cola** fora do Asaas.
- **Mensagem de cobrança WhatsApp configurável** (500 caracteres) com variáveis `{nome_locatario}`, `{valor}`, `{vencimento}`, `{pix_copia_cola}`, `{chave_pix}`.
- 📜 Assistente WhatsApp (bot) — ainda não liberado para todos.

### 4.8 Comissão

- 📜 **Comissão por usuário** (Cadastros › Usuário › aba Comissão), **por filial** (sugerida na locação) e **por locação** (valor único por contrato fechado, para toda a frota ou veículos específicos, apurado no início, no cadastro, no 1º pagamento ou no encerramento).
- Configuração: "**apurar comissão somente quando o pagamento for confirmado**" (Sim/Não; se não, apura na criação do lançamento).
- Relatório de comissões; receitas e fluxo de caixa podem exibir os valores com a comissão já descontada, por filial.

### 4.9 Bancos, notas fiscais e relatórios

- **Bancos** (apelido, banco, código, agência/conta, tipo): servem só para conciliação manual, sem integração.
- **NFS-e** (beta): certificado A1 (.pfx), padrão nacional, código IBGE, inscrição municipal, regime de tributação; emissão a partir do pagamento.
- **Relatórios financeiros**: Despesas · Receitas · Fluxo de caixa · Comissões (filtro por vencimento ou pagamento, por filial; exportação Excel/PDF).
- **Relatórios gerais**: Manutenções por veículo · Locações por período · Veículos · Laudo da locação.

---

## 5. Demais módulos

### Locatário
- Wizard: **Identificação** (nome, tipo de documento CPF/CNPJ, documento, RG, vencimento da CNH, número da CNH, **km médio/dia**) → **Contato** (e-mail, telefone obrigatório, telefone reserva; avançado: **cartão de crédito**: titular, CPF/CNPJ, bandeira, 4 últimos dígitos, validade) → **Endereço** (CEP com autopreenchimento) → **Documento**.
- **Preencher pela CNH**: foto ou PDF → IA preenche nome, CPF, RG e CNH para conferência.
- Pessoa jurídica suportada; importação por planilha; login do app criado em "Locatários › 3 pontinhos › Login no APP".

### Veículo
- Placa, marca, modelo, ano, vencimento do licenciamento, status, observação, chassi, renavam, cor, valor, **FIPE**.
- **Autopreenchimento de marca, modelo e ano pela placa** + consulta FIPE (📜 7.6.0); inativar veículo; importação por planilha; anexos.
- Botão "Sincronizar" (com o LocaSmartCheck).

### Modelo de contrato
- Início: **"Usar um contrato que já tenho"** (Word ou PDF, até já preenchido; a **IA identifica os dados do cliente e do veículo e monta o modelo**) ou "Começar do zero".
- Editor DOCX no navegador com tour, "Trocar documento" e "Baixar DOCX".
- Variáveis: **Locatário** (nome, documento, endereço, RG, CNH, telefone, e-mail) · **Contrato** (valor do aluguel, caução, dia de pagamento, km inicial, prazo mínimo, periodicidade, data de retirada, início dos pagamentos, fiador, soma aluguel+caução, data de encerramento, data atual) · **Veículo** (placa, marca, modelo, ano, chassi, renavam, cor, valor, FIPE) · **Manuais** (observação e negociação, digitadas na hora de gerar) · **Personalizadas** (o tenant cria).
- ⚠️ O "Avançar" da 1ª etapa (título e descrição) **já grava o modelo** antes do "Salvar" do editor. Foi assim que este benchmark criou sem querer um modelo vazio "X" na conta de teste.

### Multas
- Wizard: **Identificação** (nº RENAINF, auto de infração, código da infração, descrição) → **Valores e datas** (data/hora do cometimento, vencimento, valor, status Paga/A Vencer/Cancelada/Vencida, ☐ não gerar lançamento financeiro, banco) → **Participantes** (☐ real infrator indicado, veículo e **locação sugerida automaticamente** pelo veículo + data).
- "Cobrar multa do locatário" com parcelamento; botão "Ver financeiro" mostra os lançamentos vinculados.

### Manutenção, OS e estoque
- Wizard: **Tipo** (Manutenção ou **Ordem de Serviço**) → Veículo → Peças → Serviços → Informações → Arquivos.
- OS: criar, listar, editar, cancelar, gerar PDF e **converter em manutenção**.
- Cadastros de serviços, peças (com importação por planilha) e prestadores/fornecedores.
- **Estoque de peças**: quantidade, valor, total, fornecedor, **identificador** (ex.: "Prateleira A") e contador "sem estoque"; a entrada de peça pode gerar o lançamento de despesa automaticamente.
- Manutenção parcelável e com data de pagamento própria.
- **Troca de óleo** como registro dedicado (locação, hodômetro, data).
- **Plano de manutenção** preventiva e **mensagem de manutenção**: dependem do rastreador.

### Rastreamento (AgilLock, produto da casa)
- Mapa de veículos, **hodômetro em tempo real**, **bloqueio/desbloqueio** remoto, plano de manutenção disparado pelo hodômetro.
- **Gestão de Risco** (add-on): eventos automáticos de bloqueio e alerta sobre a frota rastreada.

### Vistoria
- Tela simples (locação, hodômetro, data, observação, status) + recibo de vistoria. A vistoria completa (checklist personalizado, fotos, assinatura, PDF) é vendida à parte no **LocaSmartCheck**.

### App do locatário
- Histórico de pagamentos com Pix copia e cola, contrato, **envio de vistorias** e **registro de trocas de óleo** pelo próprio cliente.

### Organização e governança
- **Unidades (filiais)**: nome, CNPJ, endereço, telefone; "divisão do sistema em empresas" (9.0.0).
- **Usuários**: Informações → **Permissões** → Comissão; administrador sim/não; ninguém edita o próprio usuário.
- **Auditoria**: data/hora, usuário, **IP**, tela, ação e chave primária; filtros por usuário, ação, tela e período, ou busca por ID da entidade; exportável.
- **Assinatura digital**: Autentique (chave de API + e-mail do remetente).

### Dashboard
- Filtro de período (semana, mês, 15 dias, 30 dias, ano, personalizado) aplicado a todos os cards.
- Cards: locações ativas e encerradas, veículos disponíveis e em locação, manutenções, investido em veículos, multas, recebimentos a vencer, concluídos e em atraso, despesas resolvidas, a vencer e em atraso, **diferença entre entradas e saídas**, vistorias, trocas de óleo. **Cada card leva à tela já filtrada.**
- **Calendário de recebimentos** (pago, a vencer, em atraso) · gráficos de **faturamento, custo e lucro por veículo** · por origem e por status (clicáveis) · totalizador por tipo de veículo.

---

## 6. Comparação com o GoMoto

Legenda: ✅ temos equivalente ou melhor · 🟡 temos parcial · ❌ não temos.

| Capacidade | LocaSmart | GoMoto |
|---|---|---|
| Ledger contábil com contrapartida, saldo derivado | ❌ (pagamento + lançamento soltos) | ✅ ADR 0024/0027 |
| Acerto final de caução e crédito no encerramento | ❌ (encerrar só apaga parcelas futuras) | ✅ ADR 0026 / Spec 0017 |
| Garantia de 1 veículo = 1 locação ativa | ⚠️ não vista | ✅ ADR 0036, no banco |
| Encargo por atraso calculado pelo sistema em qualquer gateway | ❌ (só via Asaas) | ✅ ADR 0028/0038 |
| Multi-gateway (MP, Cora, InfinitePay, Asaas) | ❌ só Asaas | ✅ ADR 0030 |
| Ajuste de período (dia, valor, prolongar) | ✅ três ações separadas | ✅ `/ajustar` único (ADR 0035) |
| Diferença de dias ao mudar o vencimento | ✅ opcional, valor digitado | 🟡 conferir se `/ajustar` gera o pro rata |
| OCR de CNH e multa por IA | ✅ CNH | ✅ CNH + multa (ADR 0023) |
| Multa NA/NP, locação sugerida pelo veículo + data | ✅ | ✅ PRD 0013 |
| Vistoria com checklist e fotos | 🟡 produto separado pago | ✅ Spec 0009 |
| Plano de manutenção preventiva | 🟡 só com rastreador | ✅ PRD 0003 |
| Manutenção registrada pelo cliente no app | 🟡 só troca de óleo e vistoria | ✅ |
| Fila de espera | ❌ | ✅ |
| Auditoria | ✅ com IP e filtros | 🟡 `logAction` sem tela de consulta equivalente |
| **Parcelar/renegociar uma cobrança** | ✅ com prévia e "sem juros/sem multa" | ❌ (`charges.installment_*` existe no schema, sem uso) |
| **Caução parcelada** com "já pagou?" | ✅ | 🟡 a verificar |
| **Ações em lote** em cobranças | ✅ baixar, cancelar, editar valor | ❌ |
| **Totalizadores** que seguem o filtro | ✅ | 🟡 |
| **Template de cobrança WhatsApp** com variáveis (+ Pix copia e cola) | ✅ | 🟡 link `wa.me` sem template por tenant |
| **Recibo de pagamento** em PDF | ✅ | ❌ |
| **Laudo da locação** em PDF | ✅ seções configuráveis | ❌ |
| **Linha do tempo** da locação | ✅ | 🟡 histórico de status (ADR 0011), sem feed unificado |
| **Substituir veículo** na locação | ✅ com km de saída/entrada | ❌ |
| **Limite de km** checado no encerramento | ✅ | ❌ |
| **Locação retroativa** ("em andamento") | ✅ gera o passado + futuro | ❌ a confirmar |
| **Importar** clientes e veículos por planilha | ✅ | ❌ |
| **Exportar** listagens em Excel/PDF com escolha de colunas | ✅ | ❌ (no backlog) |
| Dados do veículo pela **placa** (marca/modelo/ano/FIPE) | ✅ | 🟡 campo FIPE manual; parser de CRLV |
| **Contrato a partir de DOCX existente via IA** | ✅ | 🟡 modelos `.docx` com variáveis fixas |
| Variáveis manuais e personalizadas no contrato | ✅ | ❌ |
| **Assinatura digital** | ✅ Autentique | ❌ (no backlog) |
| **Comissão** (usuário, filial, locação) | ✅ | ❌ |
| **Filiais/unidades** | ✅ | ❌ |
| **OS + estoque de peças** que gera despesa | ✅ | ❌ (no backlog) |
| **NFS-e** | 🟡 beta | ❌ |
| Rastreador: bloqueio, hodômetro, mapa | ✅ AgilLock | ❌ mapa simulado |
| Bloqueio automático por inadimplência | ✅ add-on | ❌ |
| Calendário de recebimentos e lucro por veículo | ✅ | 🟡 tela ROI do Veículo |
| Onboarding guiado, vídeo por tela, assistente de IA | ✅ | ❌ |
| Site da locadora com frota em tempo real | ✅ add-on | ❌ |
| Programa de afiliados | ✅ | ❌ |

---

## 7. O que vale trazer para o GoMoto

Priorizado por **valor para o operador ÷ esforço**, considerando que o núcleo financeiro do GoMoto já é mais sólido. Toda escrita de dinheiro segue as regras de [[Estado Atual#🔒 Invariantes de dinheiro no banco, não no código|invariante no banco]].

### P1 — ganho rápido, operação diária

1. **Renegociar/parcelar cobrança.** Uma cobrança em aberto vira N cobranças (semanais, quinzenais ou mensais), com prévia editável e opção "sem juros/sem multa" por parcela. O schema já tem `installment_number/count`. Precisa ser um RPC transacional que cancele a original e crie as filhas, com o mesmo total no razão. Serve para aluguel, multa repassada e caução.
2. **Ações em lote em Cobranças**: baixar, cancelar e reajustar valor das selecionadas. Cada item passa pelo mesmo RPC unitário, sem um caminho paralelo.
3. **Template de cobrança WhatsApp por tenant**, com variáveis `{nome}`, `{valor}`, `{vencimento}`, `{pix_copia_cola}` e `{link_pagamento}`, usando o código já gerado pelo gateway eleito. É o atalho que o operador de moto mais usa.
4. **Totalizadores que seguem o filtro** (recebido, a vencer, em atraso, nº de clientes) no topo de Cobranças e Despesas, lidos das views agregadas (ADR 0025).
5. **Recibo de pagamento em PDF** (logo do tenant, valor, referência, forma) disponível no cockpit e no app do cliente.
6. **Atalhos de período** (hoje, esta semana, quinzena, mês) e o **filtro por vencimento ou por pagamento** nas listagens financeiras.

### P2 — regras de negócio que faltam

7. **Substituição de veículo na locação** (moto quebrou ou foi recolhida): uma operação atômica que fecha o vínculo do veículo antigo e abre o do novo, registra km de saída e entrada e mantém o histórico de trocas. Precisa respeitar a invariante 1 veículo = 1 locação (ADR 0036) na mesma transação.
8. **Limite de km contratual**: campo na locação. No encerramento, comparar com o km final e **gerar a cobrança do excedente** por R$/km. O concorrente só avisa; podemos ir além.
9. **Locação retroativa** para migrar clientes de planilha: criar a locação com início no passado, gerando as cobranças passadas como "já pagas" ou em aberto conforme a escolha do operador, e o futuro normalmente. Reduz a barreira de entrada de quem vem do concorrente.
10. **Caução parcelada** na criação, com "já pagou?" por parcela (verificar o que o fluxo atual já cobre).
11. **Lançamentos iniciais na criação**: marcar "1º aluguel e caução já recebidos" na própria criação, em vez de dar baixa depois.
12. **Linha do tempo da locação**: feed único com cobranças, pagamentos, encargos, vistorias, manutenções, multas e mudanças de status, montado a partir de `audit_logs`, do histórico de status e do razão. Só leitura.
13. **Laudo da locação em PDF** com seções escolhidas, para encerramento, disputa ou venda do veículo.

### P3 — módulos novos (cada um pede PRD próprio)

14. **Comissão de vendedor**: por usuário e por locação, apurada em um gatilho configurável (criação, 1º pagamento ou encerramento) e opção "só quando pago". No nosso modelo vira um *payable* para o vendedor no razão.
15. **Contrato**: importar o DOCX que a locadora já usa e deixar a IA sugerir as variáveis (reaproveita a infra da ADR 0023). Somar **variáveis manuais** (observação, negociação) e **personalizadas**. Depois, **assinatura digital** (Autentique ou similar).
16. **Importação por planilha** (clientes, veículos) e **exportação** Excel/PDF com escolha de colunas.
17. **Consulta pela placa** (marca, modelo, ano e FIPE) no cadastro do veículo.
18. **OS + estoque de peças**: a OS converte em manutenção e a entrada de peça gera o payable.
19. **Filiais/unidades** dentro do tenant: pede ADR, porque mexe em RLS e em relatórios.

### P4 — diferenciação e crescimento

20. **Integração com rastreador**: hodômetro real alimentando o plano de manutenção por km e o limite de km, **bloqueio remoto** e bloqueio automático por inadimplência, como política do tenant e com confirmação humana. Para locação de moto por aplicativo, é o recurso de maior valor percebido.
21. **Onboarding guiado** ("Primeiros passos" com % concluído) e **ajuda contextual** por tela.
22. **Vitrine pública da frota** (site da locadora com disponibilidade em tempo real), como upsell.
23. **Programa de indicação** entre locadoras.

### O que NÃO copiar

- **Parcelas do prazo inteiro geradas de uma vez** (122 registros semanais) e **apagadas no encerramento**. O GoMoto já decidiu isso conscientemente (ADR 0009) e trata o encerramento com acerto de caução e crédito.
- **Juros e multa só valendo quando o gateway cobra.** No GoMoto o encargo é regra do sistema e vale em qualquer meio (ADR 0028/0038).
- **Caução como "lançamento de categoria"**: perde a natureza de passivo. No GoMoto ela já é dinheiro de terceiro, com devolução e abatimento.
- **"Confirmação rápida" de pagamento com 1 clique, sem confirmação**: arriscado. Se adotarmos, que seja pelo mesmo RPC com idempotência.
- **"Banco" só como etiqueta de conciliação**: no GoMoto, se entrar, deve ser uma conta do razão (subconta de `caixa_e_bancos`).
- **Wizard que grava no "Avançar"** antes do salvar final (bug visto no modelo de contrato).

---

## 8. Próximos passos sugeridos

- Escolher de 3 a 5 itens de P1/P2 e abrir PRDs (`prd-creator`, modo lite para P1).
- Confirmar no código os itens marcados "a verificar": pro rata em `/ajustar`, caução parcelada e locação retroativa.
- Se o rastreador (P4.20) entrar no radar, levantar fornecedores de API de rastreamento para moto antes do PRD.

#benchmark #concorrente #produto
