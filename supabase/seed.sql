-- ============================================================
-- GoMoto — Seed de desenvolvimento (multi-tenant)
--
-- 2 empresas com dados uniformes para smoke manual e E2E:
--   - master@teste.com           → platform_admin owner (control plane)
--   - empresa01@teste.com   → owner da Empresa Teste 1
--   - empresa02@teste.com   → owner da Empresa Teste 2
--   - 10 veículos disponíveis por empresa (sem locações)
--   - 10 clientes por empresa (emails cliente1..20@teste.com)
--   - 13 itens de manutenção + 1 plano padrão por empresa
--   - 1 Perfil de Vistoria padrão (checklist + fotos) por empresa
--   - 1 cliente na fila de espera por empresa
--
-- Senha de todos os usuários: 12345678
--
-- O tenant Empresa Teste 1 (id 00000000-...-0001) é criado pela
-- migration 20260611232437_tenant_isolation.sql com o nome histórico
-- "GoMoto Bonze". Aqui apenas renomeamos e populamos os dados.
-- ============================================================

-- ============================================================
-- PLATFORM ADMIN
-- Email: master@teste.com / Senha: 12345678
-- ============================================================
INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'master@teste.com',
    crypt('12345678', gen_salt('bf')),
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Master Admin"}'::jsonb,
    NOW(), NOW(), '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) VALUES (
    gen_random_uuid(),
    'f0000000-0000-0000-0000-000000000001',
    'f0000000-0000-0000-0000-000000000001',
    format('{"sub":"%s","email":"%s"}', 'f0000000-0000-0000-0000-000000000001', 'master@teste.com')::jsonb,
    'email', NOW(), NOW(), NOW()
) ON CONFLICT (provider_id, provider) DO NOTHING;

