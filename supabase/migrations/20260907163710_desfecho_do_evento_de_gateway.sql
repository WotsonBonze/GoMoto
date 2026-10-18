-- ADR 0034 — o desfecho do evento deixa de ser jogado fora
--
-- Achado na auditoria do ciclo #7 (2026-09-07). Dois eventos do Mercado Pago
-- apareciam como "Processado, sem elo" na tela de diagnóstico. Fui perguntar ao
-- provedor o que eram:
--
--   177501360328 → cancelled / expired, R$ 5,00,  date_approved: null
--   177505599156 → cancelled / expired, R$ 10,00, date_approved: null
--
-- Pix gerados e nunca pagos. O webhook classificou como `ignored` e não criou
-- pagamento — comportamento correto. Mas `applyPayment` **conhecia** esse
-- desfecho e não gravava em lugar nenhum, então a view não tinha como
-- distinguir "o provedor disse que não foi pago" de "produziu dinheiro e não dá
-- para mostrar".
--
-- POR QUE ISSO IMPORTA MAIS DO QUE PARECE
--
-- Todo Pix que expira sem pagamento gera um evento desses. Em operação real,
-- com cobranças vencendo todo dia, a tela acumularia ruído permanente — e
-- **tela de diagnóstico que acumula ruído para de ser lida**, que é o oposto do
-- que ela existe para fazer. Dois eventos hoje é anedota; a taxa de crescimento
-- é que é o problema.
--
-- É a forma "validado e descartado" outra vez: o valor era calculado, usado
-- para decidir, e jogado fora antes de chegar a quem lê.

ALTER TABLE gateway_events
  ADD COLUMN outcome TEXT
    CHECK (outcome IN ('approved', 'refunded', 'ignored'));

COMMENT ON COLUMN gateway_events.outcome IS
  'ADR 0034: o que o PROVEDOR respondeu — approved credita, refunded estorna, ignored é "não foi pago". NULL = evento que nunca chegou a consultar o provedor (ciclo de vida) ou anterior a esta coluna.';

-- Achar os que o provedor recusou é consulta comum na tela; o índice parcial
-- mantém isso barato sem custar nada nos outros.
CREATE INDEX idx_gateway_events_outcome ON gateway_events (outcome)
  WHERE outcome IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A view passa a usar o desfecho em vez de inferir
-- ---------------------------------------------------------------------------
-- A ordem do CASE continua sendo decisão, não detalhe:
--
--   1. o que não terminou vem primeiro — `failed` e `pending` são o que exige
--      ação, e nada pode escondê-los;
--   2. `accepted_unverified` ganha de `confirmed`, porque dinheiro aceito sem
--      reconsulta ao provedor (ADR 0033) é processado E precisa de olho humano;
--   3. `refunded` antes de `confirmed`: o evento de estorno não tem pagamento
--      ligado a si — o pagamento aponta para o evento que o CONFIRMOU —, então
--      sem esta linha ele cairia em "sem elo" e o estorno sumiria da tela;
--   4. `ignored` é resposta AFIRMATIVA do provedor ("consultei, não foi pago").
--      Distinto de "não consegui verificar", que nunca chega aqui porque vira
--      exceção e fica na fila.

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

  CASE
    WHEN e.processed_at IS NULL AND e.processing_error IS NOT NULL THEN 'failed'
    WHEN e.processed_at IS NULL                                    THEN 'pending'
    WHEN e.accepted_without_verification                           THEN 'accepted_unverified'
    WHEN e.outcome = 'refunded'                                    THEN 'refunded'
    WHEN p.id IS NOT NULL                                          THEN 'confirmed'
    -- O provedor respondeu que não foi pago: Pix expirado, cartão recusado,
    -- pagamento ainda pendente. Não é problema, e não deve ocupar a atenção de
    -- ninguém.
    WHEN e.outcome = 'ignored'                                     THEN 'processed_ignored'
    -- Sem tenant: descartado antes de tocar o banco. Ciclo de vida.
    WHEN e.tenant_id IS NULL                                       THEN 'processed_no_money'
    -- Sobrou: passou pelo caminho do dinheiro, sem desfecho gravado e sem
    -- pagamento ligado. Na prática é evento anterior a estas colunas.
    ELSE 'processed_unlinked'
  END AS situation,

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

  t.id          AS transaction_id,

  -- No FIM da lista de propósito: `CREATE OR REPLACE VIEW` só aceita APENDAR
  -- colunas. Inserir no meio renomeia as seguintes e o Postgres recusa com
  -- "cannot change name of view column".
  e.outcome
FROM gateway_events e
LEFT JOIN payments p               ON p.gateway_event_id = e.id
LEFT JOIN payment_intents i        ON i.id = p.payment_intent_id
LEFT JOIN charges c                ON c.id = i.charge_id
LEFT JOIN financial_transactions t ON t.source_event_id = e.id
                                  AND t.reverses_transaction_id IS NULL;

COMMENT ON VIEW gateway_event_audit IS
  'ADR 0034: do webhook ao razão em uma linha. `outcome` guarda o que o provedor respondeu, para a tela não confundir "não foi pago" com "não dá para mostrar".';

GRANT SELECT ON gateway_event_audit TO authenticated, service_role;
