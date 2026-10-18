# ADR 0035 — Ajuste de período e condições da locação

- **Status:** Aceita
- **Data:** 2026-09-10
- **Supersede:** a decisão de escopo de 2026-07-24 registrada em [[Telas/Locações]] ("Tipo, ciclo, dia de vencimento, início, pro rata — imutável após criação")
- **Relacionada:** [[decisions/0024-ledger-financeiro-com-contrapartida]], [[Specs/0014-redesenho-financeiro]]

## Contexto

O período de um contrato não era editável por caminho nenhum:

| Campo | Antes |
|---|---|
| `start_date` | nenhum fluxo |
| `end_date` | esticar por `/renovar` (`fn_renew_rental` recusa encurtar) ou encerrar por `/encerrar` (fecha a locação e libera o veículo) |
| `cycle`, `due_day`, `use_pro_rata` | nenhum fluxo desde que `regenerate_rental_schedule` caiu com o modelo financeiro antigo |
| `cycle_amount` | `/reajustar` (`adjust_rental_schedule`) |

A orientação na UI era "encerre e crie outra locação". Isso custa o contrato inteiro
— histórico, cobranças, vistorias — por um erro de digitação ou uma renegociação de
vencimento, que é operação corriqueira.

Além do buraco, havia **dois donos para o mesmo campo**: `/renovar` e `/reajustar`
eram recortes do mesmo ato (mudar as condições e regerar o plano), e as regras
divergiam — Renovar recusava encurtar, Reajustar não sabia que datas existiam.

## Decisão

**`/locacoes/[id]/ajustar` passa a ser a dona única dos seis parâmetros que
definem o cronograma**: início, fim, ciclo, dia de vencimento, valor do ciclo e
pro rata. `/reajustar` e `/renovar` viram redirects. `/encerrar` continua
separada — encerrar muda `status` e libera o veículo, é outra operação.

### A fronteira

O ajuste tem uma data de vigência (`effective_from`) que separa história de futuro:

| Faixa | O que acontece | Dinheiro se move? |
|---|---|---|
| período termina até a fronteira, e continua dentro da nova vigência | intocado | não |
| depois da fronteira, linha `scheduled` | → `superseded` | não — nunca virou documento |
| depois da fronteira, linha `issued` com cobrança **aberta** | cobrança cancelada + linha → `superseded` | sim — estorna a emissão no razão, encerra o intent no gateway |
| depois da fronteira, linha `issued` com cobrança **paga** ou **baixada** | **impedimento** | — |

Sobre a fronteira, o cronograma é regerado por `generateSchedule` com os parâmetros
novos. A vigência sugerida é o fim do último período **já emitido** — escolha
conservadora: com ela nenhuma cobrança é cancelada, e alcançar documento emitido
passa a exigir que o operador puxe a data para trás e veja a lista do que cai.

A vigência **mínima** é o fim do último período cujo dinheiro já entrou. Antes
dela não há ajuste: desfazer recebimento é estorno de pagamento, operação própria.
Sem nenhuma cobrança de ciclo paga, não há piso nenhum — `min_effective_from` é `''`,
que nunca bloqueia (comparação lexicográfica: qualquer data ISO real é "maior"). Caução
e entrada nunca entram nessa conta: `loadPeriodAdjustmentContext` já filtra
`source_module = 'rental'` ao carregar as cobranças que alimentam o cálculo.

**Bug corrigido em 2026-09-15** (achado em produção): `minEffectiveFrom` usava
`next.start_date` — a data nova que o operador está digitando — como *fallback*
quando nada estava pago. Numa locação com todas as cobranças de ciclo em aberto
(inadimplente há mais de um ano, só a caução paga) e o operador antecipando a
vigência para regerar o cronograma inteiro, o piso "sem dado" coincidia, por
acidente, com o próprio valor que ele tinha acabado de digitar — a mensagem "Há
período já pago até 24/08/2025" aparecia para uma vigência sem nenhum centavo
pago. Sintoma relatado como "caução/entrada bloqueiam o ajuste"; causa real era
o fallback do piso, não as cobranças de garantia. Corrigido em TS puro
(`packages/core`), sem migration — basta o deploy.

