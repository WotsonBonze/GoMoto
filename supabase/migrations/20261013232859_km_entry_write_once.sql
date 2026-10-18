-- KM de entrada: gravado uma única vez, e ponto de partida do KM atual.
--
-- 1. Write-once. A RN-010 (Spec 0006) diz que o KM de entrada é imutável, mas
--    só a action `updateVehicle` cuidava disso — e cuidava descartando o campo
--    sempre, inclusive quando ele nunca tinha sido preenchido. Com o cadastro
--    simplificado o KM de entrada virou opcional na criação, então precisa
--    poder ser informado depois: de NULL para um valor, uma vez. Trocar um
--    valor já gravado (ou apagá-lo) continua proibido, e agora no banco, para
--    valer também fora da tela.
--
-- 2. km_current. O cadastro gravava km_entry e deixava km_current no DEFAULT 0;
--    a locação usa km_current como KM inicial, então uma moto que entrava na
--    frota com 15.000 km começava a primeira locação em 0 km. Ao receber o KM
--    de entrada (no INSERT ou no primeiro preenchimento), o KM atual sobe para
--    ele — nunca desce: se já há leitura maior registrada, ela fica.

CREATE OR REPLACE FUNCTION vehicles_km_entry_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.km_entry IS NOT NULL
     AND NEW.km_entry IS DISTINCT FROM OLD.km_entry THEN
    RAISE EXCEPTION 'KM de entrada já registrado (% km) e não pode ser alterado', OLD.km_entry
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.km_entry IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.km_entry IS NULL) THEN
    NEW.km_current := GREATEST(COALESCE(NEW.km_current, 0), NEW.km_entry);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_vehicles_km_entry_guard
  BEFORE INSERT OR UPDATE OF km_entry ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION vehicles_km_entry_guard();

-- Veículos já cadastrados com KM de entrada e KM atual abaixo dele.
UPDATE vehicles
   SET km_current = km_entry
 WHERE km_entry IS NOT NULL
   AND COALESCE(km_current, 0) < km_entry;
