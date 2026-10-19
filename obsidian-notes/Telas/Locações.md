# 🔑 Tela: Locações — [[GoMoto]]

Rota base: `/locacoes` | Tipo: mistura de Server Component (leitura/SSR) + Client Component (formulários)

> Nota criada em 2026-07-24 para cobrir a família de rotas de locação — referenciada pela Spec 0008 (`related: [[Telas/Locações]]`) mas nunca escrita até então.

## Rotas

| Rota | Arquivo | Responsabilidade |
|---|---|---|
| `/locacoes` | `page.tsx` | Listagem de contratos (ativos/encerrados) |
| `/locacoes/fila` | `fila/page.tsx` | Fila de espera |
| `/locacoes/nova` | `nova/page.tsx` + `_components/RentalForm.tsx` (modo criação) | Criação de locação com preview de cobranças + geração opcional de contrato (PDF) + vínculos de Perfil de Vistoria (Spec 0009) |
| `/locacoes/[id]` | `[id]/(tabs)/layout.tsx` + `[id]/(tabs)/page.tsx` | Detalhe — abas (ver seção própria abaixo). Aba **Principal**: cards de totais + vínculo cliente/veículo — somente leitura |
| `/locacoes/[id]/contrato` | `[id]/(tabs)/contrato/page.tsx` | Aba **Contrato**: dados do contrato, preview/download do PDF, anexo do assinado — somente leitura |
| `/locacoes/[id]/vistorias` | `[id]/(tabs)/vistorias/page.tsx` | Aba **Vistorias**: status check-in/check-out + comparação + agendamento periódico (Spec 0009) — somente leitura |
| `/locacoes/[id]/manutencoes` | `[id]/(tabs)/manutencoes/page.tsx` | Aba **Manutenções**: manutenções do veículo cujo período cai dentro da locação — somente leitura |
| `/locacoes/[id]/financeiro` | `[id]/(tabs)/financeiro/page.tsx` | Aba **Financeiro**: extrato completo — cobranças, caução, histórico de reajustes |
| `/locacoes/[id]/editar` | `[id]/editar/page.tsx` + `_components/RentalForm.tsx` (modo edição) | **Só** caução + observações — fora do group de abas, sem barra de abas |
| `/locacoes/[id]/ajustar` | `_components/AdjustRentalPeriodForm.tsx` | **Dona única** dos seis parâmetros do cronograma: início, fim, ciclo, dia de vencimento, valor e pro rata ([[decisions/0035-ajuste-de-periodo-da-locacao]]) — fora do group de abas |
| `/locacoes/[id]/renovar` | redirect → `/ajustar` | Rota mantida viva para links salvos e abas abertas |
| `/locacoes/[id]/reajustar` | redirect → `/ajustar` | Idem |
| `/locacoes/[id]/encerrar` | `_components/TerminateForm.tsx` | Encerrar o contrato e liberar o veículo (`terminateRental`) — fora do group de abas |
| `/locacoes/[id]/cobranca-avulsa` | — | Cobrança avulsa fora do ciclo — fora do group de abas |

## Detalhe da locação em abas (2026-08-01)

`/locacoes/[id]` deixou de ser uma página única (contrato + vínculo + vistoria + prévia de cobranças tudo empilhado) e virou 5 abas via **rotas aninhadas** — não um componente de Tabs client-side. Ver [[decisions/0017-rotas-aninhadas-para-abas-de-locacao]] para a análise completa da decisão (trade-off contra Tabs client-side/shadcn).

- **Estrutura**: route group `[id]/(tabs)/` (não aparece na URL) contendo `layout.tsx` (header + nav de abas) e uma pasta por aba (`page.tsx` = Principal, `contrato/`, `vistorias/`, `manutencoes/`, `financeiro/`). Cada aba é um Server Component independente que busca só os dados que usa — trocar de aba é uma navegação real (round-trip ao servidor), não troca de estado local.
- **`renovar`/`encerrar`/`reajustar`/`cobranca-avulsa`/`editar` ficam fora do group**, de propósito — são formulários full-page com header próprio, não abas de visualização.
- **`_lib/get-rental-core.ts`**: fetch base de `rentals` (+ customer/vehicle/contract_template, mesmo `.select()` literal de sempre) envolto em `React.cache()` — dedupe por request entre `layout.tsx` e a aba ativa, um único round-trip a `rentals` mesmo com dois Server Components pedindo os mesmos dados. `warnMissingContractFields` roda na aba Contrato, que é quem de fato consome os campos de contrato.
- **`_lib/shared.ts`**: labels/badges (`STATUS_BADGE`, `CYCLE_LABEL`, `SCHEDULE_STATUS_BADGE`, `INSPECTION_STATUS_BADGE`, `MAINTENANCE_STATUS_BADGE`, `MAINTENANCE_TYPE_LABEL`) e o helper `fmt()` compartilhados entre abas — evita reimportar de `/financeiro` como antes.
- **`InspectionStatusCard`** saiu de dentro do antigo `page.tsx` monolítico para `(tabs)/_components/InspectionStatusCard.tsx` — só usado pela aba Vistorias.
- **Aba Manutenções é funcionalidade nova, não só extração**: não existe FK `maintenances → rentals` (a tabela só referencia `vehicle_id`, ver `supabase/migrations/20260611002632_initial_schema.sql`). A associação com a locação é inferida por `filterMaintenancesInRentalPeriod()` (`packages/core/src/rules/maintenance.ts`) — mesmo veículo + `scheduled_date` ou `completed_date` dentro de `[start_date, end_date]` da locação. Testado em `maintenance.test.ts`.

