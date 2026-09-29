# 📈 Tela: ROI do Veículo — [[GoMoto]]

Rota: `/financeiro/veiculos/[id]` | Tipo: Server Component (leitura direta via `createClient()`, sem mutação nesta página)

A tela conta uma história só, em dinheiro: **quanto entrou, quanto saiu, o lucro, e quanto do investimento inicial já voltou**. Não há nenhum número de "faturado" ou de competência contábil na tela — o operador decide pelo caixa.

Duas perguntas diferentes, respondidas por dois blocos diferentes:
- **Lucro operacional** (resumo no topo) — a moto está dando dinheiro *neste momento*? Independe de a aquisição já ter sido paga.
- **Retorno do investimento** (capital, mais abaixo) — quanto do valor que comprou a moto já voltou? É a pergunta central de um negócio rent-to-own, mas é outra pergunta.

Conflar as duas escondia o lucro operacional atrás do payback: uma moto podia estar dando lucro todo mês e a tela não dizia nada, porque a aquisição ainda não tinha sido recuperada.

## Layout (de cima para baixo)

0. **Cabeçalho do relatório**: placa e modelo em destaque e, em chips, os dados do veículo — ano, cor, cadastrado em e situação (`Em locação · cliente`, `Sem locação ativa` ou `Vendido por R$ X em dd/mm`). A barra fixa do topo só traz o caminho (`← Financeiro / ROI / placa`) e o atalho "Ver veículo".
1. **Resumo financeiro** (sempre visível, independe de aquisição cadastrada): **Recebido** · **Despesas da empresa** · **Lucro** (sinal verde/vermelho). É o único lugar da tela com "Lucro" — o card de retorno do investimento, mais abaixo, não repete o rótulo para não colidir.
2. **Entrada × Saída por mês** (barras) — só com movimento.
3. **Composição das entradas** (por categoria: aluguel, encargo de atraso, repasse devolvido) e **Composição das despesas** (por categoria), lado a lado — o par mostra de onde vem o dinheiro e para onde ele vai com o mesmo vocabulário visual (verde entra, âmbar sai).
4. **Recebimentos das locações** (só se o veículo teve locação): **Recebido**, **Em atraso** e **A receber** (= a vencer já emitido + a emitir do cronograma), com barra segmentada do total previsto.
5. **Despesas**: **Empresa** e **Cliente** (quem arca), com barra proporcional, o total lançado e, quando há repasse, a linha **Repasses ao cliente** (adiantados e cobrados · já devolvidos · a devolver). **Não há lista lançamento a lançamento** — o detalhe fica em `/despesas`.
6. **Retorno do investimento** (card, só com `acquisition_amount` cadastrado): % recuperado + barra de progresso, selo "Já se pagou · payback em mês/ano" ou "Faltam R$ X para se pagar", os números **Investido** e **Falta para o payback** (vira **Retorno acima do investimento** + ROI depois do payback) e o gráfico da evolução mês a mês (investimento tracejado × recuperado; só aparece com 2 meses ou mais). Sem aquisição: cartão tracejado com botão que leva às Ações.
7. **Ocupação**: % do tempo locado, barra e tabela de locações.
8. **Ações** (aquisição, venda — `VehicleFinancialActions.tsx`, inalterado).

Paleta única na tela: verde = entrada/recebido · âmbar = saída/despesa · vermelho = **só** atraso · azul = a receber / parte do cliente.

## Definições

