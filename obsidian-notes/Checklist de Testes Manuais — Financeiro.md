# Checklist de Testes Manuais — Módulo Financeiro

Roteiro para validar o financeiro inteiro clicando na tela, sem depender da
suíte automatizada. Cada caso tem **o que fazer** e **como saber que deu certo**.

Quando um caso disser "conferir no razão", a checagem é na tela de **DRE** ou
**Painel financeiro**.

A exceção é o **saldo de caixa**: não existe tela para ele, e isso é escolha de
escopo — o produto registra valores e produz relatório gerencial, não faz
controle de caixa. Os poucos casos que precisam do caixa usam o terceiro atalho
abaixo.

---

## Como usar

- Marque `[x]` conforme for validando.
- **Um caso falhou?** Anote o número, o que apareceu e o que era esperado. Não
  siga adiante no mesmo bloco: casos posteriores costumam depender do anterior.
- Os blocos são **sequenciais dentro de si** e independentes entre si. Dá para
  parar no fim de qualquer bloco.
- Valores são sugestões. Se mudar, ajuste as conferências proporcionalmente.

### Três atalhos que servem ao roteiro inteiro

**Antecipar a emissão.** O critério do job é `period_start <= hoje + lead_days`
— o INÍCIO do período, não o vencimento. O segundo parâmetro abre essa janela,
para não esperar dias entre um caso e outro:

```bash
# Emite tudo que começa nos próximos 7 dias
docker exec -i supabase_db_GoMoto psql -U postgres -d postgres \
  -c "SELECT fn_run_billing_emission('manual', 7);"
```

**Conferir o caixa.** Sem tela, sai do razão. Rode antes e depois do caso e
compare — positivo é dinheiro que entrou, negativo é dinheiro que saiu:

```bash
docker exec supabase_db_GoMoto psql -U postgres -d postgres \
  -c "select coalesce(sum(amount_signed),0) as caixa
        from financial_entries where account_code = 'caixa_e_bancos';"
```

**Não rode a suíte automatizada no meio do roteiro.** Ela faz login com o mesmo
usuário do `.env.test` e **derruba a sua sessão no navegador**. Rode antes ou
depois, nunca durante.

### Preparação

- [x] **P1.** Banco limpo (`pnpm db:reset`) e login feito.
- [x] **P2.** Anote o **caixa** pelo atalho acima. Vários casos comparam contra
      este ponto de partida.
- [x] **P3.** Escolha uma moto disponível e um cliente. Use os mesmos em todo o
      roteiro — assim os relatórios por cliente e por veículo ficam legíveis.

---

## Bloco 1 — Abertura da locação

### 1.1 Criar locação semanal com caução e entrada

- [x] Em **Locações → Nova locação**, crie: ciclo **Semanal**, valor **R$ 350**,
      caução **R$ 500**, entrada **R$ 200**, início hoje, 3 meses.

**Verificar:**
- [x] A locação aparece em **Locações** com status ativo.
- [x] A moto sai da lista de disponíveis (tente abrir outra locação: ela não
      deve ser oferecida no seletor).
- [x] Em **Cobranças**, existem cobranças de **Caução R$ 500** e
      **Entrada R$ 200**.
- [x] Na aba **financeira** da locação, a seção **Cronograma contratado** lista
      todas as parcelas semanais de R$ 350 — a primeira pode ser menor (pro
      rata) — todas com situação **A emitir**.
- [x] Os três totais dessa seção batem: **Total contratado** = soma das parcelas,
      **Já emitido** = R$ 0,00 num contrato recém-aberto, **A emitir** = o total.

> **Cronograma ≠ Cobranças.** O cronograma é o que o contrato PREVÊ; a seção
> Cobranças mostra o que já virou documento. Num contrato novo só caução e
> entrada aparecem em Cobranças — as parcelas ainda não foram emitidas.

> **Por que importa:** caução e entrada parecem iguais e não são. Caução é
> dinheiro do cliente que volta; entrada é receita da empresa.

### 1.2 A caução não pode virar receita

- [x] Abra **DRE** no mês corrente.

**Verificar:**
- [x] A **Receita bruta** inclui os **R$ 200** da entrada.
- [x] A **Receita bruta NÃO inclui os R$ 500** da caução.

### 1.3 Emissão da parcela semanal

A emissão roda sozinha às 9h todo dia (pg_cron chamando
`fn_run_billing_emission`). Para não esperar, force pelo terminal:

```bash
# Emite exatamente como o cron emitiria hoje
docker exec -i supabase_db_GoMoto psql -U postgres -d postgres \
  -c "SELECT fn_run_billing_emission('manual');"
```

- [x] Rode o comando acima.

**Verificar:**
- [x] A parcela aparece em **Cobranças** com o valor do cronograma.
- [x] Em **Cobranças**, o total "A receber" subiu exatamente pelo valor da
      parcela.
- [x] A linha do cronograma correspondente saiu de *agendada* para *emitida*.

### 1.4 Emitir duas vezes não duplica

- [x] Rode o **mesmo comando** de novo, sem que nova parcela tenha começado.

**Verificar:**
- [x] **Nenhuma cobrança nova** foi criada.
- [x] O total "A receber" não mudou.

---

### 1.5 Contrato retroativo com caução/entrada já pagas

- [x] Crie uma locação com **data de início no passado** (ex.: 30 dias atrás),
      caução R$ 500 e entrada R$ 300, ambas com "já foi paga" marcada.
- [x] Confira no preview a data de vencimento das linhas Caução e Entrada.

**Verificar:**
- [x] As duas cobranças nascem com situação **Paga**, devido R$ 0,00.
- [x] O vencimento gravado é a **data do pagamento** — a mesma que o preview
      mostrou —, não a data de início do contrato.
- [x] Nenhuma delas tem item "Encargo por atraso".
- [x] **A caução não virou receita, a entrada virou.** No **DRE**, a linha
      *Receita bruta* do mês cresce **R$ 300,00** — só a entrada. Os R$ 500,00
      da caução não aparecem em nenhuma linha do DRE.