## Decisão de escopo: "Editar" não mexe em nada que afeta cobranças

Decisão de 2026-07-24, revista em 2026-09-10 pela [[decisions/0035-ajuste-de-periodo-da-locacao]]:
o que mudou foi **quem** é o dono de cada campo, não o princípio. Cada campo que
impacta cobranças continua com **um dono só**, nunca "Editar":

| Campo | Dono | Reprocessa cobranças? |
|---|---|---|
| Cliente, veículo, tipo de contrato | — (imutável após criação) | — |
| **Início, fim, ciclo, dia de vencimento, valor do ciclo, pro rata** | **Ajustar** (`adjustRentalPeriod` → `fn_adjust_rental_period`) | Sim — regera o cronograma a partir de uma data de vigência; cobrança emitida na faixa é cancelada, e cobrança paga na faixa é impedimento |
| Encerrar o contrato e liberar o veículo | **Encerrar** (`terminate_rental`) | Sim — cancela o cronograma `scheduled` posterior à data de encerramento |
| Vínculos de vistoria | — (imutável após criação) | — |
| Caução, Entrada, observações, modelo de contrato | **Editar** (`updateRental`, `updateContractTemplate`) | Caução e Entrada sim, **se ainda pendentes** — documento emitido não se reescreve, cancela-se e emite-se outro; se já pagas, o campo vira somente-leitura |

Antes da ADR 0035, `end_date` tinha **dois** donos (Renovar para esticar, Encerrar
para antecipar) com regras divergentes, e início/ciclo/dia/pro rata não tinham
nenhum — a orientação era "encerre e crie outra locação", o que custava o contrato
inteiro por um erro de digitação.

`RentalForm.tsx` é compartilhado entre criação e edição: em modo edição, a seção
"Condições do contrato" fica somente-leitura com link para Ajustar/Encerrar, e o
formulário vira single-step (sem o wizard de preview, que só faz sentido na criação).

## Ajustar: a prévia é a mesma função que grava

A decisão inteira (o que é mantido, o que é substituído, qual cobrança é cancelada,
quais parcelas nascem) está em `planPeriodAdjustment`
(`packages/core/src/rules/schedule.ts`). A tela chama para desenhar a prévia; a
Server Action chama para gravar. Não existe segunda implementação — mesmo motivo de
`generateSchedule`.

Pontos que quem for mexer precisa saber:

- **`sequence_number` deixou de ser ordem cronológica.** As linhas novas continuam a
  numeração (`UNIQUE (rental_id, sequence_number)` proíbe reuso), então um ajuste
  produz `1,2,3, 8,9, 4(superseded), 10, …`. Toda leitura de cronograma ordena por
  `period_start`; a aba Financeiro separa `superseded`/`cancelled` atrás de um
  `<details>` "Histórico do plano".
- **A página lê no servidor**, não por `useRentalSchedule`. A tela anterior
  alimentava a prévia pelo cache do TanStack, que `revalidatePath` não alcança:
  depois de gravar, a prévia seguia anunciando as mesmas mudanças.
- **A RPC reconfere sob o lock da locação** que nenhuma linha a substituir tem
  cobrança viva (`LINE_HAS_LIVE_CHARGE`). Não é redundância: entre a leitura da tela
  e a escrita cabem o job de emissão e um webhook de pagamento.
- **Cobrança retroativa avisa, não bloqueia.** Parcela cujo período já começou vira
  cobrança na próxima rodada, possivelmente já vencida; a prévia marca "Emite agora"
  e "Já vencida" (token `critical`, alarme universal da ADR 0020).

## Um veículo, uma locação (ADR 0036, 2026-09-10)

A moto não pode estar com dois clientes ao mesmo tempo, e a regra mora **no banco**
([[decisions/0036-um-veiculo-uma-locacao]]):

- `idx_rentals_one_active_per_vehicle`: no máximo uma locação `active` por veículo.
  Vale para qualquer caminho, inclusive `INSERT` direto.