| Número | Definição |
|---|---|
| **Recebido** (resumo) | Recebimentos **da moto** — aluguel e encargo de atraso, com data do pagamento — **sem repasse, sem caução e sem crédito do cliente consumido** (`payments.method <> 'credit'`; retenção de caução conta). Base do Lucro e igual ao "Recuperado" do card de investimento (sem a venda). Diferente do "Recebido" do card Recebimentos, que soma qualquer método porque mede dívida quitada, não caixa. |
| **Despesas da empresa** (resumo) | Despesas (pagas e em aberto) que ficam com a empresa — igual à parte "despesas" do **Investido**, ver abaixo. |
| **Lucro** | Recebido − Despesas da empresa. Sempre visível, com sinal. Independe do payback: uma moto pode dar lucro todo mês antes de a aquisição ter sido recuperada — são perguntas diferentes. |
| **Composição das entradas** | Recebido da moto + repasse já devolvido, por categoria (`financial_accounts.name` do item da cobrança: receita de locação, receita de encargos, repasse de multa/manutenção/despesa). Caução nunca aparece aqui. |
| **Composição das despesas** | Total de despesa **bruto** (empresa + cliente) por categoria. |
| **Recebido** (card Recebimentos) | Soma das alocações de pagamentos **não estornados** a cobranças **não canceladas** das locações do veículo. Inclui o que quitou repasse (a linha diz quanto) — por isso é maior que o "Recebido" do resumo, que exclui repasse. **Caução não entra em nenhum dos dois**: é passivo, e uma cobrança de caução (100% dela, por origem única — ADR 0024) fica inteiramente fora tanto daqui quanto do resumo. |
| **Em atraso** | Saldo em aberto das cobranças `open` com `due_date` vencida. **Sem multa e juros previstos** — o encargo só vira valor quando é lançado como item da cobrança. |
| **A vencer** | Saldo em aberto das cobranças `open` ainda dentro do prazo. |
| **A emitir** | Linhas `scheduled` de `rental_billing_schedules` das locações **ativas**. Linha `scheduled` de locação encerrada é plano que não vira cobrança. |
| **A receber** | A vencer + a emitir. |
| **Previsto no contrato** | Recebido + em atraso + a vencer + a emitir (base da barra segmentada). Cobrança `written_off` conta o que já foi recebido, mas não o saldo. |
| **Despesas** (card Despesas) | `payables` do veículo com `status <> 'cancelled'` — abertas e pagas — pelo valor **bruto**. |
| **Cliente** (quem arca no fim) | O que foi **repassado ao cliente** neste veículo: contas de repasse do razão (`vehicle_financial_position.reimbursed`). Cobre multa cobrada dele, rateio de manutenção/despesa e custo que ele bancou. **Não** vem de `payables.customer_amount`: a multa do cliente é lançada como despesa 100% da empresa (o auto é lavrado contra o veículo e a proprietária responde ao órgão) e a responsabilidade dele só existe na **cobrança de repasse**. |
| **Empresa** (quem arca no fim) | Despesas totais − Cliente. |
| **Repasse ao cliente** | Adiantamento: a empresa paga o fornecedor e recupera a parte do cliente, por **cobrança** ou por **crédito** (`reimbursement: 'credit'` — vira saldo em `customer_credits`, sem cobrança nenhuma). **Adiantado** = `max(customerBears, repasse via cobrança)` — o maior entre o total do razão (`vehicle_financial_position.reimbursed`, enxerga os dois caminhos) e o que os itens de cobrança sozinhos somam; **já devolvido** = quanto dos pagamentos quitou repasse **por cobrança** (crédito consumido não é "devolvido" em dinheiro, é abatimento numa cobrança futura); **a devolver** = a diferença. |
| **Investido** | `acquisition_amount` + **despesas que ficam com a empresa** (o que ela desembolsa a fornecedores — só contas em que ela deve ao fornecedor; despesa que o **cliente pagou direto à oficina** fica de fora) **menos o que foi repassado ao cliente em cobrança**. |
| **Recuperado** | Recebido (moto, sem repasse, sem caução) + `sale_value` (a partir do mês da venda). |
| **Payback** | Primeiro mês em que recuperado ≥ investido. |
| **ROI** | `(recuperado − investido) / aquisição × 100` — só aparece depois do payback (antes dele seria um número negativo grande, sem utilidade). |
| **Início da linha do tempo** | O mais cedo entre `vehicles.created_at` e o `start_date` da locação mais antiga. `created_at` é quando o veículo entrou no sistema, não quando começou a operar. |

As regras são funções puras em `@gomoto/core`, com teste Vitest: `calculateVehiclePayback` (`vehicle-payback.ts`), `summarizeVehicleIncome` e `deductPassThrough` (`vehicle-income.ts`), `summarizeVehicleReceivables` e `summarizeExpenseResponsibility` (`vehicle-receivables.ts`).

## Bug corrigido: caução vazando para "Recebido"

`summarizeVehicleIncome` classifica cada item de cobrança pela **natureza da conta** (`financial_accounts.kind`, via embed) em receita, repasse ou "outro". Antes, a função anterior (`splitPassThrough`) só reconhecia repasse (prefixo `repasse_`) e tratava **tudo o mais** — inclusive caução (`caucoes_a_devolver`, conta de passivo) — como recebimento próprio da moto. Toda locação com caução cria uma cobrança 100% dela (`locacoes/actions.ts`); quando o cliente a pagasse, o valor entraria em Recebido, Recuperado e no percentual de payback, exatamente o que o ADR 0024 existe para proibir ("caução é passivo, nunca receita").

Correção: item com `kind` fora de `revenue`/`reimbursement` nunca entra em nenhum total. Testado por unit test (`vehicle-income.spec.ts`) e validado ao vivo: criada uma cobrança de caução de R$ 500 via `fn_create_charge` (mesma função que a tela de locação usa) e paga via `payment_allocations` — o Recebido do resumo permaneceu em R$ 87,87, sem se mover.

## Bug corrigido: repasse por crédito não aparecia em "Repasses ao cliente"