-- master@teste.com NÃO é tenant_member (RN-015: exclusividade mútua).
-- É o "dono do sistema" (platform_admin owner) apenas.
INSERT INTO platform_admins (user_id, role)
VALUES ('f0000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- TENANTS
-- Tenant 1 criado pela migration com nome 'GoMoto Bonze' — renomear.
-- ============================================================
UPDATE tenants
   SET name = 'Empresa Teste 1', slug = 'empresa-teste-1',
       contact_phone = '11999990001', contact_email = 'contato@empresa1.com.br',
       -- Login personalizado (ADR 0042): http://empresa1.localhost:3000/login.
       -- Sem logo no seed (arquivo vai para o Storage) — envie pelo admin.
       login_subdomain = 'empresa1'
 WHERE id = '00000000-0000-0000-0000-000000000001';

INSERT INTO tenants (id, name, slug, contact_phone, contact_email) VALUES
('00000000-0000-0000-0000-000000000002', 'Empresa Teste 2', 'empresa-teste-2', '11999990002', 'contato@empresa2.com.br')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, slug = EXCLUDED.slug,
  contact_phone = EXCLUDED.contact_phone, contact_email = EXCLUDED.contact_email;

-- ============================================================
-- TENANT OWNERS
-- empresa01@teste.com → Empresa Teste 1  (senha: 12345678)
-- empresa02@teste.com → Empresa Teste 2  (senha: 12345678)
-- ============================================================
INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES
(
    '00000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'empresa01@teste.com',
    crypt('12345678', gen_salt('bf')),
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Admin Empresa 1"}'::jsonb,
    NOW(), NOW(), '', '', '', ''
),
(
    '00000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated',
    'empresa02@teste.com',
    crypt('12345678', gen_salt('bf')),
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Admin Empresa 2"}'::jsonb,
    NOW(), NOW(), '', '', '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) VALUES
(
    gen_random_uuid(),
    'f0000000-0000-0000-0000-000000000002',
    'f0000000-0000-0000-0000-000000000002',
    format('{"sub":"%s","email":"%s"}', 'f0000000-0000-0000-0000-000000000002', 'empresa01@teste.com')::jsonb,
    'email', NOW(), NOW(), NOW()
),
(
    gen_random_uuid(),
    'f0000000-0000-0000-0000-000000000003',
    'f0000000-0000-0000-0000-000000000003',
    format('{"sub":"%s","email":"%s"}', 'f0000000-0000-0000-0000-000000000003', 'empresa02@teste.com')::jsonb,
    'email', NOW(), NOW(), NOW()
)
ON CONFLICT (provider_id, provider) DO NOTHING;

INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
('00000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', 'owner'),
('00000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000003', 'owner')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- ============================================================
-- MAINTENANCE ITEMS (13 itens padrão por empresa)
-- ============================================================
INSERT INTO maintenance_items (tenant_id, name, km_interval, day_interval, type, tip) VALUES
-- Empresa Teste 1
('00000000-0000-0000-0000-000000000001', 'Troca de oleo',                            1000,  NULL, 'preventive', 'Use oleo 20W50 ou 10W30; troque o filtro a cada 2 trocas.'),
('00000000-0000-0000-0000-000000000001', 'Filtro de oleo',                           4000,  NULL, 'preventive', 'Trocar a cada duas trocas de oleo.'),
('00000000-0000-0000-0000-000000000001', 'Lubrificacao da corrente',                  500,  NULL, 'preventive', 'Use spray para corrente com o-ring; lubrificar apos chuva.'),
('00000000-0000-0000-0000-000000000001', 'Ajuste da corrente',                       1000,  NULL, 'preventive', 'Peso extra afrouxa mais rapido em motos de locacao.'),
('00000000-0000-0000-0000-000000000001', 'Troca da relacao (corrente/coroa/pinhao)', 12000, NULL, 'preventive', 'Prefira relacao original para maior durabilidade.'),
('00000000-0000-0000-0000-000000000001', 'Lona de freio traseira',                  12000,  NULL, 'preventive', 'Evite manter o pe no freio.'),
('00000000-0000-0000-0000-000000000001', 'Pastilha de freio dianteira',              8000,  NULL, 'preventive', 'Use o freio dianteiro de forma equilibrada.'),
('00000000-0000-0000-0000-000000000001', 'Pneu dianteiro',                          12000,  NULL, 'preventive', 'Calibre semanalmente (32 psi dianteiro).'),
('00000000-0000-0000-0000-000000000001', 'Pneu traseiro',                            8000,  NULL, 'preventive', 'Calibre semanalmente (36 psi traseiro).'),
('00000000-0000-0000-0000-000000000001', 'Filtro de ar',                             7000,  NULL, 'preventive', 'Limpar ou trocar; poeira urbana reduz durabilidade.'),
('00000000-0000-0000-0000-000000000001', 'Velas de ignicao',                        10000,  NULL, 'preventive', 'Verificar e ajustar folga antes de trocar.'),
('00000000-0000-0000-0000-000000000001', 'Amortecedores',                           25000,  NULL, 'preventive', 'Peso extra acelera desgaste do oleo interno.'),
('00000000-0000-0000-0000-000000000001', 'Vistoria mensal',                          NULL,    30, 'inspection', 'Vistoria obrigatoria mensal de todas as motos.'),
-- Empresa Teste 2
('00000000-0000-0000-0000-000000000002', 'Troca de oleo',                            1000,  NULL, 'preventive', 'Use oleo 20W50 ou 10W30; troque o filtro a cada 2 trocas.'),
('00000000-0000-0000-0000-000000000002', 'Filtro de oleo',                           4000,  NULL, 'preventive', 'Trocar a cada duas trocas de oleo.'),
('00000000-0000-0000-0000-000000000002', 'Lubrificacao da corrente',                  500,  NULL, 'preventive', 'Use spray para corrente com o-ring; lubrificar apos chuva.'),
('00000000-0000-0000-0000-000000000002', 'Ajuste da corrente',                       1000,  NULL, 'preventive', 'Peso extra afrouxa mais rapido em motos de locacao.'),
('00000000-0000-0000-0000-000000000002', 'Troca da relacao (corrente/coroa/pinhao)', 12000, NULL, 'preventive', 'Prefira relacao original para maior durabilidade.'),
('00000000-0000-0000-0000-000000000002', 'Lona de freio traseira',                  12000,  NULL, 'preventive', 'Evite manter o pe no freio.'),
('00000000-0000-0000-0000-000000000002', 'Pastilha de freio dianteira',              8000,  NULL, 'preventive', 'Use o freio dianteiro de forma equilibrada.'),
('00000000-0000-0000-0000-000000000002', 'Pneu dianteiro',                          12000,  NULL, 'preventive', 'Calibre semanalmente (32 psi dianteiro).'),
('00000000-0000-0000-0000-000000000002', 'Pneu traseiro',                            8000,  NULL, 'preventive', 'Calibre semanalmente (36 psi traseiro).'),
('00000000-0000-0000-0000-000000000002', 'Filtro de ar',                             7000,  NULL, 'preventive', 'Limpar ou trocar; poeira urbana reduz durabilidade.'),
('00000000-0000-0000-0000-000000000002', 'Velas de ignicao',                        10000,  NULL, 'preventive', 'Verificar e ajustar folga antes de trocar.'),
('00000000-0000-0000-0000-000000000002', 'Amortecedores',                           25000,  NULL, 'preventive', 'Peso extra acelera desgaste do oleo interno.'),
('00000000-0000-0000-0000-000000000002', 'Vistoria mensal',                          NULL,    30, 'inspection', 'Vistoria obrigatoria mensal de todas as motos.');

-- ============================================================
-- MAINTENANCE PLANS (1 plano padrão por empresa)
-- IDs fixos para smoke manual e E2E:
--   Empresa 1: 10000000-...-000000000001
--   Empresa 2: 10000000-...-000000000002
-- ============================================================
INSERT INTO maintenance_plans (id, tenant_id, name, description, is_default) VALUES
('10000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
    'Plano Padrão', 'Plano default da Empresa Teste 1. Cobre óleo, filtro, freio, pneu e vistoria.', true),
('10000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002',
    'Plano Padrão', 'Plano default da Empresa Teste 2. Mesma estrutura para facilitar smoke entre tenants.', true);

INSERT INTO maintenance_plan_items
    (tenant_id, plan_id, name, interval_km, interval_days, is_critical, sort_order) VALUES
-- Empresa Teste 1
('00000000-0000-0000-0000-000000000001', '10000000-0000-4000-8000-000000000001', 'Troca de óleo',               1000,  NULL, false, 0),
('00000000-0000-0000-0000-000000000001', '10000000-0000-4000-8000-000000000001', 'Filtro de óleo',              4000,  NULL, false, 1),
('00000000-0000-0000-0000-000000000001', '10000000-0000-4000-8000-000000000001', 'Pastilha de freio dianteira', 8000,  NULL, true,  2),
('00000000-0000-0000-0000-000000000001', '10000000-0000-4000-8000-000000000001', 'Pneu dianteiro',              16000, NULL, true,  3),
('00000000-0000-0000-0000-000000000001', '10000000-0000-4000-8000-000000000001', 'Revisão mensal',              NULL,  30,   true,  4),
-- Empresa Teste 2
('00000000-0000-0000-0000-000000000002', '10000000-0000-4000-8000-000000000002', 'Troca de óleo',               1000,  NULL, false, 0),
('00000000-0000-0000-0000-000000000002', '10000000-0000-4000-8000-000000000002', 'Filtro de óleo',              4000,  NULL, false, 1),
('00000000-0000-0000-0000-000000000002', '10000000-0000-4000-8000-000000000002', 'Pastilha de freio dianteira', 8000,  NULL, true,  2),
('00000000-0000-0000-0000-000000000002', '10000000-0000-4000-8000-000000000002', 'Pneu dianteiro',              16000, NULL, true,  3),
('00000000-0000-0000-0000-000000000002', '10000000-0000-4000-8000-000000000002', 'Revisão mensal',              NULL,  30,   true,  4);

-- ============================================================
-- INSPECTION PROFILES (Spec 0009 — 1 perfil padrão por empresa)
-- IDs fixos para smoke manual e E2E:
--   Empresa 1: 20000000-...-000000000001
--   Empresa 2: 20000000-...-000000000002
-- ============================================================
INSERT INTO inspection_profiles (id, tenant_id, name, description) VALUES
('20000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
    'Perfil Padrão Motocicleta', 'Checklist e fotos padrão para check-in/check-out e vistoria periódica.'),
('20000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002',
    'Perfil Padrão Motocicleta', 'Mesma estrutura para facilitar smoke entre tenants.');

INSERT INTO inspection_profile_checklist_items (tenant_id, profile_id, name, sort_order) VALUES
-- Empresa Teste 1
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Faróis funcionando',         0),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Pneus em bom estado',        1),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Freios funcionando',         2),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Espelhos retrovisores',      3),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Sem avarias na lataria',     4),
-- Empresa Teste 2
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Faróis funcionando',         0),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Pneus em bom estado',        1),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Freios funcionando',         2),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Espelhos retrovisores',      3),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Sem avarias na lataria',     4);