- `trg_rentals_vehicle_period`: o período `[início, fim)` da locação ativa não cruza o de
  outra do mesmo veículo. Devolver e retirar no mesmo dia é permitido.

Na tela: `createRental` traduz `VEHICLE_ALREADY_RENTED` e `VEHICLE_PERIOD_OVERLAP` para
português. A prévia do `/ajustar` recebe as outras locações do veículo
(`other_rentals`) e bloqueia antes do clique. O formulário de criação continua listando
só veículos `available`, mas isso agora é conveniência, não a garantia.

## Registro de KM (Spec 0014, 2026-09-12)

Ver [[Specs/0014-registro-km-locacao]] para o detalhamento completo. Resumo para quem só mexe em tela:

- **`RentalForm.tsx`** (criação): campo "Km inicial \*" aparece assim que um veículo é selecionado, pré-preenchido com `vehicle.km_current` — editável, pois o km real da entrega pode diferir do que o cadastro do veículo registra naquele momento. Entra no payload de `createRental` e na chamada de `resolveContractVariables` usada por "Gerar contrato" (o contrato ainda não existe no banco nesse ponto — por isso o valor vem do form, não de `rental.km_initial`).
- **`TerminateForm.tsx`** (encerramento): campo "Km final" obrigatório, com piso calculado por `minimumFinalKm(vehicle.km_current, rental.km_initial)` (`@gomoto/core`) — o maior entre os dois. Bloqueia "Confirmar Encerramento" enquanto abaixo do piso; a RPC `terminate_rental` é a fonte de verdade (`KM_BELOW_MINIMUM`), o cálculo na tela é só feedback imediato.
- **Detalhe (`(tabs)/page.tsx`)**: card "Veículo" exibe km inicial, km final e km rodado (`km_final - km_initial`). `—` quando `km_initial`/`km_final` são `null` — locação criada antes desta feature.
- **Contrato**: a variável `{{km_inicial}}` deixou de resolver de `vehicle.km_current` (mutável — muda a cada km rodado depois da entrega) e passou a resolver de `rentals.km_initial` (congelado na criação). Corrige um bug real: o PDF reimpresso mudava de km sozinho conforme o veículo rodava. `vehicle.km_current` continua como fallback para locação anterior a esta feature (`km_initial` nulo).
- **`km_final` é exigido em TODO encerramento**, inclusive de locação criada antes desta feature (`km_initial` nulo entra como 0 no piso) — decisão de escopo da Spec, sem carve-out para locação legada. Isso quebrou toda a suíte E2E que encerrava locação via RPC direta sem passar o campo nas fixtures — corrigido no mesmo PR (`p_km_final` acrescentado a cada chamada direta de `terminate_rental` em `apps/web/tests/`).
- **Pegadinha de banco**: `terminate_rental` ganhou um parâmetro novo (`p_km_final`) — para o Postgres isso é uma função DIFERENTE, não uma substituição. `CREATE OR REPLACE FUNCTION` teria criado um segundo overload e deixado a versão de 5 parâmetros (sem exigir km) viva ao lado da nova. A migration precisa de `DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN)` antes do `CREATE OR REPLACE`, e — como o `DROP` também apaga as concessões (ADR 0034) — de `GRANT EXECUTE ... TO authenticated, service_role` explícito depois, ou `authenticated` perde a capacidade de encerrar locação em silêncio.

## Multa por rescisão antecipada (Spec 0015, 2026-09-13)

Ver [[Specs/0015-multa-rescisao-antecipada]] para o detalhamento completo. Resumo para quem só mexe em tela:

