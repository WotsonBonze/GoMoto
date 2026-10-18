-- ============================================================
-- tenant_contacts — tipo do número e horário de atendimento
-- ============================================================
-- `phone_kind`: o número é para ligar ('phone') ou é WhatsApp ('whatsapp').
-- O app escolhe ícone e ação por ele — antes oferecia as duas coisas para
-- qualquer número, e um fixo não atende WhatsApp.
--
-- `business_hours`: texto livre ("Seg a sex, 8h às 18h"). Estruturar dia a
-- dia não compraria nada aqui: o app só exibe, nada calcula em cima.
-- ============================================================

ALTER TABLE tenant_contacts
    ADD COLUMN phone_kind     VARCHAR(10)  NOT NULL DEFAULT 'phone',
    ADD COLUMN business_hours VARCHAR(120) NULL,
    ADD CONSTRAINT chk_tenant_contacts_phone_kind CHECK (phone_kind IN ('phone', 'whatsapp'));
