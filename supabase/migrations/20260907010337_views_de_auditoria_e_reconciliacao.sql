-- ADR 0034 — Fase 3: tornar visível
--
-- As Fases 1 e 2 puseram o dado no lugar e fecharam as portas. Nenhuma delas
-- resolve o problema original: **num incidente, o operador não tem nada.** O
-- diagnóstico dependia de alguém com acesso ao banco montando SQL na hora.
--
-- Duas views. A primeira responde "o que o gateway mandou e o que virou disso";
-- a segunda responde "existe documento que não virou lançamento" — pergunta que
-- hoje só o `reconciliacao.spec.ts` faz, contra o banco de TESTE, em CI.
--
-- `security_invoker = true` nas duas: a RLS de cada tabela de origem continua
-- valendo, e cada locadora enxerga só o que é seu. Sem isto a view leria como o
-- dono e vazaria entre tenants — há um teste no projeto que varre o schema
-- exigindo esta declaração em toda view.

-- ---------------------------------------------------------------------------
-- 1. Do webhook ao razão, numa linha
-- ---------------------------------------------------------------------------
-- A corrente `gateway_events → payments → financial_transactions` virou FK na
-- Fase 1. Esta view é essa corrente montada, com o que um humano precisa para
-- decidir se está tudo bem: houve verificação, quanto demorou, e o que falhou.
--
-- `LEFT JOIN` em tudo de propósito: o evento que NÃO virou dinheiro é
-- justamente o que se quer ver. Um `INNER JOIN` esconderia exatamente a linha
-- que interessa.

CREATE OR REPLACE VIEW gateway_event_audit
WITH (security_invoker = true) AS
SELECT
  e.id                              AS event_id,
  e.tenant_id,
  e.provider,
  e.provider_event_id,
  e.event_type,
  e.received_at,
  e.processed_at,
  e.attempts,
  e.processing_error,
  e.signature_valid,
  e.accepted_without_verification,

  -- Situação em uma palavra, para a tela não recalcular a mesma regra.
  --
  -- A ordem importa: "aceito sem verificar" ganha de "processado", porque um
  -- recebimento confirmado SEM reconsultar a API do provedor (ADR 0033) é
  -- processado E precisa de olho humano. Se `processado` viesse antes, a
  -- ressalva sumiria da tela.
  CASE
    WHEN e.processed_at IS NULL AND e.processing_error IS NOT NULL THEN 'failed'
    WHEN e.processed_at IS NULL                                    THEN 'pending'
    WHEN e.accepted_without_verification                           THEN 'accepted_unverified'
    WHEN p.id IS NOT NULL                                          THEN 'confirmed'
    ELSE 'processed_no_money'
  END AS situation,

  -- Quanto tempo entre receber e terminar. Respondemos ANTES de processar
  -- (o provedor exige), então isto NÃO é a latência da resposta HTTP: é o
  -- trabalho que aconteceu depois dela, em segundo plano.
  EXTRACT(EPOCH FROM (e.processed_at - e.received_at)) AS processing_seconds,

  p.id          AS payment_id,
  p.amount      AS payment_amount,
  p.method      AS payment_method,
  p.paid_at,
  p.reversed_at,
  p.received_by_system,
  p.notes       AS payment_notes,

  i.id          AS intent_id,
  i.provider_intent_id,
  i.status      AS intent_status,

  c.id          AS charge_id,
  c.charge_number,
  c.customer_id,

  t.id          AS transaction_id
FROM gateway_events e
LEFT JOIN payments p               ON p.gateway_event_id = e.id
LEFT JOIN payment_intents i        ON i.id = p.payment_intent_id
LEFT JOIN charges c                ON c.id = i.charge_id
LEFT JOIN financial_transactions t ON t.source_event_id = e.id
                                  AND t.reverses_transaction_id IS NULL;

COMMENT ON VIEW gateway_event_audit IS
  'ADR 0034: do webhook ao razão em uma linha. Responde "por que este dinheiro entrou?" sem SQL montado na hora.';