### Por que `superseded` e não `cancelled`

O enum já definia `superseded` como "substituída por reajuste", `schedule_by_month`
já a excluía da previsão, e `issue_due_charges` só consome `scheduled` — logo, linha
substituída nunca reemite. `cancelled` é o estado do encerramento antecipado.

### Onde mora a decisão

O cálculo inteiro é `planPeriodAdjustment`, função pura em
`packages/core/src/rules/schedule.ts`. **É a mesma chamada que desenha a prévia na
tela e que a Server Action usa para gravar** — pelo mesmo motivo que
`generateSchedule` é única: prévia e persistência não podem divergir. O operador
confirma exatamente o que vai acontecer, não uma estimativa paralela.

A RPC `fn_adjust_rental_period` só escreve — e confere. Sob o lock da locação, ela
recusa substituir qualquer linha cuja cobrança ainda esteja viva
(`LINE_HAS_LIVE_CHARGE`). Isso não é redundância da validação da action: entre a
leitura da tela e a escrita cabem o job de emissão, um webhook de pagamento e outro
operador. Guarda e escrita na mesma transação.

### Reaproveitamento de linha idêntica (2026-09-15)

Sobre a fronteira, `planPeriodAdjustment` regenera o cronograma inteiro via
`generateSchedule` — modelo simples e robusto, sem diff, que sai correto pra
qualquer combinação dos seis parâmetros. O custo: mudar só o prazo (início ou
fim), mantendo ciclo/dia/valor/pro-rata iguais, fazia CADA período do meio ser
riscado (`superseded`) e recriado byte a byte idêntico ao que já existia —
`rental_billing_schedules` dobrava de tamanho a cada renovação, sem nenhum
motivo real.

Corrigido comparando cada linha regenerada contra as candidatas que seriam
substituídas: quando bate EXATO (`period_start`, `period_end`, `due_date`,
`amount`), a linha ORIGINAL é mantida — mesmo `id`, mesmo `sequence_number` —
em vez de riscada e recriada. Sem efeito nenhum no dinheiro, porque nenhuma das
duas nunca virou documento.

**Restrito a linhas ainda não emitidas.** Uma linha `issued` nunca é
reaproveitada, mesmo com valor idêntico — inclusive quando a cobrança dela já
está `cancelled`. Duas razões:
1. Só cai na zona de substituição quando o operador escolhe deliberadamente
   puxar a vigência para trás do padrão sugerido (que já protege o que foi
   emitido) — cancelar é o ato explícito que ele pediu, não algo pra esta
   função presumir que pode pular.
2. Uma linha travada em `issued` apontando pra cobrança cancelada nunca mais
   seria reemitida: `issue_due_charges` só consome `status='scheduled'`.
   Substituir por uma linha nova garante que o período volte a ser cobrável.

### Nenhum período fica sem cobrança (2026-09-15)

**Bug achado em teste de navegador**: antecipar o início em 2 dias sobre uma
locação com período já emitido cancelava a cobrança certa (linha e razão
corretos), mas não deixava NENHUMA linha cobrindo o trecho entre o início novo
e o vencimento original daquele período — o cliente ficava com dias de uso sem
cobrança nenhuma, em silêncio. `regenFrom` pulava direto para `effective_from`
(fim do último período emitido) e nunca olhava para o que sobrava entre
`next.start_date` e o primeiro período que ainda sobrevivia.

O mesmo defeito existia espelhado dos dois lados:
- **Ponta esquerda**: `next.start_date` cai antes do primeiro período mantido
  — seja avançando para dentro dele (invalidando-o), seja recuando para antes
  de qualquer período existente (este último já existia como aviso
  `START_BEFORE_ISSUED`, que dizia "vai ficar sem parcela" em vez de resolver).
- **Ponta direita**: o operador digita uma `effective_from` que cai no MEIO de
  um período em vez de bater numa borda — o date picker aceita qualquer data
  `>= min_effective_from`, sem exigir alinhamento. O período que ela corta é
  invalidado por inteiro, e o pedaço entre o início dele e a fronteira digitada
  ficava do mesmo jeito sem cobertura.