- **`RentalForm.tsx`** (criação e edição): dois campos opcionais na seção "Condições do contrato" — "Multa por rescisão antecipada (R$)" e "Prazo mínimo (dias)". Sem valor padrão: locação criada sem preenchê-los nunca exibe nem cobra multa (RN-003). Diferente do resto dessa seção (que trava tudo em modo leitura na edição — tipo, ciclo, dia de vencimento, etc. só mudam via Ajustar/Encerrar), os dois campos da multa continuam editáveis em locação ativa (RF-002); a Server Action recusa (`CONFLICT`) se a locação já foi encerrada.
- **`TerminateForm.tsx`** (encerramento): quando a locação tem os dois campos configurados e a data de encerramento cai dentro do prazo mínimo, aparece a seção "Multa por rescisão antecipada" — o operador decide explicitamente cobrar ou não (sem default; bloqueia "Confirmar Encerramento" até escolher) e, se cobrar, quanto abater de caução e/ou crédito do cliente. O que não for abatido vira cobrança em aberto automaticamente — não é um campo à parte, é só o saldo derivado de uma cobrança parcialmente paga.
- **Mudança de arquitetura por trás da tela**: a decisão da multa não é mais uma Server Action separada — entra como 3 parâmetros novos na própria RPC `terminate_rental` (`p_charge_fine`, `p_fine_deposit_amount`, `p_fine_credit_amount`), que cria a cobrança e aplica os abatimentos na MESMA transação do encerramento. Isso corrigiu de graça uma falha pré-existente: a RPC não travava a linha da locação nem reconfirmava `status='active'` no `UPDATE` final, então duas tentativas concorrentes de encerrar a mesma locação podiam ambas ter sucesso.
- **Não confundir com "multa de trânsito"** (`/multas`, módulo separado) — nomenclatura explícita na tela ("multa por rescisão antecipada"/"multa contratual") para não colidir com o nome popular do outro domínio.
- **Aba Contrato (`(tabs)/contrato/page.tsx`)**: linha "Multa por rescisão antecipada" na tabela de condições, exibida só quando algum dos dois campos está configurado — valor formatado + prazo mínimo em dias com a data-limite calculada (`start_date + minimum_term_days`, mesma conta de `isWithinConfiguredMinimumTerm`). `RentalCore`/`get-rental-core.ts` precisou ganhar os 2 campos no tipo (o `select('*')` já trazia do banco).
- **`RENTAL_MINIMUM_DURATION`/`isRentalTerminationWithinMinimum` continuam existindo**, mas passaram a servir só à elegibilidade de transferência do `rent_to_own` (compra programada cumprida vira `status='transferred'`) — descoberto durante a implementação que essa era a mesma função reaproveitada para o antigo aviso de multa fixa. `CONTRACT_TERMINATION_FINE_BRL` foi removida (não tem mais consumidor); a multa configurável usa a função nova `isWithinConfiguredMinimumTerm`.

## Distribuição dirigida de caução e crédito no encerramento (Spec 0017, 2026-09-21)

Ver [[Specs/0017-abatimento-caucao-credito]] e [[PRDs/0017-abatimento-caucao-credito]]. Substitui o "Acerto final" agregado da [[decisions/0026-acerto-final-caucao-e-credito|ADR 0026]]: o operador não escolhe mais um valor que o sistema espalhava da cobrança mais antiga para a mais nova — informa, **dívida a dívida**, quanto de caução e quanto de crédito quita cada uma.

- **`TerminateForm.tsx`**: as seções "Destino da caução", "Destino do crédito" e o abatimento dentro de "Multa por rescisão antecipada" viraram **uma** seção, "Distribuição de caução e crédito" — tabela com uma linha por dívida (origem, devido, input de caução, input de crédito, resta), resumo de alocado/restante por saldo e, abaixo, o destino da **sobra**. Linhas em `h-9`: o vencimento fica no `title`, não na célula.
- **A multa é só mais uma linha** (RN-007). A decisão de cobrar continua na seção da multa; decidido cobrar, ela entra na tabela. Seu `charge_id` só nasce dentro da RPC, então a linha é virtual (`FINE_DEBT_ID`) e os valores dela seguem nos campos escalares `fine_deposit_amount`/`fine_credit_amount` — a tela unifica, o payload não.
- **Feedback instantâneo é `computeDebtDistribution`** (`@gomoto/core`, `rules/settlement.ts`): soma em centavos inteiros, teto por linha e por saldo, sem ir ao servidor. Não decide nada — quem recusa de verdade é `terminate_rental`. `buildTerminationAllocations` monta o payload (só dívidas reais com valor > 0 nos arrays), para essa regra não morar no handler.
- **Caução e crédito nunca passam do que cabem, os dois lados (2026-09-21, corrigindo o mesmo dia)**: cada campo corta o valor digitado no teto da linha — o menor entre o saldo que as OUTRAS linhas deixaram e o que a dívida ainda deve depois da OUTRA fonte já aplicada ali (`max_deposit`/`max_credit` de `computeDebtDistribution`; regra em `clampAllocationInput`). Digitar, colar ou usar a setinha dá no mesmo. Os dois campos têm o botão **"Máx."** por linha, que aplica esse teto; fica desligado quando a linha já está no teto ou não há saldo/dívida disponível, e volta a ligar se outra linha for liberada. É ação do operador numa linha, não a "sugestão automática" que o PRD deixou fora da V1 (nada é preenchido sozinho).
- **Bug corrigido no mesmo dia**: a primeira versão só limitava e dava atalho ao crédito — a caução aceitava qualquer valor digitado e só avisava (sem cortar) que passava do limite. Ao vivo, isso deixava a caução "impossível de usar" quando o crédito já tinha coberto uma dívida inteira (ex.: clicando "Máx." do crédito): o campo de caução aceitava um número, mas a linha já estava paga e "Confirmar Encerramento" ficava travado sem explicação clara na hora de digitar. A caução ganhou o mesmo corte e o mesmo botão do crédito — quando uma linha está saturada por uma fonte, a OUTRA mostra teto zero na hora, em vez de aceitar um valor que só falha ao confirmar. Como o teto de cada lado desconta o que a outra fonte já usou na mesma linha, usar o "Máx." do crédito antes do "Máx." da caução (a ordem que o Alan pediu — crédito primeiro, depois caução) funciona sem conta de cabeça, mas nenhuma ordem é imposta: qualquer um pode vir primeiro.
- **Sobra**: com cobrança ainda em aberto a sobra de caução **exige escolha** (devolver ou deixar em custódia) — nunca sai dinheiro do caixa por inércia. Sem dívida, devolver é o padrão. O crédito é do cliente e sobrevive ao contrato: deixar é o padrão. "Deixar em custódia" não chama nada; o depósito fecha do mesmo jeito e o saldo segue em `deposit_balances`.
- **Motivo único** para toda a caução distribuída em dívidas reais (ADR 0026), não um por linha. A caução que vai para a multa não pede motivo (a própria cobrança se explica; nunca pediu).

