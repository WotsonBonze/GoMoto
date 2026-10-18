-- ADR 0034 — a tela parava de mentir sobre "sem efeito"
--
-- Achado na auditoria do primeiro ciclo completo em produção depois da ADR
-- (cobrança #6, 2026-09-07).
--
-- `gateway_event_audit` classificava como `processed_no_money` — "Sem efeito"
-- na tela — todo evento processado que não tivesse pagamento ligado. Para os
-- eventos de ciclo de vida (`INVOICE.DRAFTED`, `INVOICE.CREATED`) isso é
-- verdade. Para os pagamentos ANTERIORES à Fase 1 é MENTIRA: eles não têm
-- `gateway_event_id` porque a coluna não existia quando aconteceram, e a tela
-- passou a exibir "Sem efeito" sobre confirmações reais — a de R$ 1,00 da
-- InfinitePay e a de R$ 10,00 da Cora.
--
-- Uma tela de diagnóstico que afirma "sem efeito" sobre dinheiro que entrou é
-- pior que não ter tela: ela convence quem olha de que não há nada ali.
--
-- O discriminador é o `tenant_id` do evento. Os eventos de ciclo de vida são
-- descartados ANTES da consulta ao banco e marcados com tenant nulo; qualquer
-- evento que chegou a resolver um tenant passou pelo caminho do dinheiro,
-- mesmo que hoje não seja possível mostrar o que ele produziu.
--
-- Nada é reescrito no passado. `payments.gateway_event_id` é imutável por
-- `fn_protect_payment` (Fase 2) — de propósito: "imutável" inclui não inventar
-- origem para registro que nasceu sem ela. O elo daqueles dois pagamentos é
-- reconstruível por arqueologia no payload, e é exatamente essa arqueologia que
-- a ADR existe para nunca mais ser necessária dali para a frente.

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
    WHEN p.id IS NOT NULL                                          THEN 'confirmed'
    -- Sem tenant: foi descartado antes de tocar o banco. Ciclo de vida, e
    -- "sem efeito" é a descrição correta.
    WHEN e.tenant_id IS NULL                                       THEN 'processed_no_money'
    -- Com tenant e sem pagamento ligado: passou pelo caminho do dinheiro e não
    -- dá para mostrar o que produziu. Quase sempre é evento anterior à Fase 1,
    -- que não tinha onde gravar o elo.
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

  t.id          AS transaction_id
FROM gateway_events e
LEFT JOIN payments p               ON p.gateway_event_id = e.id
LEFT JOIN payment_intents i        ON i.id = p.payment_intent_id
LEFT JOIN charges c                ON c.id = i.charge_id
LEFT JOIN financial_transactions t ON t.source_event_id = e.id
                                  AND t.reverses_transaction_id IS NULL;

COMMENT ON VIEW gateway_event_audit IS
  'ADR 0034: do webhook ao razão em uma linha. `processed_unlinked` distingue "não produziu dinheiro" de "produziu e não dá para mostrar" — a tela nunca afirma "sem efeito" sobre um pagamento real.';

GRANT SELECT ON gateway_event_audit TO authenticated, service_role;