- [x] Na locação, aba **Financeiro**, seção *Movimentações de caução*: a linha
      mostra **Tipo "Caução cobrada"**, o valor de R$ 500,00 e o **Motivo** com
      o número da cobrança. Nenhuma dessas colunas pode sair em branco.

> Por quê: caução é dinheiro do cliente que a empresa segura e um dia devolve —
> credita `caucoes_a_devolver`, conta de **passivo**, que não tem linha de DRE.
> Entrada é receita não reembolsável — credita `receita_locacao`, que entra em
> *Receita bruta* e na base de imposto. É a diferença entre as duas, e o DRE é
> onde ela fica visível sem abrir o banco.

> Emitidas com `due_date = start_date`, nasciam vencidas: o recebimento
> realizava o encargo ANTES de alocar, e a alocação — fixa no principal —
> deixava o encargo descoberto. Quem acabara de dizer "está pago" via
> "Total R$ 514,79 · Pago R$ 500,00 · Devido R$ 14,79 · Vencido", crescendo
> todo dia. Documento que nasce quitado não está atrasado.

## Bloco 2 — Recebimento

### 2.1 Pagamento total

- [x] Abra a cobrança da caução (R$ 500) → **Registrar pagamento**, valor cheio,
      forma **PIX**.

**Verificar:**
- [x] A cobrança passa a **Paga**, com "R$ 0,00 a pagar".
- [x] O pagamento aparece listado na própria cobrança, com data e forma.
- [ ] Se você escreveu algo em **Observações** no modal, o texto aparece
      **inteiro** na coluna *Observação* do bloco **Pagamentos** — inclusive
      observação longa, de mais de uma linha. Ela era cortada em 200px, o que
      escondia justamente a explicação que valia a pena escrever.
- [x] Em **Cobranças**, o card **Recebido** subiu R$ 500 — e declara
      *"Inclui R$ 500,00 de caução"*.
- [x] Em **DRE**, a receita **não** subiu (caução é passivo).

### 2.2 Pagamento parcial

- [x] Na parcela semanal de R$ 350, registre pagamento de **R$ 150**.

**Verificar:**
- [x] A cobrança continua **Em aberto**, mostrando **R$ 200,00 a pagar**.
- [x] O valor de face segue R$ 350 — pagamento parcial não reduz o documento.
- [x] Em **Cobranças**, o card **Recebido** subiu R$ 150.

### 2.3 Completar o pagamento

- [x] Registre os **R$ 200** restantes.

**Verificar:**
- [x] A cobrança passa a **Paga**.
- [x] Aparecem **dois** pagamentos na cobrança, não um de R$ 350.

### 2.4-b Fração de centavo

- [x] No modal de recebimento, tente digitar **446,83000000000000999999** e
      depois **446,836** numa cobrança de R$ 446,83.

**Verificar:**
- [x] O campo **corta na segunda casa** — não aceita a terceira.
- [x] Nenhuma cobrança fica com valor devido **negativo**.

```sql
-- Nenhuma cobrança pode ter saldo negativo, nunca
docker exec supabase_db_GoMoto psql -U postgres -d postgres \
  -c "select charge_number, open_amount from charge_balances where open_amount < 0;"
```

> `type="number"` com `step="0.01"` só é validado em submit de formulário
> NATIVO, que a tela não usa: o campo aceitava a terceira casa. O banco guarda
> `NUMERIC(14,2)` e arredonda calado — 446,836 virava 446,84 e a cobrança
> terminava devendo −0,01, paga a mais sem ninguém ter recusado nada.
> A tela corta na digitação; a recusa que vale está no banco
> (`trg_allocation_within_charge`), porque nem todo caminho passa pela tela.

### 2.4 Não aceitar mais que o devido

- [x] Em uma cobrança em aberto, tente registrar valor **maior** que o saldo.

**Verificar:**
- [x] O campo mostra o saldo da cobrança e avisa quando o valor passa dele.
- [x] O botão **Confirmar pagamento** fica desabilitado enquanto o valor exceder.
- [x] Nada foi gravado: o saldo da cobrança não mudou e o card **Recebido**
      continua igual.

> O aviso sugere o caminho para receber a mais de propósito: registrar o valor
> devido e conceder o excedente como **crédito** na ficha do cliente — lá o
> lançamento é feito, e o crédito fica utilizável.

---

## Bloco 3 — Custos da empresa

### 3.1 Despesa avulsa

- [x] Em **Despesas → Nova despesa**, lance **R$ 300** de despesa operacional,
      sem rateio.

**Verificar:**
- [x] O KPI **Em aberto** subiu R$ 300.
- [x] Em **Despesas**, o card **Pago** não mudou — criar despesa não move
      dinheiro, só reconhece o custo.
- [x] Em **DRE**, o custo do mês subiu R$ 300.

### 3.2 Baixa da despesa

- [x] Dê baixa na despesa de R$ 300.

**Verificar:**
- [x] Ela sai da aba **Em aberto** e passa a aparecer em **Pagas**.
- [x] Nos cards da tela: **Em aberto** cai R$ 300 e **Pago** sobe R$ 300.
- [x] O custo no DRE **não mudou** — o custo já era do lançamento, não do
      pagamento.

> Não existe tela de saldo de caixa, e é de propósito: o produto registra
> valores e produz relatório gerencial, não faz controle de caixa. O par de
> cards *Em aberto* / *Pago* é onde a saída do dinheiro fica visível.

### 3.3 Manutenção executada pela empresa, sem rateio

- [x] Em **Manutenção → Nova Manutenção → Já executada**: custo **R$ 400**,
      cliente paga **R$ 0**, executor **Empresa**.

**Verificar:**
- [x] A manutenção aparece na aba **Concluídas mês**, com a coluna **Custo**
      preenchida com R$ 400 (não pode ficar "—").
- [x] Em **Despesas**, existe uma conta de R$ 400 de origem manutenção.
- [x] No ROI do veículo (**Painel financeiro → clicar na placa**), o custo do
      veículo subiu R$ 400.

### 3.4 Manutenção rateada, executada pela empresa