INSERT INTO inspection_profile_photo_items (tenant_id, profile_id, label, is_required, sort_order) VALUES
-- Empresa Teste 1
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Frente',            true,  0),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Lateral Esquerda',  true,  1),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Lateral Direita',   true,  2),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Traseira',          true,  3),
('00000000-0000-0000-0000-000000000001', '20000000-0000-4000-8000-000000000001', 'Painel/Odômetro',   false, 4),
-- Empresa Teste 2
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Frente',            true,  0),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Lateral Esquerda',  true,  1),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Lateral Direita',   true,  2),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Traseira',          true,  3),
('00000000-0000-0000-0000-000000000002', '20000000-0000-4000-8000-000000000002', 'Painel/Odômetro',   false, 4);

-- ============================================================
-- SETTINGS
-- ============================================================
INSERT INTO settings (tenant_id, key, value) VALUES
('00000000-0000-0000-0000-000000000001', 'company_name',          'Empresa Teste 1'),
('00000000-0000-0000-0000-000000000001', 'company_cnpj',          ''),
('00000000-0000-0000-0000-000000000001', 'company_phone',         ''),
('00000000-0000-0000-0000-000000000001', 'company_email',         'contato@empresa1.teste.com'),
('00000000-0000-0000-0000-000000000001', 'company_address',       ''),
('00000000-0000-0000-0000-000000000001', 'email_notifications',   'true'),
('00000000-0000-0000-0000-000000000001', 'due_date_warning_days', '3'),
('00000000-0000-0000-0000-000000000002', 'company_name',          'Empresa Teste 2'),
('00000000-0000-0000-0000-000000000002', 'company_cnpj',          ''),
('00000000-0000-0000-0000-000000000002', 'company_phone',         ''),
('00000000-0000-0000-0000-000000000002', 'company_email',         'contato@empresa2.teste.com'),
('00000000-0000-0000-0000-000000000002', 'company_address',       ''),
('00000000-0000-0000-0000-000000000002', 'email_notifications',   'true'),
('00000000-0000-0000-0000-000000000002', 'due_date_warning_days', '3'),
-- Configurações financeiras — encargos padrão (Spec 0008 RF-001)
('00000000-0000-0000-0000-000000000001', 'late_charge_defaults',
  '{"late_fee_type":"fixed","late_fee_value":30,"daily_interest_rate":0.005,"grace_period_days":5}'),
