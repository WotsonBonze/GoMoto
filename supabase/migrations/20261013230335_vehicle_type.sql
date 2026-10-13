-- Tipo do veículo (moto ou carro).
--
-- O cadastro simplificado de /veiculos/novo passou a pedir o tipo junto com o
-- essencial. A frota existente é toda de motos (o produto nasceu como
-- "motorcycles", Spec 0007), então o DEFAULT preenche as linhas atuais sem
-- backfill separado e o NOT NULL vale desde já.

ALTER TABLE vehicles
  ADD COLUMN vehicle_type VARCHAR(20) NOT NULL DEFAULT 'motorcycle';

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_vehicle_type_check
  CHECK (vehicle_type IN ('motorcycle', 'car'));

COMMENT ON COLUMN vehicles.vehicle_type IS 'Tipo do veículo: motorcycle (moto) ou car (carro).';