- [x] Registre manutenção de **R$ 1.000**, cliente paga **R$ 300**, executor
      **Empresa**.

**Verificar:**
- [x] Antes de salvar, o resumo mostra **Despesa da empresa R$ 700** e
      **Repassado ao cliente R$ 300**.
- [x] Em **Despesas**, a linha mostra **Total R$ 1.000**, **Empresa R$ 700**,
      **Cliente R$ 300**.
- [x] Em **Cobranças**, nasceu uma cobrança de repasse de **R$ 300** para o
      cliente.
- [x] Em **DRE**, o custo subiu **R$ 1.000** e a **Recuperação de despesas**
      subiu **R$ 300**.

> **Por que importa:** repasse não é receita. Se os R$ 300 aparecerem em Receita
> bruta, o faturamento está inflado e a base de imposto também.

### 3.4-b Rateio em moto sem locação ativa

- [x] Em **Nova manutenção → Já executada**, escolha uma moto **sem contrato
      ativo**.

**Verificar:**
- [x] O campo **Quanto o cliente paga** fica **desabilitado**, com o aviso
      *"Moto sem locação ativa — não há a quem repassar"*.
- [x] Trocando para uma moto **com** contrato, o campo abre e diz
      *"Será cobrado de \<nome do cliente\>"*.
- [x] Digite um valor com a moto locada, depois **troque para a moto sem
      contrato**: o campo volta a **vazio**, sem guardar o valor por baixo.

> A tela deixava digitar o rateio para qualquer moto. A manutenção era criada, o
> custo falhava logo depois — "sem locação ativa para este veículo" — e sobrava
> o alerta *"Manutenção salva, mas o custo falhou"*, com um registro sem custo
> que o operador não pediu. Quem responde pelo repasse é o cliente da locação
> ATIVA do veículo: ou existe, ou não há a quem cobrar. Agora a tela diz isso
> antes de gravar, e se o custo falhar mesmo assim a manutenção é desfeita.

### 3.5 Manutenção executada pelo CLIENTE, rateada

- [x] Registre manutenção de **R$ 100**, cliente paga **R$ 50**, executor
      **Cliente**.

**Verificar:**
- [x] O resumo avisa que **gera crédito de R$ 50 a favor do cliente**.
- [x] Em **Despesas**, a conta nasce **já quitada** — o cliente pagou a oficina,
      a empresa nunca deveu.
- [x] Em **Despesas**, o card **Pago** não subiu: quem pagou a oficina foi o
      cliente, não a empresa.
- [x] Na ficha do cliente, **Créditos disponíveis** subiu **R$ 50**.
- [x] **NÃO** nasceu cobrança de repasse (quem deve é a empresa, não o cliente).

### 3.6 Manutenção 100% do cliente, executada por ele

- [x] Registre manutenção de **R$ 80**, cliente paga **R$ 80**, executor
      **Cliente**.

**Verificar:**
- [x] **Nenhum crédito** foi gerado — nada mudou de mão.
- [x] **Nenhuma cobrança** de repasse foi criada.
- [x] O custo aparece no veículo, mas o resultado da empresa não piora.

### 3.7 IPVA / licenciamento

- [x] Na ficha do veículo, cadastre a obrigação anual e o valor (**R$ 1.200**).

**Verificar:**
- [x] O veículo aparece com documentação **em atraso** ou **em aberto**,
      conforme o vencimento.
- [x] Em **Despesas**, existe conta a pagar de R$ 1.200.
- [x] Após dar baixa, o veículo passa a constar **em dia** — sem que você precise
      editar nada na obrigação.

### 3.8 Multa com responsável CLIENTE

- [x] Em **Multas → Nova**, lance multa de **R$ 293,47** na placa, com
      responsável **Cliente**.

**Verificar:**
- [x] Em **Despesas**, nasceu conta a pagar da multa.
- [x] Em **Cobranças**, nasceu cobrança de repasse ao cliente da locação vigente
      **na data da infração**.
- [x] O cliente cobrado é o correto para aquela data (não o atual, se mudou).

### 3.9 Trocar o responsável da multa para EMPRESA

- [ ] Edite a multa e mude o responsável para **Empresa**.

**Verificar:**
- [ ] A cobrança de repasse foi **cancelada**.
- [ ] O cliente deixou de ter aquele valor a pagar.
- [ ] O custo continua com a empresa no DRE.

---

## Bloco 4 — Crédito do cliente

### 4.1 Saldo exibido é o disponível, não o concedido

- [x] Abra a ficha do cliente que recebeu o crédito de R$ 50 (caso 3.5).

**Verificar:**
- [x] **Créditos disponíveis** mostra **R$ 50,00**.
- [x] A contagem ao lado fala em *concedidos*, e é coerente com a lista abaixo.

### 4.2 Abater o crédito em cobrança

- [x] Abra uma cobrança em aberto do cliente → **Aplicar crédito**.

**Verificar:**
- [x] O modal já traz o saldo correto e o valor preenchido.
- [x] Após aplicar, a cobrança mostra **valor de face inalterado** e
      **"a pagar" reduzido** pelo crédito.
- [x] O abatimento aparece na lista de pagamentos como **Crédito do cliente**.
- [x] **O caixa NÃO mudou** (atalho acima) — abater crédito troca passivo por
      recebível, não entra dinheiro.
- [x] O saldo de crédito do cliente foi a **R$ 0,00**.

### 4.2-b O abatimento vai na cobrança que você abriu

- [x] Com crédito disponível, deixe **duas** cobranças em aberto: uma **antiga**
      e uma **de hoje**.
- [x] Abra a **de hoje** e clique em **Aplicar crédito**.

**Verificar:**
- [x] O modal mostra **Saldo de crédito**, **Esta cobrança deve** e **Pode
      abater até** — o teto é o menor dos dois.
- [x] O campo já vem com o teto e **não aceita passar dele**, nem com três casas.
- [x] Após aplicar, o abatimento caiu **nesta** cobrança. A **antiga continua
      intacta**.
- [x] Na **Composição** da cobrança, o valor abatido aparece.