**Por que só nessas duas pontas**: as três condições de `survives` são
monótonas na posição do período (início barra os mais antigos, `effective_from`
barra os mais novos), então `keep_lines` é sempre UM ÚNICO trecho contínuo —
não há como abrir buraco no meio.

**Correção**: `regenFrom` deixou de ser sempre `max(next.start_date,
effective_from)` e passou a ser literalmente onde o trecho mantido termina
(`lastKeptEnd`, ou `next.start_date` quando nada sobrevive) — o que já fecha a
ponta direita, porque a regeneração passa a olhar o pedaço entre o fim do
último período mantido e uma fronteira que corta no meio de outro. E antes
dessa regeneração principal, quando o primeiro período mantido (`firstKeptStart`)
começa depois de `next.start_date`, uma chamada extra a `generateSchedule`
cobre exatamente `[next.start_date, firstKeptStart)` — fecha a ponta esquerda.

As duas chamadas usam a MESMA `generateCycleCharges` de sempre: nenhuma regra
de preço nova. É por isso que a cobrança da lacuna sai certa sozinha — cheia
quando o trecho é um ciclo completo entre dois vencimentos (RN-010), pro rata
quando `use_pro_rata` está ligado e o trecho é uma ponta (RN-008/012), cheia
mesmo sendo ponta quando `use_pro_rata` está desligado (RN-011). O aviso
`START_BEFORE_ISSUED` foi removido — o cenário que ele descrevia agora gera
cobertura real em vez de só avisar que faltava.

Cobrado em `packages/core/src/rules/schedule.spec.ts` (bug reproduzido +
recuo/avanço de início + `effective_from` no meio de período) e em
`apps/web/tests/ajuste-de-periodo.spec.ts` (mesmo cenário, contra o banco e a
RPC reais).

### Vigência só existe para ciclo/vencimento/valor/pro-rata (2026-09-16)

O fix acima resolveu o buraco, mas expôs um efeito colateral confuso: a
"ponta direita" (§ acima) só se abre quando o operador digita uma
`effective_from` que corta no meio de um período — e nada, além do próprio
mecanismo de regeneração, impede que ele digite QUALQUER data ali, mesmo numa
locação onde só início/fim mudaram. Testado ao vivo: mudar só o início e
puxar "Aplicar a partir de" para uma data qualquer cancelava cobrança já
emitida que continuava cabendo no contrato novo, só por cair no meio dela —
com a substituta certa sendo criada logo em seguida (a garantia de cobertura
segurou), mas o operador via cobranças sumindo e reaparecendo sem entender
por quê.

**A pergunta certa**: por que `effective_from` deveria interferir numa
mudança que é só de data? A resposta é que não deveria. `next.start_date` e
`next.end_date` já respondem sozinhos QUAIS períodos continuam existindo — é
geometria pura (`period_start >= next.start_date`, `period_end <=
next.end_date`), sem precisar de fronteira nenhuma. `effective_from` só tem
um motivo de existir: decidir a partir de QUANDO um REPREÇO (`cycle_amount`,
`due_day`, `cycle`, `use_pro_rata`) passa a valer sobre período que já é
documento. Misturar as duas coisas — deixar a vigência também decidir SE um
período existe — foi o que abriu a ponta direita para qualquer ajuste de
data, mesmo sem repreço nenhum envolvido.

**Correção**: `PeriodAdjustmentPlan` ganhou `effective_from_applies` —
`true` quando `changed_fields` inclui `cycle`, `due_day`, `cycle_amount` ou
`use_pro_rata`; `false` quando só `start_date`/`end_date` mudam (ou nada
muda). `survives` passou a ignorar a condição `period_end <= effective_from`
inteira quando `effective_from_applies` é falso — sobrevivência vira só
geometria. `EFFECTIVE_BEFORE_PAID` também só dispara quando a vigência
importa; dinheiro pago continua protegido do mesmo jeito, mas via
`PAID_CHARGE_IN_RANGE` no laço geométrico, não por comparar contra uma
fronteira que nem está em jogo.

A tela usa o mesmo campo para decidir a UI: `AdjustRentalPeriodForm` só
mostra "Aplicar a partir de" quando `plan.effective_from_applies` é
verdadeiro, e limpa o valor digitado assim que deixa de ser (para não
reaparecer com lixo se o operador voltar a mexer em ciclo/vencimento/valor
depois). Não é só estética — é a mesma regra rodando dos dois lados, porque
é a MESMA função (`planPeriodAdjustment`) que decide os dois.