**Mudança de arquitetura por trás da tela**: `terminate_rental` ganhou `p_deposit_allocations`, `p_credit_allocations` (arrays `{charge_id, amount}`) e `p_deposit_reason`, e aplica tudo na **mesma transação** que trava e fecha a locação — qualquer recusa (dívida que mudou, saldo que acabou) desfaz a distribuição inteira, inclusive o encerramento (RN-006). `closeRentalFinancial` e `applyCreditToRentalDebt` foram **removidas**; a devolução da sobra virou `returnRemainingDeposit` (só saída de caixa, fora da transação). A RPC também passou a fechar `deposits.closed_at` sempre, e devolve os saldos **depois** da distribuição.

- **Guarda que a Spec não previa, achada ao provar a premissa**: `charge_balances.open_amount` é `itens − alocações` e **ignora o status**, e `fn_retain_deposit_on_charge` também não olha status — uma cobrança cancelada por outro operador entre a leitura da tela e a confirmação continuava aceitando caução (verificado no banco, em transação revertida). A RPC agora recusa com `CHARGE_NOT_OPEN`. E recusa `CHARGE_NOT_IN_RENTAL` para dívida de **outra locação do mesmo cliente**: as `fn_*` só conferem o dono pelo cliente, e "outras locações" é decisão de produto (PRD §3.5), não limitação técnica.
- **Autor do abatimento preservado**: as actions removidas passavam `user.id`; dentro da RPC isso é `auth.uid()`. Sem isso `payments.received_by` ficaria nulo. (A multa da Spec 0015 continua sem autor — herdado, não tratado aqui.)
- **`charge_balances` ganhou `source_module`** (apenso ao final: `CREATE OR REPLACE VIEW` não reordena colunas) — é o que rotula a origem de cada dívida na tabela.
- **Herdado, não corrigido**: `cancelCharge` (Spec 0016) roda **antes** da RPC e fora da transação. Se a distribuição for recusada depois, as cobranças fora do período já canceladas continuam canceladas e a locação segue ativa. A atomicidade desta Spec cobre a distribuição, não esse passo anterior.

## Bug de cobrança em dobro no primeiro ciclo (corrigido 2026-09-10)

