-- ---------------------------------------------------------------------------
-- Desconto é acessório da cobrança, como o encargo por atraso
-- ---------------------------------------------------------------------------
-- `fn_assert_charge_item_origin` (20260815011718) recusa item cuja origem
-- (source_module, source_id) não bate com a da cobrança — "uma cobrança cobra
-- uma coisa só" (ADR 0024) — com uma exceção já aberta para `late_charge`: o
-- encargo é acessório da própria dívida, não outra coisa sendo cobrada.
--
-- Desconto é a mesma categoria: `applyDiscount` (lib/financial/charges.ts)
-- grava item negativo com `source_module = 'discount'` para reduzir o que a
-- cobrança já deve, não para cobrar algo novo. Sem esta exceção, a trigger
-- recusava TODO desconto com "Item de origem (discount, <NULL>) não cabe
-- nesta cobrança" — a função nunca tinha rodado de verdade antes de ganhar
-- tela, e o caminho de erro não tinha sido exercitado.

CREATE OR REPLACE FUNCTION fn_assert_charge_item_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_module TEXT;
  v_source UUID;
BEGIN
  -- Encargo por atraso e desconto são ACESSÓRIOS da própria dívida, não outra
  -- coisa sendo cobrada: acompanham o principal no mesmo documento.
  IF NEW.source_module IN ('late_charge', 'discount') THEN
    RETURN NEW;
  END IF;

  SELECT source_module, source_id INTO v_module, v_source
    FROM charges WHERE id = NEW.charge_id;

  IF NEW.source_module IS DISTINCT FROM v_module
     OR NEW.source_id IS DISTINCT FROM v_source THEN
    RAISE EXCEPTION
      'Item de origem (%, %) não cabe nesta cobrança, cuja origem é (%, %). Uma cobrança cobra uma coisa só (ADR 0024).',
      NEW.source_module, NEW.source_id, v_module, v_source
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