Achado investigando um veículo real em produção (dado retroativo de meses passados) que tinha 2 manutenções rateadas com o cliente resolvidas por **crédito** (`reimbursement: 'credit'`) em vez de cobrança — a empresa dá um saldo em `customer_credits` ao cliente, sem emitir `charge_items` nenhum. `income.passthrough_billed` (que só soma `charge_items`) mostrava R$ 1.210,97 de repasse, enquanto o card "Despesas → Cliente" (que usa `vehicle_financial_position.reimbursed`, ligado ao razão) mostrava R$ 1.245,97 — R$ 35,00 de diferença, os dois créditos.

O headline "Despesas da empresa"/"Investido" **não** foram afetados: `companyPaidIds` já exclui corretamente qualquer payable sem lançamento de `contas_a_pagar`, e um repasse por crédito nunca gera esse lançamento (a empresa não deve nada ao fornecedor nesses casos — ou o cliente pagou direto, ou o crédito zera a conta). O problema era só a linha "Repasses ao cliente" mostrar um total incompleto.

Correção: "adiantado" passou a ser `max(customerBears, income.passthrough_billed)` — o maior entre os dois, cobrindo cobrança e crédito. Validado direto em produção (projeto `gomotos2`, veículo SRR1F11): a linha passou a mostrar R$ 1.245,97, batendo com o card ao lado.

## Bug corrigido: consumo de crédito do cliente contava como "Recebido" de novo

Mesmo veículo, achado ao explicar por que setembro tinha R$ 1.869 de "entrada": 3 das 10 alocações do mês (R$ 30 + R$ 5 + R$ 234) eram `payments.method = 'credit'` — o cliente tinha crédito de manutenções anteriores (o próprio bug acima) e a empresa usou esse crédito para abater cobranças de aluguel em aberto, meses depois. Nenhum dinheiro novo entrou; é o mesmo valor que já saiu de "despesas da empresa" no momento em que o crédito foi concedido (`credit_granted`). Contar de novo no "Recebido" duplicava.

Distinção importante: **retenção de caução (`method = 'deposit_retention'`) é diferente e continua contando como recebido** — reter parte de uma caução para quitar um débito é a empresa deixando de devolver dinheiro que devolveria, um ganho real no momento em que acontece. Já o crédito consumido não é um evento novo — é a liquidação de uma obrigação que a empresa já tinha reconhecido antes. No mesmo veículo, R$ 1.600,00 dos R$ 1.869,00 de setembro eram retenção de caução — ficaram contando normalmente.

Correção: `IncomeAllocation` ganhou `is_cash: boolean`; `summarizeVehicleIncome` ignora inteiramente alocação com `is_cash = false` (não entra em `own_receipts` nem em `received_by_source`). Em `page.tsx`, `is_cash = payments.method !== 'credit'`. Testado (`vehicle-income.spec.ts`) e validado em produção: "Recebido" do resumo caiu de R$ 8.115,71 para R$ 7.846,71 (−R$ 269,00, os três créditos), com Lucro, % recuperado e payback recalculados na mesma proporção. O card "Recebimentos das locações → Recebido" (que mede dívida quitada, não caixa) **não foi alterado** por este fix — continua somando qualquer método, de propósito, e por isso pode divergir do "Recebido" do resumo quando houver crédito consumido. Se isso for confuso na prática, é candidato a um ajuste futuro (talvez uma nota tipo "dos quais R$X por crédito/caução").

Também achado nesta investigação, sem correção ainda: os pagamentos retroativos deste veículo têm `paid_at = created_at` no segundo exato — ou seja, a data considerada não foi a data real do pagamento passado, foi a data em que o registro foi digitado. O gráfico usa `paid_at` corretamente; o problema é o dado, não a tela.

## Exemplo: multa do cliente (a empresa paga o órgão e cobra o cliente)

Multa de R$ 1.000 de responsabilidade do cliente; a moto tem aquisição de R$ 12.000.

1. A multa é registrada: nasce uma conta a pagar da empresa (R$ 1.000, `customer_amount = 0`) **e** uma cobrança de repasse ao cliente (R$ 1.000, conta `repasse_multa`).
2. **Despesas:** total R$ 1.000, **Cliente** R$ 1.000, Empresa R$ 0. **Repasses ao cliente:** R$ 1.000 adiantados e cobrados; a devolver R$ 1.000 até o cliente pagar. **Composição das despesas:** "Despesa com multas" R$ 1.000 (bruto).
3. **Resumo e retorno do investimento não mudam.** Despesas da empresa = R$ 0 (a multa é abatida pelo repasse); Investido e Recuperado não sobem. É adiantamento, não desempenho da moto.
4. **Recebimentos:** a cobrança entra em "A receber" e, se vencer, em "Em atraso".
5. Quando o cliente paga: **Recebido** (card Recebimentos) +R$ 1.000, com o aviso "inclui R$ 1.000 de multas e custos repassados". **Composição das entradas** ganha a categoria "Repasse de multa" R$ 1.000. O **Recebido do resumo, o Lucro e o percentual de payback não se mexem**.