> O modal pedia qual crédito e quanto, validava os dois e chamava a action com
> apenas o cliente — que varria todo o saldo para as cobranças MAIS ANTIGAS.
> Escolher R$ 50 na #7 e ver R$ 200 abatidos na #3 era o comportamento correto
> do código. O seletor "qual crédito" saiu: o saldo é um pool por cliente,
> derivado do razão, e escolher entre as linhas era decisão sem efeito.

### 4.3 Devolver crédito em dinheiro

- [x] Gere um novo crédito (repita 3.5) e, na ficha do cliente, use
      **Devolver crédito** com **valor parcial**.

**Verificar:**
- [x] O modal mostra o saldo disponível e recusa valor maior que ele.
- [x] Após confirmar, o **caixa caiu** exatamente pelo valor devolvido (atalho
      acima) — aqui sai dinheiro de verdade, e é o ponto do caso.
- [x] O saldo de crédito caiu pelo mesmo valor, e **o resto continua disponível**.
- [x] **O custo da manutenção que originou o crédito continua no DRE e no ROI do
      veículo.** Devolver não é estornar.

### 4.4 Sem saldo, sem botão

- [x] Devolva todo o saldo restante e recarregue a ficha.

**Verificar:**
- [x] O botão **Devolver crédito** desaparece.
- [x] **Créditos disponíveis** mostra R$ 0,00, mas a lista de créditos concedidos
      continua lá (é histórico).

---

## Bloco 5 — Correções

### 5.1 Estornar pagamento

- [x] Em uma cobrança paga, estorne o pagamento.

**Verificar:**
- [x] A cobrança volta a **Em aberto**, com o valor devido de volta.
- [x] O pagamento **continua listado**, marcado como estornado — não some.
- [x] Em **Cobranças**, o card **Recebido** voltou ao valor anterior — e o
      **caixa** também (atalho acima).
- [x] Se a cobrança estava **vencida**, o encargo que foi lançado no recebimento
      **continua como item** — o atraso aconteceu, e o estorno não o desfaz.
- [x] Recebendo de novo **no mesmo dia**, o valor é **o mesmo de antes**: a multa
      não é cobrada duas vezes e não há juros sobre o encargo anterior. Na tela
      de detalhe isso aparece como a linha **"Já lançado"**, descontada do
      encargo corrente (ADR 0028).

### 5.2 Estornar abatimento por crédito

- [x] Aplique um crédito e depois estorne esse abatimento.

**Verificar:**
- [x] A cobrança volta a dever o valor.
- [x] **O crédito volta para o saldo do cliente** — não evapora.

### 5.3 Cancelar cobrança

- [x] Cancele uma cobrança **sem pagamento**.

**Verificar:**
- [x] Ela sai de "A receber".
- [x] Se era cobrança de receita, a **Receita bruta do DRE caiu** pelo valor.

> Abra a cobrança cancelada depois: o bloco **Cobrança** traz **Motivo do
> cancelamento** com o texto que você digitou. Ele era gravado em
> `charges.cancellation_reason` e nenhuma tela lia — o operador escrevia a
> justificativa para o nada, e depois não havia como saber por que aquela
> cobrança tinha sido encerrada.

### 5.4 Cobrança com pagamento não se cancela

- [x] Tente cancelar uma cobrança que já recebeu pagamento.

**Verificar:**
- [x] O sistema recusa e explica que é preciso estornar o pagamento antes.
- [x] Nada mudou na cobrança.

### 5.5 Cancelar despesa rateada

- [x] Cancele a despesa do caso 3.4 (R$ 1.000 com R$ 300 de repasse).

**Verificar:**
- [x] O custo de R$ 1.000 **saiu do DRE**.
- [x] A **cobrança de repasse de R$ 300 foi cancelada junto** — o cliente não
      pode continuar devendo por um custo que a empresa diz não ter tido.

### 5.6 Despesa paga pelo cliente não se cancela por ali

- [x] Tente cancelar a despesa do caso 3.5 (executada pelo cliente).

**Verificar:**
- [x] O sistema recusa e explica o caminho — acerto por crédito ou cobrança
      avulsa.

### 5.7 Baixa por inadimplência

- [x] Em **Cobranças**, numa cobrança vencida e não paga, use o botão de
      **baixa por inadimplência** e informe o motivo.

**Verificar:**
- [x] A cobrança sai de "A receber" e passa a constar como **Baixada**.
- [x] No DRE aparece **Perda** pelo valor em aberto.
- [x] A **receita original permanece** — a venda aconteceu; o que se reconhece é
      a perda. É isso que distingue baixa de cancelamento: cancelar apaga a
      receita, baixar reconhece que ela não será recebida.

---

> Na cobrança baixada, o bloco **Cobrança** traz **Motivo da baixa** — mesmo
> campo do cancelamento, com o rótulo que corresponde ao desfecho.

## Bloco 6 — Encargos por atraso

### 6.1 Encargo é projeção até ser realizado

- [x] Deixe uma cobrança vencer e abra-a.

**Verificar:**
- [x] A tela mostra o encargo **calculado**.
- [x] O DRE **ainda não** tem receita de encargos.

### 6.2 Receber realiza o encargo

- [x] Registre o pagamento da cobrança vencida, pelo valor que a tela oferece.

**Verificar:**
- [x] O encargo vira **item da cobrança** e o total sobe.
- [x] A cobrança fica **paga**, com saldo zero — nunca negativo.
- [x] No DRE aparece em **Receitas financeiras**, marcada *tributável* — e
      **não** somada à Receita bruta. O encargo é lançado na conta *Receita de
      encargos*, e o DRE agrupa contas em LINHAS: a linha dessa conta é
      `financial_income`. Juros de atraso não são faturamento de locação, e
      separá-los é o que permite ao contador ler as duas coisas.
- [x] O encargo aparece atribuído ao veículo correto no ROI.

> Não existe mais botão "Consolidar encargo". Ele recalculava o encargo do zero
> a cada clique — multa sobre o saldo já acrescido, juros de todos os dias desde
> o vencimento — e quatro cliques no mesmo dia levavam uma dívida de R$ 1.000
> para R$ 1.125. Receber é o que realiza o encargo, e sempre foi o caminho que
> importa.