('00000000-0000-0000-0000-000000000002', 'late_charge_defaults',
  '{"late_fee_type":"fixed","late_fee_value":30,"daily_interest_rate":0.005,"grace_period_days":5}'),
-- Configurações financeiras — inadimplência (Spec 0008 RF-032)
('00000000-0000-0000-0000-000000000001', 'delinquency_thresholds',
  '{"delinquent_count":3,"delinquent_days":30,"blocked_count":5,"blocked_days":60,"auto_block":false}'),
('00000000-0000-0000-0000-000000000002', 'delinquency_thresholds',
  '{"delinquent_count":3,"delinquent_days":30,"blocked_count":5,"blocked_days":60,"auto_block":false}'),
-- Configurações financeiras — crédito automático (Spec 0008 RF-025)
('00000000-0000-0000-0000-000000000001', 'auto_apply_credit', '{"enabled":false}'),
('00000000-0000-0000-0000-000000000002', 'auto_apply_credit', '{"enabled":false}');

-- ============================================================
-- VEHICLES — Empresa Teste 1 (10 veículos)
--
-- Placas:  TE1-0001 a TE1-0010
-- RENAVAM: 11000000001 a 11000000010 (11 dígitos)
-- Chassi:  TEST1VEHICLE00001 a TEST1VEHICLE00010 (17 chars)
-- Status:  todos available
-- ============================================================
INSERT INTO vehicles (
    id, tenant_id, license_plate, model, make,
    year_manufacture, year_model, color, renavam, chassis,
    fuel, engine_capacity, status, km_current,
    registered_owner_name, registered_owner_document, registered_owner_type,
    registration_state, ownership_transferred, acquisition_type, acquisition_amount
) VALUES
('a1000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0001', 'CG 160 Start', 'Honda',  '2022', '2022', 'Vermelha', '11000000001', 'TEST1VEHICLE00001', 'Gasolina', '160cc', 'available', 15000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'used',    12000.00),
('a1000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0002', 'CG 160 Fan',   'Honda',  '2022', '2023', 'Preta',    '11000000002', 'TEST1VEHICLE00002', 'Flex',     '160cc', 'available', 22000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'zero_km', 13900.00),
('a1000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0003', 'Factor 150',   'Yamaha', '2023', '2023', 'Branca',   '11000000003', 'TEST1VEHICLE00003', 'Flex',     '150cc', 'available',  8000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'zero_km', 14250.00),
('a1000004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0004', 'Biz 125',      'Honda',  '2021', '2022', 'Azul',     '11000000004', 'TEST1VEHICLE00004', 'Flex',     '125cc', 'available', 35000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'used',     9800.00),
('a1000005-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0005', 'Pop 110i',     'Honda',  '2022', '2022', 'Vermelha', '11000000005', 'TEST1VEHICLE00005', 'Gasolina', '110cc', 'available', 12000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'zero_km',  7600.00),
('a1000006-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0006', 'CG 160 Titan', 'Honda',  '2023', '2023', 'Preta',    '11000000006', 'TEST1VEHICLE00006', 'Flex',     '160cc', 'available',  5000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'zero_km', 14500.00),
('a1000007-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0007', 'YBR 150',      'Yamaha', '2022', '2022', 'Branca',   '11000000007', 'TEST1VEHICLE00007', 'Flex',     '150cc', 'available', 18000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'used',    12500.00),
('a1000008-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0008', 'Fazer 250',    'Yamaha', '2021', '2021', 'Vermelha', '11000000008', 'TEST1VEHICLE00008', 'Flex',     '250cc', 'available', 40000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'used',    18000.00),
('a1000009-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0009', 'Crosser 150',  'Yamaha', '2023', '2023', 'Azul',     '11000000009', 'TEST1VEHICLE00009', 'Flex',     '150cc', 'available',  3000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'zero_km', 15000.00),
('a1000010-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', 'TE1-0010', 'CB 300',       'Honda',  '2022', '2022', 'Preta',    '11000000010', 'TEST1VEHICLE00010', 'Flex',     '300cc', 'available', 28000, 'Empresa Teste 1 LTDA', '11222333000181', 'cnpj', 'SP', true, 'used',    20000.00);