**Efeito colateral em `NOTHING_LEFT`**: com `keep_lines` podendo agora cobrir
a janela inteira sem cortar nada (mudança só de início, fim inalterado),
`regenFrom` legitimamente bate em `next.end_date` sem nada de errado — e o
bloqueio antigo (`next.end_date <= regenFrom`) passou a disparar à toa nesse
caso. Corrigido restringindo o bloqueio a quando o FIM realmente encurtou em
relação ao contrato atual (`next.end_date < current.end_date`) e não há
ponta esquerda alguma nascendo — só aí "nada sobra" significa de fato
"isso é encerramento, não ajuste".

### Retroativo avisa, não impede

Uma parcela nova cujo período já começou vira cobrança na rodada seguinte de
emissão, possivelmente já vencida e com encargo correndo. A prévia marca cada uma
("Emite agora", "Já vencida") e o operador confirma sabendo.

Bloquear seria mais seguro e mais errado: cadastrar contrato que começou há 30 dias
é caso suportado desde sempre na criação, e regra automatizada demais vira operador
contornando o sistema por fora — aí o dado deixa de valer.

## Consequências

- A ordem de `sequence_number` deixa de ser cronológica: as linhas novas **continuam**
  a numeração (a UNIQUE `(rental_id, sequence_number)` proíbe reuso). Toda leitura de
  cronograma passou a ordenar por `period_start`, e a aba Financeiro separa o histórico
  do plano atrás de um disclosure.
- `rental_adjustments` ganhou as colunas de data, vigência e contagens — o histórico
  de reajuste passa a dizer o que mudou, não só o valor.
- Cobrança já emitida para um período que sai do contrato precisa ser cancelada, o que
  reverte o lançamento de emissão no razão. Isso é visível na prévia antes do clique.
- **O contrato assinado em `rentals.signed_contract_path` deixa de bater com o registro
  quando as datas mudam.** A tela avisa; formalizar o aditivo é do operador.
- Em `rent_to_own`, mover o início move a data de transferência: `calculateExpectedEndDate`
  ignora `end_date` e devolve início + 2 anos, e é ela que faz `terminateRental` marcar
  `transferred`. A tela avisa.
- Manutenções e multas são associadas à locação por data — mudar a janela muda a aba
  Manutenções e a atribuição de multas. A tela avisa.

## Alternativa descartada

**Uma tela por campo** (manter Renovar e Reajustar, acrescentar "editar datas"). Foi
o que produziu a divergência atual de regras, e nenhuma das três conseguiria mostrar
o efeito completo: mudar o dia de vencimento e a data de fim ao mesmo tempo gera um
cronograma que nenhuma das telas sozinha sabe calcular.

### Parcela retroativa emite na hora, não espera o cron (2026-09-16)

`fn_run_billing_emission` roda uma vez por dia (06h em Brasília, via
`pg_cron`). Uma linha nova que já nasce com período iniciado (`emits_now`) —
comum em ajuste retroativo, tipicamente um erro de data descoberto dias
depois — ficava `status='scheduled'` até a rodada seguinte: o operador
confirmava o ajuste e só via a cobrança de verdade (com o lançamento no
razão) no dia seguinte.

`adjustRentalPeriod` passou a chamar `fn_issue_charges_for_tenant` (a mesma
função do cron, documento + lançamento na mesma transação) logo depois que a
RPC do ajuste commita, sempre que `plan.new_lines` tem alguma `emits_now`.
`fn_issue_charges_for_tenant` tem `EXECUTE` revogado de `authenticated` de
propósito (migration `lock_down_emission_rpcs`: "ninguém legítimo precisa
desses grants" — só cron ou disparo manual com `CRON_SECRET`), então essa
chamada usa `createAdminClient()` (`@/lib/supabase/admin`, o cliente
`service_role` da [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR
0034]]), o mesmo papel que a rota `/api/cron/issue-charges` já usa para o
disparo manual. Não é burlar o
lockdown: é o servidor (nunca o navegador) invocando o mesmo caminho
confiável que já existia, só que síncrono em vez de por HTTP+segredo.