### 6.3 A data do recebimento manda no encargo

- [x] Numa cobrança vencida, abra **Registrar pagamento** e mude a **Data do
      recebimento** para alguns dias atrás.

**Verificar:**
- [x] O valor sugerido **diminui** — menos dias de atraso, menos juros.
- [x] Os **dias de atraso acompanham a data**, nos dois lugares em que aparecem:
      ao lado do vencimento, no cabeçalho, e na linha de juros.
- [x] Data futura é recusada com mensagem.
- [x] Registrando, o encargo lançado é o daquela data, não o de hoje.

> É o caso de receber o Pix na segunda e registrar na quarta. Antes o sistema
> mandava sempre a data de hoje, cobrando dias de juros que não correram.

### 6.3-b O modal é o mesmo nas duas telas

- [x] Abra **Registrar pagamento** pela **lista** (/cobrancas, ícone $ na linha).
- [x] Abra a mesma cobrança em **detalhe** e clique em **Registrar pagamento**.

**Verificar:**
- [x] Os dois modais são idênticos: cabeçalho com número da cobrança, cliente,
      **vencimento** e dias de atraso; data do recebimento; valor; detalhamento
      de principal/multa/juros; forma de pagamento; observações.
- [x] Nos dois, digitar valor **acima** do devido devolve o campo ao máximo e
      mostra o erro **dentro** do modal.
- [x] Depois de receber, a tela de detalhe mostra **"Pago em"** com a data do
      recebimento — a mesma que aparece na tabela de Pagamentos abaixo.

> Eram dois modais separados que divergiram: um recusava valor acima do saldo, o
> outro deixava passar, e um mandava o erro para o topo da PÁGINA — atrás de si.
> "Pago em" exibia o VENCIMENTO com outro rótulo, e ainda um dia antes por causa
> de fuso: cobrança recebida em 21/08 aparecia paga em 20/07, antes de vencer.

### 6.4 Aplicar crédito só lança encargo quando avança sobre ele

**Parcial — dentro do que já é dívida lançada:**
- [x] Em cobrança vencida, aplique crédito **parcial**, sem cobrir tudo (o
      campo já nasce sugerindo esse valor: o teto sem juros).
- [x] O total da cobrança **não muda** — aplicar crédito parcial não realiza
      multa nem juros. "Esta cobrança deve (sem juros)" mostra o saldo já
      lançado (`open_amount`), não o "a pagar" do topo da página quando os
      dois diferem (a diferença é encargo em projeção, mostrada à parte como
      "Juros previstos até hoje").
- [x] Abaixo do campo, com o valor no teto sem juros, aparece a nota "abate só
      a dívida já lançada" — não o aviso de juros.
- [x] Registre o restante em **Registrar pagamento**, com a data em que o
      cliente pagou de verdade — se essa data está dentro do prazo (antes do
      vencimento + carência), a tela não sugere multa nem juros, e nada é
      lançado.

**Quitação total — crédito cobre a cobrança inteira, juros incluído:**
- [x] Em cobrança vencida com saldo de crédito suficiente para cobrir o "se
      quitar tudo agora", aparece o atalho **"Quitar a cobrança inteira agora
      com o crédito (…, juros de hoje incluído)"**.
- [x] Clicar no atalho preenche o campo com o valor TOTAL (principal + multa +
      juros de hoje) e troca a nota por um aviso: "inclui juros até hoje… o
      encargo é calculado e lançado nesta cobrança agora" — **antes** de
      confirmar, não só depois no extrato.
- [x] Confirmar: o total da cobrança **sobe** pelo encargo, a cobrança fecha
      em zero, e o encargo aparece como receita (`receita_encargos_atraso`).
- [x] Digitar manualmente um valor entre o teto sem juros e o teto com juros
      (sem usar o atalho) produz o mesmo aviso e o mesmo resultado — quem
      decide é o valor pedido, não o botão.

> Existiram duas decisões anteriores, cada uma simétrica demais: primeiro,
> realizar o encargo em QUALQUER aplicação de crédito, com
> `realizeAccruedBefore(..., new Date())` sempre HOJE — o que quebrava a
> reconciliação de um pagamento retroativo (operador abre cobrança vencida que
> o cliente já tinha pago fora do sistema, aplica o desconto do saldo dele, e
> o juros de HOJE virava item permanente, mesmo registrando o restante depois
> com a data retroativa correta). Depois, o oposto — crédito NUNCA realiza
> encargo —, o que reabria a porta original: quitar 100% de uma cobrança
> vencida só com crédito escapava do juros que já tinha corrido. A regra final
> distingue as duas situações pelo valor pedido: até `open_amount`, desconto
> puro; acima disso, o crédito está avançando sobre o encargo e ele é
> realizado — com a diferença visível na tela antes de confirmar.

---

### 6.5 Configurar a política — Configurações → Encargo por atraso

- [x] Como **Owner**, abra `/configuracoes`. A seção **Encargo por atraso** existe
      e mostra "Em vigor · versão N · desde DD/MM/AAAA" com multa, juros e carência.
- [x] O campo de juros mostra a taxa **diária** derivada ("Equivale a 0,0333% ao dia").
- [x] Como **Operator/Viewer**, a seção não aparece.

**Alterar:**
- [x] Mude a multa para 5%, deixe a vigência em hoje e salve.
- [x] A confirmação aparece e o cabeçalho passa a mostrar a nova versão
      **sem recarregar a página**. A tela é Client Component e lê as versões por
      `useLateChargePolicies()`: o `revalidatePath` da action não alcança esse
      cache, então salvar respondia "salvo" com a versão antiga no cabeçalho.
- [x] Tente vigência **anterior a hoje**: a tela recusa explicando que política
      nova não retroage.

**Verificar o que NÃO pode mudar:**
- [x] Uma cobrança **já vencida antes da alteração** continua com o mesmo valor
      devido. Abra o modal de recebimento dela antes e depois — multa e juros
      não podem se mexer.