Achado enquanto se escrevia o teste do ajuste. Com `use_pro_rata: false`, quando o
contrato começava **no próprio dia de vencimento**, `firstDueDate` devolvia a data de
início e a primeira volta do laço montava um período de duração zero cobrando o ciclo
cheio. Um contrato mensal de 10/10 a 10/03 com vencimento dia 10 saía com 6 cobranças
de R$ 600 em vez de 5 — R$ 600 a mais, num arranjo trivial ("vence todo dia 10,
começou dia 10").

O ramo com pro rata nunca teve o defeito: lá as fronteiras já descartam o vencimento
que coincide com o início. Dois testes existentes em `rentals.spec.ts` **codificavam o
bug como esperado** (contavam vencimentos, não períodos) e foram corrigidos junto.

## Aba Financeiro: listas longas agrupadas por ação e mês (2026-10-18)

Um contrato semanal de 2 anos tem ~105 parcelas; no meio dele a aba mostrava
~105 linhas de cronograma + ~90 de cobranças, e o que pedia ação (vencidas)
ficava perdido entre as pagas. Decisão do Alan: agrupar **por ação + mês**.

- **Cronograma contratado** lista só o que está **a emitir**. Parcela emitida já
  aparece em Cobranças com o saldo real — repeti-la dobrava a lista. As próximas
  4 (`UPCOMING_VISIBLE`) ficam visíveis; o resto, um `<details>` por mês com
  quantidade e subtotal. Os cards (Total contratado / Já emitido / A emitir)
  seguem somando o plano inteiro.
- **Cobranças**: em aberto e vencidas sempre visíveis; pagas/baixadas num
  `<details>` "Pagas" (total pago), subdividido por mês, mais recente primeiro.
- Sem JS no cliente: `<details>` nativo, como o "Histórico do plano" já usava.
  Cada mês é uma tabela própria, então as colunas usam `table-fixed` +
  `colgroup` compartilhado (`ScheduleColGroup`/`BillingColGroup`) para alinhar.
- Agrupamento em `groupByMonth` (`[id]/(tabs)/_lib/shared.ts`, teste ao lado).
- Chevron com grupo **nomeado** (`group/month`, `group/settled`): os `<details>`
  são aninhados, e `group-open` sem nome giraria o chevron dos meses ao abrir o pai.

Limite conhecido: cliente com dezenas de cobranças vencidas mostra todas — de
propósito, é a lista que pede ação.

## Tela travava ao digitar a data de início (corrigido 2026-10-18)

O `<input type="date">` emite cada estado intermediário do ano como data completa
("2" → `0002-10-18`, depois `0020`, `0202`, `2026`). Dois defeitos somados:

- **Fim calculado errado.** `computeEndDate` da tela montava `new Date(y, m - 1, d)`,
  que lê ano 0–99 como 1900 + ano: início `0002-10-18` + 3 meses dava fim `1903-01-18`,
  e a prévia gerava ~1.900 anos de cobranças a cada tecla. Virou
  `computeRentalEndDate` no core (`rules/rentals.ts`), que lê o ano literal.
- **Gerador quadrático.** `generateCycleCharges` buscava vencimentos com `.some()`
  dentro do laço — 18 s para 95 mil ciclos semanais. Agora usa `Set` (0,5 s).

Regras da tela desde então:

- **A prévia só calcula com data completa e plausível** — `isPlausibleRentalDate`
  (ano entre 2000 e 2100, `RENTAL_DATE_YEAR_RANGE`). Enquanto o ano está sendo
  digitado, nem a prévia é gerada nem o fim é recalculado a partir do início.
- **Erro de data só no `onBlur`** ("Data de início inválida"): avisar a cada tecla
  seria ruído, já que todo estado intermediário é "inválido".
- **`ChargePreview` desenha só as primeiras 24 cobranças de ciclo**
  (`PREVIEW_VISIBLE_CHARGES`) e resume o resto numa linha "+ N cobranças até dd/mm/aaaa"
  com o valor somado. Contagem e total do cabeçalho seguem considerando todas.

A faixa de anos **não** está no schema Zod (`RentalSchema` aceita qualquer
`YYYY-MM-DD`) — o servidor ainda aceitaria início em `0202-10-18` via payload direto.

## Caução gera cobrança própria (2026-07-26)

Caução deixou de ser só bookkeeping em `deposits` — ver detalhes completos em [[Specs/0008-modulo-financeiro]] (nota na FT-02). Resumo para quem só mexe em tela:

- Criação: checkbox "Caução já foi paga" em `RentalForm` (marcado por padrão) decide se a cobrança de caução (`billing_type='deposit'`) nasce `paid` ou `pending`.
- `/locacoes/[id]/editar` e `/locacoes/[id]/financeiro` buscam o deposit com `.in('status', ['pending', 'received'])` — **não** só `'received'`. Se algum código novo voltar a filtrar só `'received'`, o valor da caução pendente some do formulário de edição silenciosamente (bug já encontrado e corrigido uma vez).
- Labels de `billing_type`/`source` para `'deposit'` existem em 5 lugares diferentes (`lib/billing-status.ts` + mapas locais em `cobrancas/[id]/page.tsx`, `locacoes/[id]/financeiro/page.tsx`, `financeiro/page.tsx`) — todos duplicados, nenhum compartilhado. Adicionar um novo `billing_type`/`source` exige lembrar de todos eles.

## Entrada não reembolsável (2026-08-07)

Ver [[Specs/0010-entrada-locacao]] para o detalhamento completo. Resumo para quem só mexe em tela:

- Bloco **"Entrada (R$)"** em `RentalForm.tsx`, separado do bloco de Caução — mesma dinâmica paga/pendente (checkbox "Entrada já foi paga" + data de pagamento ou de vencimento), mas gera só 1 `billings` (`billing_type='down_payment'`), **sem** linha em `deposits` (RN-001: não é devolvível, não tem saldo a rastrear).
- Diferente da Caução, a Entrada **não tem página de edição sempre-editável**: em `/locacoes/[id]/editar`, o campo só aparece editável se a cobrança ainda está `pending`; se `paid`, vira um `<div>` somente-leitura ("Entrada já paga — não pode ser alterada"). Guardado por `canEditDownPayment` (`packages/core/src/rules/billings.ts`) tanto na UI quanto (defesa em profundidade) dentro de `updateRental`.
- Preview de cobranças (Step 2 da criação) lista a Entrada como uma linha extra na tabela (`ChargePreview`'s `extraRows` prop) — mistura com as cobranças de ciclo (`CycleCharge[]`) sem forçar `billing_type='down_payment'` a existir no union `BillingType` de `packages/core` (que só cobre os tipos que `generateCycleCharges` de fato gera).
- `terminate_rental` (RPC) parava de cancelar só `deposit` pendente com vencimento futuro — o mesmo risco existia pra Entrada e foi corrigido junto (RN-003): `billing_type NOT IN ('deposit', 'down_payment')` no filtro de cancelamento.
- **Bug pré-existente encontrado e corrigido no mesmo PR** (não é sobre Entrada, mas bloqueava a RF-004 dessa spec): `financeiro/veiculos/[id]/page.tsx` filtrava `billings` por `.eq('vehicle_id', id)`, mas `billings` nunca teve coluna `vehicle_id` (só `lease_id`) — a query sempre voltava vazia (Postgrest engolia o erro), então "Receita total" da tela de ROI do veículo sempre mostrava R$ 0,00, pra **qualquer** tipo de cobrança, não só Entrada. Corrigido com join `billings.select('..., rentals!inner(vehicle_id)').eq('rentals.vehicle_id', id)` (mesmo padrão já usado em `veiculos/[id]/page.tsx` para `inspections`).
- Labels de `billing_type`/`source` para `'down_payment'` seguem o mesmo problema de duplicação já registrado na seção da Caução acima (5 lugares diferentes) — adicionado `down_payment: 'Entrada'` em todos.

## Modelo de contrato + PDF assinado (2026-07-26)

Ver [[Telas/Contratos]] para o catálogo de variáveis e a mecânica de geração. Resumo do lado de locação:

- **Seletor opcional** em `RentalForm.tsx` (Step 1, só na criação): "Modelo (opcional)", alimentado por `useContractTemplates()`. Sem modelo selecionado, nada muda — dá pra anexar um PDF assinado avulso depois de qualquer forma.
- **Geração roda inteiramente no client**, no Step 2 ("Resumo do contrato"): `resolveContractVariables` (`@gomoto/core`) resolve as variáveis a partir do cliente/veículo já carregados nas listas do form (sem fetch adicional) + dos valores já digitados; `renderContractTemplateHtml`/`printHtmlDocument` (`apps/web/src/lib/`) reaproveitam o mesmo mecanismo de impressão do navegador já usado em `/contratos/modelos/[id]`. Não depende da locação existir no banco ainda.
- **Vínculo persistido**: `rentals.contract_template_id` é gravado via `update` best-effort logo após a RPC `create_rental_with_charges` (metadado informativo, sem necessidade de atomicidade com a criação das cobranças).
- **Anexo do PDF assinado**: `rentals.signed_contract_path`/`signed_contract_file_name`/`signed_contract_uploaded_at` (colunas flat, migration `20260727003144_rental_contract_documents.sql`) + bucket privado `rental-documents`. Upload direto no Storage via `SignedContractUpload.tsx` (client, mesmo padrão de `CustomerForm.tsx`), depois `attachSignedContract` (Server Action) grava o path. Visualização via signed URL computada em `[id]/page.tsx` (mesmo padrão de `clientes/[id]/page.tsx`).
- **Decisão: colunas flat em `rentals`, não uma tabela `rental_documents` genérica.** O pedido é um PDF assinado por locação (1:1), não N documentos. Evidência concreta contra a tabela genérica: `clients_documents` (o padrão análogo já existente para clientes) está órfã na prática — só é escrita por uma Server Action que nenhuma tela chama, nunca é lida em lugar nenhum; o padrão que de fato está em produção para documentos de cliente é coluna flat (`drivers_license_photo_url` etc.) + upload direto + signed URL local. Se surgir necessidade real de múltiplos anexos por locação no futuro, isso vira uma extração justificada depois — não construída antecipadamente.
- `rentals.pdf_url` (coluna morta desde a migration inicial, nunca lida/escrita por nenhum código) foi **renomeada** para `signed_contract_path` na mesma migration, em vez de deixar morta + criar 3 colunas do zero.

**Visualizar/baixar o contrato em `/locacoes/[id]` (2026-07-27), trocar o modelo só em `/locacoes/[id]/editar`:** `ContractPreviewPanel.tsx` (client, na seção "Contrato" da tela de detalhe) substitui o antigo link estático pro modelo. Mesmo padrão de resolução de variáveis do Step 2 da criação, mas alimentado com os dados **persistidos** da locação (props vindas do `page.tsx`, que faz um `select` explícito de `customer`/`vehicle` — só na criação o form usa `select('*')` via `@gomoto/data`, então lá qualquer coluna nova já chega de graça).

**Sincronia catálogo ↔ resolver ↔ select explícito (2026-07-27, ver [[Telas/Contratos]]):** `resolveContractVariables` agora retorna `Record<TemplateVariableKey, string>` (tipo derivado de `TEMPLATE_VARIABLES`) — esquecer de resolver uma chave nova do catálogo quebra o `typecheck`, não só um teste. Para as colunas de `customers`/`vehicles`, a fonte única é `CONTRACT_CUSTOMER_FIELDS`/`CONTRACT_VEHICLE_FIELDS` (`@gomoto/core`) — mas **não dá pra montar o `.select()` do Supabase a partir desses arrays em runtime** (`.join(',')` quebra a inferência de tipos do client tipado, que exige string literal). Por isso o `select` explícito de `/locacoes/[id]/page.tsx` continua copiado à mão, e `warnMissingContractFields(label, record, fields)` roda logo após o fetch (dev only) pra acusar em log se uma coluna nova em `CONTRACT_VEHICLE_FIELDS`/`CONTRACT_CUSTOMER_FIELDS` não foi replicada no `.select()` desta página.

- **`/locacoes/[id]` é só leitura pro modelo**: mostra o nome do modelo vinculado (link pra `/contratos/modelos/[id]`) + link "Trocar modelo (Editar) →". Decisão do usuário: a tela de detalhe não é o lugar pra alterar o quê está vinculado — isso é papel da tela de Editar, mesma regra de escopo que já vale pra caução/observações (ver seção acima).
- **Visualizar**: `openHtmlDocument` (`apps/web/src/lib/contract-print.ts`) abre o HTML já substituído numa aba nova via `window.open('', '_blank') + document.write` — não dispara impressão.
- **Baixar (PDF)**: reaproveita `printHtmlDocument` (mesmo mecanismo do Step 2 da criação e de `/contratos/modelos/[id]`).
- Botões desabilitados quando nenhum modelo está vinculado.
- **`/locacoes/[id]/editar`**: a seção "Modelo de contrato" do `RentalForm.tsx`, antes só na criação (`!isEditMode`), agora também aparece em modo edição — mesmo `<select>`, texto de ajuda diferente. `handleSubmit` em modo edição chama `updateRental` (caução/observações) e depois `updateContractTemplate` (novo modelo) em sequência.

## Histórico: Reajustar (F11) e Renovar

Ambas foram absorvidas por Ajustar em 2026-09-10. As RPCs `adjust_rental_schedule` e
`fn_renew_rental` continuam no banco marcadas como obsoletas por `COMMENT` — não
foram derrubadas porque função removida vira erro no meio da operação de quem estava
com a aba aberta. As rotas `/reajustar` e `/renovar` respondem com redirect.

## Vistoria (Spec 0009, 2026-07-30)

- **`/locacoes/nova`**: `RentalForm.tsx` ganha a seção "Vistoria" (só criação, `!isEditMode` — mesmo padrão de escopo da seção acima): dois seletores de Perfil de Vistoria (`useInspectionProfiles()`, filtrado a `archived_at === null`) — Check-in/Check-out e Periódica + frequência (dias, obrigatória sse o perfil periódico for selecionado, RN-005). Os três campos vão direto no payload de `createRental` → RPC `create_rental_with_charges` estendida, que insere `inspections` (check-in/check-out `pending`) e `inspection_schedules` (upfront) na mesma transação.
- **`/locacoes/[id]/vistorias`** (aba Vistorias, ver seção "Detalhe da locação em abas" acima): cards de status de check-in/check-out (link para `/vistorias/execute/[id]`, mesmo componente de execução usado na lista central de pendências, RF-018), comparação lado a lado quando ambos `completed` (`InspectionComparisonPanel.tsx`), e tabela de agendamentos periódicos com status derivado na leitura (`deriveInspectionScheduleStatus` de `@gomoto/core` — nunca de `@gomoto/data`, ver nota abaixo).
- **Vínculos são imutáveis após a criação** — mesma decisão de escopo de tipo/ciclo/dia de vencimento (tabela acima): não há fluxo de "editar vistoria" numa locação já criada.
- **Armadilha de bundling: Server Component não pode importar de `@gomoto/data`.** `packages/data`'s `index.ts` reexporta hooks (`createContext`/`useEffect` sem `'use client'` no próprio arquivo) — importar qualquer símbolo do pacote (mesmo um repositório "puro") num Server Component quebra o build do Next ("You're importing a component that needs createContext"). Todas as abas de `/locacoes/[id]/(tabs)/` e `/veiculos/[id]/page.tsx` fazem `select()` inline via `createClient()` (nunca chamam repositórios de `@gomoto/data`); a lógica de derivação de status (`deriveInspectionScheduleStatus`, `pickLatestInspectionBySchedule`, `filterMaintenancesInRentalPeriod`) fica em `@gomoto/core` justamente para ser importável dos dois lados (Server Component e hook de Client Component).

## Tags
`#projeto/tela` `#gomoto/locacoes` `#gomoto/financeiro`
