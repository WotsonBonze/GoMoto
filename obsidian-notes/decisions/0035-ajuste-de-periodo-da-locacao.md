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

## Não resolvido aqui → resolvido pela ADR 0036

Esta ADR apontava que não havia guarda contra duas locações no mesmo veículo e que
antecipar o início tornava o buraco mais fácil de alcançar. Resolvido no mesmo dia pela
[[decisions/0036-um-veiculo-uma-locacao|ADR 0036]]: índice único parcial para "uma ativa
por veículo" e trigger para "períodos não se cruzam". A prévia desta tela passou a
bloquear o ajuste (`VEHICLE_PERIOD_OVERLAP`) antes do clique.

## Tags
`#projeto/adr` `#gomoto/locacoes` `#gomoto/financeiro`