- [x] Uma cobrança **emitida depois**, com vencimento após a vigência nova, usa
      a nova multa.
- [x] No **detalhe** de cada uma, o bloco *Encargos por atraso* diz de qual
      versão saiu o número: uma mostra "política versão N", a outra "versão N+1",
      com a data de vigência de cada uma. Duas cobranças abertas no mesmo dia,
      com regras diferentes, é o que significa fixar a política na emissão — e
      agora dá para conferir isso sem SQL.
- [x] Ainda no detalhe, cada linha traz a **conta**: "2% sobre R$ 142,86" na
      multa, "0,99% ao mês (0,033% ao dia) × 25 dias sobre R$ 142,86" nos juros.
      Os valores têm de bater com a política daquela versão.

```sql
-- Versões da política e qual cobrança usa qual
select v.version, v.effective_from, v.fee_type, v.fee_value, v.daily_interest_rate,
       count(c.id) as cobrancas
  from late_charge_policies v
  left join charges c on c.late_charge_policy_id = v.id
 group by v.id order by v.version;
```

> A política é do TENANT, não da locação. O campo por locação existiu, foi
> preenchido pelo operador e nunca chegou ao banco — `rentals` não tem essas
> colunas e a emissão sempre resolveu a política vigente. Foi removido.
>
> Quem escolhe a política é a **data de emissão** da cobrança, via
> `fn_late_charge_policy_at`. Agendar uma versão para daqui a 15 dias não afeta
> nada emitido antes disso.

### 6.5-b Empresa sem encargo configurado

Estado de toda empresa recém-cadastrada. Para reproduzir em dev:
`docker exec supabase_db_GoMoto psql -U postgres -d postgres -c "delete from late_charge_policies;"`
(só funciona antes de emitir cobrança — depois a FK segura).

- [x] Em Configurações → Encargo por atraso, aparece o aviso **"Nenhum encargo
      configurado"** e os campos estão **vazios** (a convenção de mercado fica
      só no placeholder).
- [x] O botão diz **"Começar a cobrar encargo"**, não "Salvar nova versão".
- [x] Salvar com um campo em branco explica qual falta e sugere usar 0.

**Verificar:**
- [x] Emita uma cobrança vencida. O valor devido é o **original**, sem multa nem
      juros, por mais dias que passem.
- [x] A cobrança nasce com `late_charge_policy_id` nulo.
- [x] O modal de recebimento não mostra as linhas de Multa e Juros.

> Sem política, o formulário nascia com 2% e 1% ao mês preenchidos. Quem abria a
> tela lia isso como o que a empresa cobra — e não cobrava nada.

### 6.6 As três telas mostram o mesmo encargo

Só faz sentido com **duas ou mais versões** de política na base (crie uma em 6.5).

- [x] Pegue uma cobrança vencida **emitida antes** da versão nova.
- [x] Compare o valor em três lugares: coluna **Devido** na lista, modal
      **Registrar pagamento** aberto pela lista, e a tela de **detalhe**
      (bloco "Encargos por atraso") com o modal aberto por ela.

**Verificar:**
- [x] Os quatro valores são idênticos.
- [x] O encargo é o da política **em vigor quando a cobrança foi emitida** — não
      o da versão nova.
- [x] O badge de dias ao lado do vencimento (ex.: "30d") bate com os "N dias de
      atraso" do modal. **Teste depois das 21h**: é a janela em que o banco, em
      UTC, já virou o dia e a tela não.

> A lista resolvia "a política vigente hoje" e aplicava a mesma a todas as
> linhas; só a tela de detalhe lia `late_charge_policy_id`. E o app do cliente
> não lia política nenhuma — faltava RLS —, então exibia o principal limpo e
> gerava um Pix (service role) COM o encargo: o cliente via R$ 350,00 e recebia
> um QR de R$ 360,47.

## Bloco 7 — Encerramento da locação

### 7.1 Apuração antes de encerrar

- [x] Abra **Locações → contrato → Encerrar**.

**Verificar:**
- [x] A **Apuração financeira** mostra quatro linhas: cobranças em aberto, saldo
      de caução, **crédito do cliente** e cronograma a cancelar.
- [x] Os valores batem com o que você vê em Cobranças e na ficha do cliente.
- [x] **Cobranças em aberto** traz a abertura embaixo — *"3 vencidas R$ X · 1 a
      vencer R$ Y"* — e a soma das duas bate com o total da linha. Ela soma o
      que foi EMITIDO e não pago, vencido ou não: é o que sobrevive ao
      encerramento, e é o mesmo recorte que a RPC usa para travar. A contagem de
      vencidas aqui é a MESMA do alerta amarelo abaixo.
- [x] A **Data de encerramento** abre em **hoje**, não na data de fim do
      contrato, e não aceita data futura (o seletor trava em hoje; digitando
      uma data à frente, o encerramento é recusado com explicação).
- [x] Com a data em hoje, **Cronograma a cancelar** mostra as parcelas ainda não
      emitidas cujo período começa depois de hoje — não zero. Abrindo na data de
      fim do contrato dava R$ 0,00, porque nenhum período começa depois dela.

> Encerrar com data futura não existe de propósito: a RPC fecha a locação e
> libera o veículo no ato, então uma data à frente significaria "moto liberada
> hoje, contrato até dezembro", com as parcelas do intervalo presas em
> `scheduled` — nunca emitidas (`issue_due_charges` exige locação ativa) e nunca
> canceladas (o corte é `period_start > p_termination_date`). Encerramento
> AGENDADO é outra feature.

### 7.2 Encerrar com débito em aberto é barrado

- [x] Com cobrança em aberto, tente encerrar sem marcar a confirmação.

**Verificar:**
- [x] O sistema recusa e explica.
- [x] Marcando a confirmação explícita, ele permite — e avisa que as cobranças
      continuam cobráveis.

### 7.3 Aviso de crédito pendente

- [x] Encerre um contrato de cliente **com saldo de crédito**.