Best-effort de propósito: o ajuste já está commitado quando essa chamada
acontece (RPC própria, transação própria), então uma falha na emissão não
desfaz nada — só significa que a linha espera o cron normal, exatamente como
sempre esperou. Só loga o erro; não aparece como falha do ajuste pro
operador.

**Correção (2026-09-17): escopo é a LINHA, não o tenant inteiro.** A versão
original chamava `fn_issue_charges_for_tenant(tenant_id, lead_days)` sem
filtro — a mesma função do cron, processando toda a fila do tenant numa
transação só. Revisão achou o problema antes de ir pra produção:
`issue_due_charges` não isola falha por cobrança — se qualquer OUTRA linha do
tenant (de outra locação, sem relação com o ajuste) falhasse ao virar
documento, a exceção subia e desfazia a transação inteira, **inclusive a
cobrança que o ajuste acabou de criar**. Como a chamada é best-effort (só
loga), o operador veria "ajuste aplicado" sem nunca saber que a própria
cobrança dele foi derrubada por algo de uma locação completamente diferente.
Também acoplava a latência de "toda a fila do tenant" a uma ação que devia
ser rápida.

Corrigido em duas pontas:
1. `fn_adjust_rental_period` passou a devolver `new_lines` (`{id,
   sequence_number}[]`) no `RETURN jsonb_build_object(...)` — antes só
   contava (`GET DIAGNOSTICS ... ROW_COUNT`). Sem o id de volta não havia
   como dizer à emissão QUAL linha processar.
2. `issue_due_charges`/`fn_issue_charges_for_tenant` ganharam
   `p_schedule_line_ids UUID[] DEFAULT NULL` — `NULL` continua sendo o
   tenant inteiro (o cron, inalterado); a action passa só os ids das linhas
   que ELA criou, casando `plan.new_lines` (`emits_now`) com o retorno da
   RPC por `sequence_number` (único por locação — não por posição no array,
   que `jsonb_array_elements` não garante preservar em `RETURNING`).

Isso mudou a ASSINATURA das duas funções (parâmetro a mais), diferente de
toda migration anterior sobre elas, que só trocava o corpo via
`CREATE OR REPLACE` sobre a mesma assinatura `(uuid, integer)` — e por isso
nunca precisou reafirmar grant (a garantia documentada em
`20260912220840_periodo_do_ciclo_na_descricao_da_cobranca`, "CREATE OR
REPLACE preserva grant", só vale quando a assinatura não muda). Migration
`20260917005041_emissao_escopada_por_linha` faz `DROP FUNCTION` explícito
das duas antes de recriar, e reaplica `REVOKE ... FROM PUBLIC, anon,
authenticated` + `GRANT ... TO service_role` na íntegra — sem isso, o novo
overload nasceria com `EXECUTE` liberado pra `PUBLIC` por padrão, reabrindo
o buraco que `lock_down_emission_rpcs` fechou. `fn_run_billing_emission`
chama a função posicionalmente com 2 argumentos; resolve pro único overload
existente, 3º cai no default `NULL` — comportamento do cron inalterado.

Coberto em `apps/web/tests/ajuste-de-periodo.spec.ts` ("emissão da parcela
retroativa do ajuste é escopada"): duas locações independentes, a 2ª com
parcela igualmente vencida e nunca emitida fora do escopo passado —
confirma que só a linha do ajuste vira `issued`, a outra permanece
`scheduled`.

## Não resolvido aqui → resolvido pela ADR 0036

Esta ADR apontava que não havia guarda contra duas locações no mesmo veículo e que
antecipar o início tornava o buraco mais fácil de alcançar. Resolvido no mesmo dia pela
[[decisions/0036-um-veiculo-uma-locacao|ADR 0036]]: índice único parcial para "uma ativa
por veículo" e trigger para "períodos não se cruzam". A prévia desta tela passou a
bloquear o ajuste (`VEHICLE_PERIOD_OVERLAP`) antes do clique.

## Tags
`#projeto/adr` `#gomoto/locacoes` `#gomoto/financeiro`