GRANT SELECT ON gateway_event_audit TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Reconciliação — a varredura que só existia em teste
-- ---------------------------------------------------------------------------
-- `apps/web/tests/reconciliacao.spec.ts` faz a pergunta certa e a faz no lugar
-- errado para quem opera: roda em CI, contra o banco de teste. Produção não
-- tinha equivalente, então "o relatório está correto?" não era respondível.
--
-- Uma linha por PROBLEMA encontrado. Resultado vazio é o estado saudável — o
-- que também torna a view barata de olhar: `SELECT count(*)` responde tudo.
--
-- Os quatro primeiros achados espelham o spec. Os dois últimos são novos e
-- vieram desta ADR: são as formas que a corrente do gateway pode quebrar sem
-- que nenhuma invariante do banco seja violada.

CREATE OR REPLACE VIEW financial_reconciliation
WITH (security_invoker = true) AS

-- Transação que não fecha em zero. `trg_entries_balanced` impede isso, então
-- linha aqui significa que a guarda foi desabilitada por alguma migration —
-- coisa que migration pode fazer, e uma já fez com outro trigger.
SELECT
  t.tenant_id,
  'unbalanced_transaction'::TEXT AS issue,
  'financial_transactions'::TEXT AS entity,
  t.id                           AS entity_id,
  'soma ' || to_char(SUM(e.amount_signed), 'FM999999990.00')
    || ' em ' || t.event_type    AS detail,
  t.occurred_at                  AS occurred_at
FROM financial_transactions t
JOIN financial_entries e ON e.transaction_id = t.id
GROUP BY t.id, t.tenant_id, t.event_type, t.occurred_at
HAVING ABS(SUM(e.amount_signed)) > 0.005
   OR COUNT(*) < 2

UNION ALL

-- Cobrança emitida que não virou lançamento: some do DRE e de contas a receber,
-- e continua aparecendo na tela de cobranças. O relatório passa a mentir sem
-- nada acusar.
SELECT
  c.tenant_id,
  'charge_without_entry',
  'charges',
  c.id,
  'cobrança #' || c.charge_number || ' (' || c.source_module || ')',
  c.issue_date::timestamptz
FROM charges c
WHERE c.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM financial_entries e WHERE e.charge_id = c.id)

UNION ALL

-- Conta a pagar sem lançamento: a despesa não chega ao DRE.
SELECT
  p.tenant_id,
  'payable_without_entry',
  'payables',
  p.id,
  p.source_module || ': ' || p.description,
  p.competence_date::timestamptz
FROM payables p
WHERE p.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM financial_entries e WHERE e.payable_id = p.id)

UNION ALL

-- Crédito concedido sem lançamento nasce INUTILIZÁVEL: o saldo em
-- `customer_credit_balances` agrega o razão, então ele aparece na tela do
-- cliente e não pode ser aplicado. Foi bug real.
SELECT
  cc.tenant_id,
  'credit_without_entry',
  'customer_credits',
  cc.id,
  cc.origin || ' R$ ' || to_char(cc.amount, 'FM999999990.00'),
  cc.created_at
FROM customer_credits cc
WHERE NOT EXISTS (
  SELECT 1 FROM financial_transactions t
   WHERE t.source_module = 'customer_credit' AND t.source_id = cc.id)

UNION ALL

-- Dinheiro recebido que não quitou nada. Nenhuma invariante do banco impede:
-- `payments` e `payment_allocations` são tabelas separadas, e a RPC de
-- confirmação as escreve junto — mas o caminho MANUAL grava em chamadas
-- soltas, e falha no meio deixa exatamente isto.
SELECT
  p.tenant_id,
  'payment_without_allocation',
  'payments',
  p.id,
  'R$ ' || to_char(p.amount, 'FM999999990.00') || ' em ' || p.method,
  p.paid_at
FROM payments p
WHERE p.reversed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id)

UNION ALL

-- Tentativa marcada como paga sem pagamento correspondente. É o sintoma que a
-- ADR 0033 descreve pelo avesso: aqui o intent avançou e o dinheiro não
-- apareceu, então ou a confirmação morreu no meio, ou alguém mexeu no status.
SELECT
  i.tenant_id,
  'paid_intent_without_payment',
  'payment_intents',
  i.id,
  i.provider || ' — ' || COALESCE(i.provider_intent_id, 'sem id no provedor'),
  i.updated_at
FROM payment_intents i
WHERE i.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.payment_intent_id = i.id);

COMMENT ON VIEW financial_reconciliation IS
  'ADR 0034: uma linha por problema. Vazio é o estado saudável. Promove a produção a varredura que só existia em apps/web/tests/reconciliacao.spec.ts.';

GRANT SELECT ON financial_reconciliation TO authenticated, service_role;
