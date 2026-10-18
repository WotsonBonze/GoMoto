# ADR 0036 — Um veículo, uma locação

- **Status:** Aceita
- **Data:** 2026-09-10
- **Relacionada:** [[decisions/0035-ajuste-de-periodo-da-locacao]], [[decisions/0024-ledger-financeiro-com-contrapartida]]

## Contexto

A moto não pode estar com dois clientes ao mesmo tempo, e o banco não sabia disso.

- `create_rental_with_schedule` trava a linha do veículo, mas **não olha se ele já
  está locado**. A checagem existia na RPC antiga (`create_rental_with_charges`) e
  se perdeu na reescrita da Spec 0014.
- A tela de criação só lista veículos com `vehicles.status = 'available'`. Isso
  valia por convenção: o status é coluna mantida à mão, e `@gomoto/data` ainda tem um
  `INSERT` direto em `rentals` (`createRentalRecord`, sem chamador) que não passa por
  RPC nenhuma.
- **A própria suíte E2E provava o buraco**: specs criavam até seis locações ativas na
  mesma moto e passavam. O banco local acumulava 11 veículos nessa situação.
- A [[decisions/0035-ajuste-de-periodo-da-locacao|ADR 0035]] abriu um segundo caminho:
  antecipar o início da locação ativa para antes da devolução da anterior. Nesse caso a
  anterior já está `closed`, e uma regra que só olha `status = 'active'` não enxerga.

## Decisão

Duas regras **no banco**, porque são dois jeitos diferentes de violar a mesma coisa:

1. **Uma locação ativa por veículo**: índice único parcial
   `idx_rentals_one_active_per_vehicle ON rentals (vehicle_id) WHERE status = 'active'`.
   Vale para qualquer caminho de escrita, inclusive o `INSERT` direto.
2. **Períodos não se cruzam**: trigger `trg_rentals_vehicle_period`. Ao gravar uma
   locação `active`, o período `[início, fim)` dela não pode cruzar o de outra locação
   do mesmo veículo. Devolver e retirar no mesmo dia é permitido. Fim nulo é contrato em
   aberto. Fim anterior ao início (locação encerrada antes de começar) é período vazio.

Complementos:

- `create_rental_with_schedule` confere a locação ativa explicitamente, sob o lock do
  veículo, para o operador ler "veículo já está locado" em vez de "duplicate key". O
  índice é a garantia; a checagem é a mensagem.
- `rentalPeriodsOverlap` (`@gomoto/core`) espelha a semântica do trigger para a prévia do
  `/ajustar` bloquear **antes do clique**, com as datas da locação que atrapalha.

### Por que trigger e não `EXCLUDE USING gist`

A restrição de exclusão valida também o **histórico**. Uma sobreposição antiga em
produção faria o `db push` falhar sem ninguém ter errado agora, e `daterange` recusaria
as locações encerradas antes de começar (fim < início). O que precisa ser impossível é
**gravar** uma sobreposição nova, e toda gravação de locação ativa passa pelo trigger.

## Consequências

- **Reservar um veículo que está locado não é possível**: a segunda locação só pode
  existir depois do encerramento da primeira. Esse é o papel da fila de espera.
- A migration **falha se já houver veículo com duas locações ativas**, listando as placas,
  sem corrigir nada sozinha. Escolher qual locação é a verdadeira é decisão de quem conhece
  o contrato. Rodar a pré-checagem em produção antes do `db push`.
- Três specs (`emissao-cobrancas`, `reajuste-e-renovacao`, `ajuste-de-periodo`)
  reaproveitavam um veículo para várias locações e passaram a criar um veículo por locação.

## Não resolvido aqui

Sobreposições **já existentes** entre locações encerradas não são validadas: o trigger
só olha o que é gravado daqui em diante. Para listar as antigas:

```sql
SELECT a.id, b.id, a.vehicle_id
  FROM rentals a JOIN rentals b ON a.vehicle_id = b.vehicle_id AND a.id < b.id
 WHERE fn_rental_period(a.start_date, a.end_date) && fn_rental_period(b.start_date, b.end_date);
```

## Tags
`#projeto/adr` `#gomoto/locacoes`