**Verificar:**
- [x] Aparece aviso de que o cliente ficará credor, com link para a ficha.cont
**Verificar:**
- [x] O **caixa caiu** pelo valor da caução (atalho acima) — devolver é saída
      de dinheiro de verdade.
- [x] O saldo de caução do contrato foi a zero.
- [x] A moto voltou para **disponível** e pode ser locada de novo.

### 7.5 Destino da caução — reter

- [x] Em outro contrato, encerre escolhendo **Reter tudo**.

**Verificar:**
- [x] O **caixa não mudou** (atalho acima) — reter só converte passivo em
      abatimento; o dinheiro já estava com a empresa.
- [x] A dívida do cliente foi abatida pelo valor retido.
- [x] O saldo de caução foi a zero.

### 7.6 Cronograma futuro é cancelado

**Verificar (após qualquer encerramento):**
- [x] Parcelas com período posterior ao encerramento **não** são mais emitidas.
- [x] Parcelas já emitidas **continuam** existindo e cobráveis.

---

## Bloco 8 — Renovação e reajuste

### 8.1 Reajuste altera só o futuro

> A tela aplicava e não dizia nada: a página não passava `onDone`, então nem a
> confirmação nem o botão Cancelar faziam efeito, e a prévia (cache do TanStack)
> seguia mostrando os valores antigos. Agora ela confirma quantas parcelas
> mudaram e a prévia se atualiza sozinha.

- [x] Em **Locações → contrato → Reajustar**, mude o valor do ciclo.

**Verificar:**
- [x] Parcelas **ainda não emitidas** passam a valer o novo valor.
- [x] Parcelas **já emitidas** permanecem com o valor antigo.

### 8.2 Renovação estende o contrato

- [x] Renove um contrato.

**Verificar:**
- [x] A data de fim avançou.
- [x] Novas parcelas apareceram no cronograma.
- [x] Tentar renovar com data que **não estende** é recusado.

---

## Bloco 9 — Pagamento pelo app do cliente (Pix)

> Requer conta de gateway configurada. Se não houver, o esperado é a mensagem de
> "pagamento online não configurado" — isso também é um caso válido.

### 9.1 Gerar o QR

- [x] No app do cliente, abra uma cobrança em aberto e gere o Pix.

**Verificar:**
- [x] O valor do QR é o **valor devido** — considerando crédito já aplicado e
      encargo já realizado, não o valor de face.

### 9.2 Dois toques no botão

- [x] Toque para gerar o QR duas vezes seguidas.

**Verificar:**
- [x] **Nenhum erro** aparece para o cliente.
- [x] O **mesmo QR** é devolvido — não são gerados dois.

### 9.3 Pagar em ATRASO pelo app

- [x] Deixe uma cobrança vencer, gere o Pix pelo app e pague o valor mostrado.

**Verificar:**
- [x] A cobrança fica **paga**, com **saldo zero** — nunca negativo.
- [x] O total da cobrança cresceu pelo encargo: ele virou item, não sumiu.
- [x] No DRE aparece **Receita de encargos** pelo valor cobrado.
- [x] No ROI da moto, o encargo entra no resultado dela.

> Este era o defeito: o QR cobrava principal + encargo, o cliente pagava, e a
> cobrança — que só devia o principal — ficava com saldo NEGATIVO, com o encargo
> nunca virando receita.

### 9.4 Confirmação do pagamento

- [ ] Pague o Pix.

**Verificar:**
- [ ] A cobrança fica **Paga**, com o pagamento listado.
- [ ] Em **Cobranças**, o card **Recebido** subiu pelo valor — e o **caixa**
      também (atalho acima).
- [ ] O resultado é idêntico ao de uma baixa manual — mesma forma, mesmo efeito.

### 9.5 Cobrança de outro cliente

- [ ] Tente abrir/pagar pelo app uma cobrança que não é do cliente logado.

**Verificar:**
- [ ] O sistema recusa. Nenhum QR é gerado.

---

## Bloco 10 — Relatórios gerenciais

### 10.1 DRE

- [x] Abra **Financeiro → DRE**. Deixe o intervalo em 6 meses: o que você lançou
      pode estar em mais de um mês, e a conferência é por **coluna**, não pelo
      total.

**Verificar:**
- [x] **Receita bruta** = aluguel + entrada, no mês da **EMISSÃO** de cada
      cobrança. **Sem caução, sem repasse, sem encargo.**
- [x] **Receitas financeiras** = encargos por atraso **realizados**, no mês do
      **RECEBIMENTO** — não no mês da cobrança que os gerou.
- [x] **Recuperação de despesas** = soma dos repasses cobrados.
- [x] **Custos operacionais** = soma das despesas lançadas, pelo valor **cheio**.
- [x] **Perdas** = baixas por inadimplência.
- [x] Cancelamentos e estornos **não aparecem** como valores; eles reduzem as
      linhas correspondentes.

> **Encargo não é receita bruta, e raramente é do mesmo mês.** Duas coisas que
> fazem a conferência falhar quando se procura tudo numa linha só:
>
> 1. O encargo entra em **Receitas financeiras** — juros de atraso não são
>    faturamento de locação (conta `receita_encargos_atraso`, linha
>    `financial_income`).
> 2. Ele nasce no **recebimento**, não na emissão: enquanto a cobrança está
>    vencida e não paga, o encargo é projeção e não existe no razão.
>
> Exemplo real desta bateria: cobranças emitidas em 31/08 e pagas em 01/09
> produziram **Receita bruta R$ 1.028,57 em ago/26** e **Receitas financeiras
> R$ 10,36 em set/26**. As duas colunas estão certas; a soma numa linha só não
> existiria em mês nenhum.

### 10.1-b Caução declarada nos indicadores de caixa

Depois de receber uma caução no mês:

**Verificar:**
- [x] Em `/financeiro`, os cards **Emitido no mês** e **Recebido no mês** trazem
      a linha *"inclui R$ X de caução"*.
- [x] Em `/cobrancas`, o card **Recebido** traz *"Inclui R$ X de caução"*.
- [x] O **DRE não muda** com a caução: ela não aparece em linha nenhuma.
- [x] Os totais dos cards **continuam somando a caução** — eles medem caixa e
      recebíveis, e precisam bater com o extrato.

