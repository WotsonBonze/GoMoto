-- Um contato de emergência só serve se alguém atender. Quando o único número
-- não atende, a locadora fica sem ninguém para acionar — daí um segundo e um
-- terceiro contato.
--
-- O par existente (emergency_contact_name/phone) continua sendo o contato 1,
-- mesma convenção já usada em phone/phone2.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS emergency_contact_name2   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS emergency_contact_phone2  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS emergency_contact_name3   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS emergency_contact_phone3  VARCHAR(20);