Por que assim: se o repasse entrasse no retorno, a multa devolvida somaria R$ 1.000 em Investido **e** em Recuperado ao mesmo tempo e o percentual saltaria sem a moto ter rendido nada (medido: 0,7% → 8,4% num teste anterior desta mesma tela, antes da correção).

Fora do escopo do sistema hoje: indicação do condutor infrator (art. 257 do CTB), em que o cliente paga direto ao órgão e a empresa não desembolsa. A multa sempre gera a conta a pagar da empresa.

## Fontes de dados

| Dado | Fonte |
|---|---|
| Veículo, aquisição, venda | `vehicles` (`acquisition_amount`/`sale_value`/`sold_at` não passam pelo razão — decisão de 2026-08-17) |
| Locações | `rentals` filtrado por `vehicle_id` (`charges` não tem `vehicle_id`: o veículo chega pela locação) |
| Saldo, atraso | `charge_balances` (view; ADR 0024, Princípios 2 e 4), filtrado para excluir cobrança sem item de receita/repasse (caução) |
| Composição das cobranças (receita × repasse × caução) | `charges` + embed `charge_items(amount, credit_account_code, source_module, source_id, financial_accounts(kind, name))` das locações do veículo — `kind` decide a natureza, `name` vira a categoria na composição das entradas |
| Recebido com data | `payment_allocations` + embed `payments!inner(paid_at, reversed_at)` e `charges!inner(rental_id, status)`, filtrado nas locações do veículo. Alocação, não o valor do pagamento: um pagamento pode quitar cobranças de outros veículos |
| A emitir | `rental_billing_schedules` (`status = 'scheduled'`, locações ativas) |
| Despesas | `payables` + embed `financial_accounts(name)` — categoria pelo nome real da conta, não por `source_module` (`'expense'` cobre documentação, seguro e avulsa) |
| Repassado ao cliente (card Cliente) | `vehicle_financial_position.reimbursed` (uma linha; ledger) |
| Quais contas a empresa deve ao fornecedor | `financial_entries` com `account_code = 'contas_a_pagar'`, `direction = 'credit'` e `payable_id` do veículo |

O ledger só entra em dois pontos pequenos (repasse agregado e quem deve ao fornecedor, acima); a receita, o custo e o payback **não** dependem dele. Agregação em JS por veículo: volume baixo, sem risco do corte de 1.000 linhas do PostgREST (a view `cash_flow_by_month` do dashboard existe por ser tenant-wide).

## Decisão registrada: dinheiro, não competência

O ledger reconhece receita na **emissão** da cobrança (`charge_issued`) e custo na **criação** da conta a pagar; o pagamento só move caixa. Uma versão anterior desta tela exibia "Receita faturada" e "Resultado (faturado)" — corretos contabilmente, mas enganosos para o operador (uma locação com 12 cobranças vencidas e nada pago aparecia como receita alta). A tela passou a usar o dinheiro recebido, que é também o que o PRD 0008 define (RN-040 a RN-045). O ledger continua sendo a fonte de DRE e dashboard; esta tela só o consulta para saber quanto foi repassado ao cliente e quais contas a empresa deve ao fornecedor.

`calculateVehicleROI` (`roi.ts`, RN-040..045) segue sem chamador — a tela usa `calculateVehiclePayback`, que também devolve a série mensal.

## Componentes

- `page.tsx` — queries e montagem (Server Component).
- `_components/FinancialBlocks.tsx` — `Stat` (número com ponto de legenda) e `SegmentedBar` (barra proporcional com 2px de respiro).
- `_components/VehicleFinancialCharts.tsx` — `VehiclePaybackChart`, `VehicleMonthlyChart`, `VehicleIncomeBreakdownChart`, `VehicleCostBreakdownChart` (Client Components, Recharts, tokens de tema; os dois últimos compartilham `CategoryBreakdownChart` internamente, só muda a cor e o rótulo).
- `_components/VehicleFinancialActions.tsx` e `actions.ts` — inalterados.

## Quando reavaliar

- Tela "comparar frota inteira": extrair a série mensal para uma view `vehicle_cash_flow_by_month`, em vez de agregar em JS por veículo.
- Encargo de atraso previsto no "Em atraso": hoje é calculado só na tela da cobrança (`calculateLateCharge`); somar aqui exigiria a política vigente de cada cobrança.

## Tags
`#projeto/telas` `#gomoto` `#financeiro`