> Caução é dinheiro de terceiro: entra no caixa e um dia sai. Tirá-la dos
> totais faria os cards deixarem de bater com o banco; somá-la calada fazia
> "Recebido no mês: R$ 500,00" ser 100% depósito, com o DRE mostrando outro
> número e nenhuma explicação para a diferença. O total fica inteiro, a parcela
> fica declarada.

### 10.2 Painel financeiro

**Verificar:**
- [x] **A receber** = soma dos saldos em aberto das cobranças.
- [x] **Vencido** conta apenas cobranças com vencimento passado e saldo > 0.
- [x] **Recebido** = soma dos pagamentos não estornados.
- [x] Os totais batem com o que a tela de Cobranças mostra.

### 10.3 Resultado por veículo (ROI)

- [x] Abra o ROI da moto usada nos testes.

**Verificar:**
- [x] **Receita** = parcelas daquela locação + repasses recuperados.
- [x] **Custos** = manutenções e multas do veículo, pelo valor cheio.
- [x] Valor de compra e de venda aparecem, quando cadastrados.
- [x] Uma moto **sem nenhum lançamento** ainda aparece no relatório (não some).

### 10.4 Resultado por cliente

**Verificar:**
- [x] **Receita** do cliente = o que ele foi cobrado de aluguel e encargos.
- [x] **Custo absorvido** = o que a empresa comeu depois do repasse (bruto menos
      repassado), e a tela mostra as duas parcelas.

### 10.5 Documentação da frota

**Verificar:**
- [ ] Motos com IPVA vencido aparecem como **fora de dia**.
- [ ] Marcar uma obrigação como **isenta** tira a moto da lista de pendências.
- [ ] A isenção **sobrevive ao recarregar** a página.

---

## Bloco 11 — Alienação do veículo

### 11.1 Registrar venda

- [ ] No ROI de uma moto **disponível**, registre alienação.

**Verificar:**
- [ ] O resultado do ativo é **valor de venda − valor de compra**.
- [ ] A moto **desaparece do seletor de nova locação**.
- [ ] O botão de alienar some (não dá para vender duas vezes).

### 11.2 Moto locada não se vende

- [ ] Tente alienar uma moto com contrato ativo.

**Verificar:**
- [ ] O sistema recusa, dizendo para encerrar o contrato antes.
- [ ] Nada foi gravado.

---

## Bloco 12 — Isolamento entre empresas

> Exige acesso a duas empresas (tenants). Se você opera uma só, pule.

### 12.1 Dados não vazam

- [ ] Logado na empresa A, confira Cobranças, Despesas, Clientes, Veículos e DRE.

**Verificar:**
- [ ] Nenhum dado da empresa B aparece em nenhuma tela.
- [ ] Os totais do Painel refletem só a empresa A.

---

## Bloco 13 — Regressões conhecidas

Casos que já falharam em produção ou em teste. Vale reconferir a cada release.

### 13.1 Dois cliques na baixa de despesa

- [x] Em uma despesa em aberto, clique em **dar baixa** duas vezes rapidamente.

**Verificar:**
- [x] O **caixa caiu uma única vez** pelo valor da despesa (atalho acima).
      Em **Despesas**, o card **Pago** subiu uma vez só.
- [x] Não há dois pagamentos para a mesma conta.

### 13.2 Excluir manutenção que virou dinheiro

- [x] Tente excluir a manutenção do caso 3.4 (com custo lançado).

**Verificar:**
- [x] O modal de confirmação **avisa o que sai junto** — despesa, cobrança de
      repasse e crédito —, e a exclusão os desfaz numa transação só (ADR 0029).
- [x] Depois de excluir, **nada sobra nas contas**: o custo some do DRE, o caixa
      volta e o saldo de crédito do cliente cai pelo valor concedido.
- [x] Se a **cobrança de repasse já foi paga**, recusa e manda estornar o
      pagamento antes; o botão **Excluir** vem desabilitado.
- [x] Se o **crédito não é mais coberto pelo saldo** do cliente, recusa e manda
      estornar o abatimento na cobrança onde ele foi usado.
- [x] Manutenção **sem** custo abre o modal normal, sem aviso e com o botão
      habilitado.

### 13.3 Rateio no atalho "Já executada"

- [x] Registre manutenção pelo atalho com rateio (custo 120, cliente 40,
      executor Cliente).

**Verificar:**
- [x] O crédito gerado é de **R$ 80** (a parte da empresa), não de R$ 120.

### 13.4 Coluna de custo na lista de manutenção

**Verificar:**
- [x] Manutenções com custo lançado mostram o valor na coluna **Custo** — nunca
      "—" para todas.

### 13.5 Saldo de crédito na ficha

- [x] Conceda R$ 100 de crédito e aplique R$ 60 em uma cobrança.

**Verificar:**
- [x] A ficha mostra **R$ 40,00** em Créditos disponíveis, não R$ 100,00.

### 13.6 Emissão relatando o que emitiu

- [x] Rode a emissão com parcelas pendentes e confira o registro da execução:

```bash
docker exec -i supabase_db_GoMoto psql -U postgres -d postgres \
  -c "SELECT triggered_by, charges_issued, error, finished_at
        FROM billing_runs ORDER BY started_at DESC LIMIT 3;"
```

**Verificar:**
- [x] `charges_issued` bate com o número de cobranças que apareceram na tela.
- [x] `error` está vazio e `finished_at` preenchido — execução que começou e não
      terminou é o sintoma que `billing_runs` existe para tornar visível.

---

## Encerramento do roteiro

Ao final, com tudo verde:

- [x] O **razão fecha**: no DRE, receitas menos custos menos perdas resulta no
      número que o Painel mostra como resultado.
- [x] **Nenhum saldo ficou órfão**: nenhum cliente com crédito de contrato
      encerrado, nenhuma caução de contrato encerrado.
- [x] **Nenhuma cobrança sem origem**: toda cobrança em aberto tem locação,
      manutenção, multa ou lançamento avulso identificável.