-- ============================================================
-- VEHICLES — Empresa Teste 2 (10 veículos)
--
-- Placas:  TE2-0001 a TE2-0010
-- RENAVAM: 22000000001 a 22000000010
-- Chassi:  TEST2VEHICLE00001 a TEST2VEHICLE00010 (17 chars)
-- Status:  todos available
-- ============================================================
INSERT INTO vehicles (
    id, tenant_id, license_plate, model, make,
    year_manufacture, year_model, color, renavam, chassis,
    fuel, engine_capacity, status, km_current,
    registered_owner_name, registered_owner_document, registered_owner_type,
    registration_state, ownership_transferred, acquisition_type, acquisition_amount
) VALUES
('a2000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0001', 'CG 160 Start', 'Honda',  '2022', '2022', 'Azul',     '22000000001', 'TEST2VEHICLE00001', 'Gasolina', '160cc', 'available', 12000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',    11500.00),
('a2000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0002', 'Factor 150',   'Yamaha', '2023', '2023', 'Vermelha', '22000000002', 'TEST2VEHICLE00002', 'Flex',     '150cc', 'available',  9000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'zero_km', 14250.00),
('a2000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0003', 'Biz 125',      'Honda',  '2021', '2022', 'Preta',    '22000000003', 'TEST2VEHICLE00003', 'Flex',     '125cc', 'available', 30000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',     9500.00),
('a2000004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0004', 'Pop 110i',     'Honda',  '2022', '2022', 'Branca',   '22000000004', 'TEST2VEHICLE00004', 'Gasolina', '110cc', 'available',  8000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'zero_km',  7600.00),
('a2000005-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0005', 'CG 160 Fan',   'Honda',  '2022', '2023', 'Azul',     '22000000005', 'TEST2VEHICLE00005', 'Flex',     '160cc', 'available', 20000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',    13000.00),
('a2000006-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0006', 'CG 160 Titan', 'Honda',  '2023', '2023', 'Vermelha', '22000000006', 'TEST2VEHICLE00006', 'Flex',     '160cc', 'available',  4000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'zero_km', 14500.00),
('a2000007-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0007', 'YBR 150',      'Yamaha', '2022', '2022', 'Preta',    '22000000007', 'TEST2VEHICLE00007', 'Flex',     '150cc', 'available', 15000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',    12000.00),
('a2000008-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0008', 'Fazer 250',    'Yamaha', '2021', '2021', 'Branca',   '22000000008', 'TEST2VEHICLE00008', 'Flex',     '250cc', 'available', 38000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',    17500.00),
('a2000009-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0009', 'Crosser 150',  'Yamaha', '2023', '2023', 'Vermelha', '22000000009', 'TEST2VEHICLE00009', 'Flex',     '150cc', 'available',  2000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'zero_km', 15000.00),
('a2000010-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', 'TE2-0010', 'CB 300',       'Honda',  '2022', '2022', 'Azul',     '22000000010', 'TEST2VEHICLE00010', 'Flex',     '300cc', 'available', 25000, 'Empresa Teste 2 LTDA', '44555666000174', 'cnpj', 'SP', true, 'used',    19500.00);

-- Atribuir plano de manutenção padrão a todos os veículos de cada empresa
UPDATE vehicles SET maintenance_plan_id = '10000000-0000-4000-8000-000000000001'
 WHERE tenant_id = '00000000-0000-0000-0000-000000000001';

UPDATE vehicles SET maintenance_plan_id = '10000000-0000-4000-8000-000000000002'
 WHERE tenant_id = '00000000-0000-0000-0000-000000000002';

-- ============================================================
-- CUSTOMERS — Empresa Teste 1 (10 clientes)
--
-- CPFs válidos (módulo-11) derivados de bases decimais mínimas:
--   10000000019, 20000000027, 30000000035, 40000000043, 50000000051,
--   60000000060, 70000000078, 80000000086, 90000000094, 11000000036
-- Cliente 9 (Igor Pinto) está na fila de espera.
-- ============================================================
INSERT INTO customers (id, tenant_id, user_id, name, cpf, rg, state, phone, email, in_queue, active) VALUES
('c1000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Ana Silva',      '10000000019', '10000001', 'SP', '(11) 91000-0001', 'cliente1@teste.com',  false, true),
('c1000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Bruno Costa',    '20000000027', '20000002', 'SP', '(11) 91000-0002', 'cliente2@teste.com',  false, true),
('c1000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Carlos Mendes',  '30000000035', '30000003', 'SP', '(11) 91000-0003', 'cliente3@teste.com',  false, true),
('c1000004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Diana Rocha',    '40000000043', '40000004', 'SP', '(11) 91000-0004', 'cliente4@teste.com',  false, true),
('c1000005-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Eduardo Lima',   '50000000051', '50000005', 'SP', '(11) 91000-0005', 'cliente5@teste.com',  false, true),
('c1000006-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Fernanda Dias',  '60000000060', '60000006', 'SP', '(11) 91000-0006', 'cliente6@teste.com',  false, true),
('c1000007-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Gabriel Nunes',  '70000000078', '70000007', 'SP', '(11) 91000-0007', 'cliente7@teste.com',  false, true),
('c1000008-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Helena Cruz',    '80000000086', '80000008', 'SP', '(11) 91000-0008', 'cliente8@teste.com',  false, true),
('c1000009-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Igor Pinto',     '90000000094', '90000009', 'SP', '(11) 91000-0009', 'cliente9@teste.com',  true,  true),
('c1000010-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000001', NULL, 'Julia Ferreira', '11000000036', '11000010', 'SP', '(11) 91000-0010', 'cliente10@teste.com', false, true);

-- ============================================================
-- CUSTOMERS — Empresa Teste 2 (10 clientes)
--
-- CPFs válidos (módulo-11):
--   12000000053, 13000000070, 14000000098, 15000000005, 16000000022,
--   17000000040, 18000000067, 19000000084, 21000000044, 22000000061
-- Cliente 9 (Ursula Cardoso) está na fila de espera.
-- ============================================================
INSERT INTO customers (id, tenant_id, user_id, name, cpf, rg, state, phone, email, in_queue, active) VALUES
('c2000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Lucas Barbosa',   '12000000053', '12000001', 'SP', '(21) 92000-0001', 'cliente11@teste.com', false, true),
('c2000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Mariana Castro',  '13000000070', '13000002', 'SP', '(21) 92000-0002', 'cliente12@teste.com', false, true),
('c2000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Nicolas Souza',   '14000000098', '14000003', 'SP', '(21) 92000-0003', 'cliente13@teste.com', false, true),
('c2000004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Olivia Martins',  '15000000005', '15000004', 'SP', '(21) 92000-0004', 'cliente14@teste.com', false, true),
('c2000005-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Paulo Alves',     '16000000022', '16000005', 'SP', '(21) 92000-0005', 'cliente15@teste.com', false, true),
('c2000006-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Rafaela Gomes',   '17000000040', '17000006', 'SP', '(21) 92000-0006', 'cliente16@teste.com', false, true),
('c2000007-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Samuel Pereira',  '18000000067', '18000007', 'SP', '(21) 92000-0007', 'cliente17@teste.com', false, true),
('c2000008-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Tatiana Borges',  '19000000084', '19000008', 'SP', '(21) 92000-0008', 'cliente18@teste.com', false, true),
('c2000009-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Ursula Cardoso',  '21000000044', '21000009', 'SP', '(21) 92000-0009', 'cliente19@teste.com', true,  true),
('c2000010-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000002', NULL, 'Victor Teixeira', '22000000061', '22000010', 'SP', '(21) 92000-0010', 'cliente20@teste.com', false, true);

-- ============================================================
-- QUEUE ENTRIES (1 por empresa — cliente 9 de cada)
-- ============================================================
INSERT INTO queue_entries (tenant_id, customer_id, position, notes) VALUES
('00000000-0000-0000-0000-000000000001', 'c1000009-0000-4000-8000-000000000000', 1, 'Aguardando disponibilidade de moto'),
('00000000-0000-0000-0000-000000000002', 'c2000009-0000-4000-8000-000000000000', 1, 'Aguardando disponibilidade de moto');

-- ============================================================
-- VEHICLE STATUS HISTORY (backfill — mesmo padrão da migration 20260702100001)
-- Em produção, o backfill roda automaticamente antes do deploy.
-- Aqui é necessário porque o seed roda depois das migrations.
-- ============================================================
INSERT INTO vehicle_status_history (vehicle_id, tenant_id, previous_status, new_status, changed_by, created_at)
SELECT id, tenant_id, NULL, status, NULL, created_at
FROM vehicles
ON CONFLICT DO NOTHING;

-- ============================================================
-- Contatos da locadora exibidos no app do cliente ("Fale com a locadora")
-- ============================================================
INSERT INTO tenant_contacts (tenant_id, label, phone, phone_kind, email, business_hours, sort_order) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Financeiro', '11987654321', 'whatsapp', 'financeiro@empresa01.com', 'Seg a sex, 8h às 18h', 0),
    ('00000000-0000-0000-0000-000000000001', 'Manutenção', '1133334444',  'phone',    NULL,                       'Seg a sáb, 8h às 12h', 1);
