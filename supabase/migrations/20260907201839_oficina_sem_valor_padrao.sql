-- ============================================================
-- Remove o valor padrão 'Oficina do Careca' da coluna workshop
-- ------------------------------------------------------------
-- A coluna nasceu (20260611002632_initial_schema.sql) com o nome de uma
-- oficina específica como DEFAULT. Num produto multi-tenant isso vaza o
-- fornecedor de um tenant para todos os outros: qualquer INSERT que omita
-- `workshop` grava a oficina de outra empresa como se fosse a sua.
--
-- Sem DEFAULT, um INSERT que omite a coluna grava NULL — e a tela já
-- renderiza NULL como '—'.
--
-- Linhas existentes NÃO são tocadas: não há como distinguir a linha que
-- recebeu o default silenciosamente da linha em que o operador digitou
-- esse nome de propósito. Limpar dado é decisão do humano.
-- ============================================================

ALTER TABLE maintenances ALTER COLUMN workshop DROP DEFAULT;
