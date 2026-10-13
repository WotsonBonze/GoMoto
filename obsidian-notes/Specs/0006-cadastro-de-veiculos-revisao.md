---
status: aprovado
versão: 1.0
autor: Alan (com agente IA)
data: 2026-07-01
prd: "[[PRDs/0006-cadastro-de-veiculos-revisao]]"
adr:
  - "[[decisions/0010-galeria-de-fotos-vehicle-photos]]"
  - "[[decisions/0011-historico-de-status-append-only]]"
related:
  - "[[Arquitetura Proposta]]"
  - "[[Banco de Dados]]"
  - "[[PRDs/0006-cadastro-de-veiculos-revisao]]"
  - "[[Telas/Motos]]"
tags:
  - spec
  - cadastro-de-veiculos-revisao
  - veiculos
modo: completo
---

# Spec 0006 — Revisão do Módulo de Veículos

> ✅ **Status: aprovado** em 2026-07-01. Spec técnica completa (12 seções) para o PRD 0006. Cobre: ciclo de vida de status com 7 estados + histórico imutável, galeria de 6 fotos em tabela própria, rastreador GPS, seguro, extensão de `acquisition_type`, novas rotas `/motos/[id]` e `/motos/[id]/editar`, integração com `contratos/actions.ts` para RF-022/RF-023. ADRs propostas: galeria de fotos como tabela + histórico append-only.

---

## §1 Visão Geral Técnica

### 1.1 Resumo do que será construído

Revisão do módulo `/motos` de `apps/web`, ampliando o cadastro existente (PRD 0002) com:

1. **Ciclo de vida de status com auditoria** — nova tabela `vehicle_status_history` (append-only) + expansão do enum de status de 4 para 7 valores.
2. **Novos campos em `motorcycles`** — rastreador GPS, seguro, `km_entry` e extensão de `acquisition_type`.
3. **Galeria de fotos em 6 slots nomeados** — nova tabela `vehicle_photos` + bucket Supabase Storage `vehicle-photos`, substituindo o campo `photo_url` único.
4. **Novas rotas de tela** — `/motos/[id]` (detalhe) e `/motos/[id]/editar` (edição), refatoração de `/motos/novo` e `/motos` (listagem).
5. **Integração com contratos** — `contratos/actions.ts` passa a escrever em `vehicle_status_history` ao criar/encerrar locações.

### 1.2 Tecnologias e pacotes envolvidos

| Camada | Pacote / Ferramenta | Uso nesta feature |
|---|---|---|
| Schema Zod + tipos | `@gomoto/core` (`packages/core/`) | Novos schemas: `VehicleStatusTransitionSchema`, extensão de `MotorcycleSchema` |
| Regras puras | `packages/core/src/rules/vehicle-status.ts` | `canChangeStatus()`, `getSelectableStatuses()` |
| UI + Server Actions | `apps/web/src/app/(dashboard)/motos/` | Novas rotas + `actions.ts` expandido |
| Banco | Supabase PostgreSQL | 1 migration principal + 1 migration de backfill |
| Storage | Supabase Storage | Bucket `vehicle-photos` com policy por tenant |
| Testes unit | Vitest (`packages/core/`) | Regras de transição de status, validação de IMEI |
| Testes E2E | Playwright (`apps/web/tests/e2e/`) | Fluxos de cadastro, edição, Vender/Desativar/Reativar |

### 1.3 Arquivos criados ou modificados

**Novos:**
- `supabase/migrations/<ts>_extend_motorcycles_and_vehicle_entities.sql`
- `supabase/migrations/<ts>_backfill_vehicle_status_history.sql`
- `apps/web/src/app/(dashboard)/motos/[id]/page.tsx`
- `apps/web/src/app/(dashboard)/motos/[id]/editar/page.tsx`
- `apps/web/src/lib/vehicle-status-history.ts`
- `packages/core/src/schemas/vehicles.ts`
- `packages/core/src/rules/vehicle-status.ts`
- `apps/web/tests/e2e/motos.spec.ts`
- `apps/web/tests/integration/contract-vehicle-status.spec.ts`

**Modificados:**
- `packages/core/src/schemas/index.ts` — re-export de `vehicles.ts`
- `packages/core/src/rules/motorcycles.ts` — adicionar `canChangeStatus`, `getSelectableStatuses`
- `apps/web/src/app/(dashboard)/motos/actions.ts` — ampliar com ações de status e fotos
- `apps/web/src/app/(dashboard)/motos/page.tsx` — filtros expandidos + foto principal
- `apps/web/src/app/(dashboard)/contratos/actions.ts` — escrever em `vehicle_status_history`

### 1.4 Dependências de execução

```
migration principal
  └─> backfill (precisa da tabela criada antes)
      └─> bucket vehicle-photos criado (parte da migration)
          └─> @gomoto/core atualizado
              └─> motos/actions.ts
                  └─> contratos/actions.ts (ponto de integração)
                      └─> UI
                          └─> testes E2E
```

---

## §2 Arquitetura

### 2.1 Diagrama de contexto

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/web                                                        │
│                                                                 │
│  /motos (listagem)          /motos/novo (criação)              │
│  /motos/[id] (detalhe) ◄──► /motos/[id]/editar (edição)       │
│       │                             │                           │
│       └─────────────┬───────────────┘                          │
│                     ▼                                           │
│             motos/actions.ts  ◄──── contratos/actions.ts       │
│             (Server Actions)          (ponto de integração)     │
└─────────────────────┬───────────────────────────────────────────┘
                      │
          ┌───────────┴───────────────┐
          ▼                           ▼
   @gomoto/core                 Supabase
   ─────────────────────────    ──────────────────────────────
   schemas/vehicles.ts          motorcycles (extende)
   rules/vehicle-status.ts      vehicle_status_history (nova)
   types/vehicles.ts            vehicle_photos (nova)
                                vehicle-photos (bucket Storage)
```

### 2.2 Componentes e responsabilidades

| Componente | Tipo | Responsabilidade |
|---|---|---|
| `packages/core/schemas/vehicles.ts` | Schema Zod | `MotorcycleSchema` expandido, `VehicleStatusTransitionSchema`, `VehiclePhotoUpsertSchema` |
| `packages/core/rules/vehicle-status.ts` | Regra pura | `canChangeStatus()`, `getSelectableStatuses()` |
| `packages/core/types/vehicles.ts` | Tipos TS | `VehicleStatus`, `VehiclePhotoSlot`, `VehicleStatusHistoryEntry` |
| `apps/web/src/lib/vehicle-status-history.ts` | Helper | `recordStatusTransition()` — compartilhado entre `motos/actions.ts` e `contratos/actions.ts` |
| `apps/web/.../motos/actions.ts` | Server Actions | `createVehicle`, `updateVehicle`, `changeVehicleStatus`, `deleteVehiclePhoto` |
| `apps/web/.../motos/page.tsx` | Server Component | Listagem com filtros e foto principal |
| `apps/web/.../motos/[id]/page.tsx` | Server Component | Tela de detalhe — todas as áreas |
| `apps/web/.../motos/[id]/editar/page.tsx` | Server Component | Formulário pré-preenchido de edição |
| `apps/web/.../contratos/actions.ts` | Server Action (modificado) | Ao criar/encerrar contrato, passa a escrever em `vehicle_status_history` |

### 2.3 Decisões arquiteturais

**D1 — Slots de foto: tabela `vehicle_photos`** (não colunas em `motorcycles`)
Consistente com `vehicle_documents`/`vehicle_obligations`; RLS independente; suporta metadados futuros por slot. O JOIN para foto principal na listagem é uma sub-query simples com índice. → Candidata a ADR.

**D2 — `inactive` mantido** (não renomeado para `deactivated`)
`inactive` é o valor técnico existente. Label UI "Desativado" fica no componente. Zero backfill de renomeação, zero janela de inconsistência. QA-001 do PRD resolvida aqui.

**D3 — `acquisition_type` expandido**
`purchase → used`, `lease → other`. Adicionados: `settled` (quitado), `financed` (financiado). Mantidos: `zero_km`, `consignment`, `donation`, `other`.

**D4 — `recordStatusTransition` via Server Action** (não trigger Postgres)
Consistente com o padrão `audit_logs` existente. Lança exceção em falha para garantir que a action caller seja interrompida (RN-006). → Trigger Postgres se operações fora do fluxo de Server Actions forem adicionadas no futuro.

**D5 — `km_entry` como campo separado de `km_current`**
`km_current` = odômetro atual (mutável, histórico); `km_entry` = km no momento da compra (imutável, RN-010).

---

## §3 Fluxos Técnicos

### 3.1 Sem eventos assíncronos
Todos os fluxos são síncronos via Server Actions. Seção de Eventos omitida.

### 3.2 Fluxo Principal — Criar veículo

```
Client: POST → createVehicle(formData)

actions.ts:
  1. createClient() + getAuthenticatedUser()  → 401 se ausente
  2. getCurrentTenantId(supabase)             → 403 se ausente
  3. MotorcycleSchema.safeParse(formData)     → VALIDATION_ERROR se inválido
  4. INSERT motorcycles (com tenant_id, km_entry)
       → CONFLICT se placa duplicada no tenant
  5. recordStatusTransition({ previousStatus: null, newStatus, userId })
  6. [Paralelo, não-bloqueante — RNF-009]
     Para cada slot com foto (URL já enviada ao Storage pelo cliente):
       upsert vehicle_photos(motorcycle_id, tenant_id, slot, url)
       → em caso de falha: adicionar a failedSlots[], continuar
  7. logAction({ action: 'create', table: 'motorcycles' })
  8. revalidatePath('/motos')
  9. return { ok: true, data: { id, failedSlots? } }

Client:
  → ok=true: redirect /motos/[id]
  → ok=true + failedSlots: toast de aviso por slot
  → ok=false: erro inline no campo
```

### 3.3 Fluxos Alternativos

#### 3.3.1 Visualizar detalhe `/motos/[id]`

```
Server Component: Promise.all([
  supabase.from('motorcycles').select('*').eq('id', id).single(),
  supabase.from('vehicle_photos').select('*').eq('motorcycle_id', id),
  supabase.from('vehicle_status_history')
    .select('*').eq('motorcycle_id', id).order('created_at', desc),
  supabase.from('vehicle_documents').eq('motorcycle_id', id).eq('is_current', true),
  supabase.from('vehicle_obligations').eq('motorcycle_id', id).order('due_date'),
  supabase.from('maintenances').eq('motorcycle_id', id).order('created_at', desc).limit(10),
])
→ null em ①: notFound()
Fotos: URLs assinadas via createSignedUrl(path, 3600) em paralelo
Botões: getSelectableStatuses(moto.status) → ações disponíveis
```

#### 3.3.2 Editar veículo

```
POST → updateVehicle(vehicleId, formData)
  1. Resolver user + tenantId
  2. Buscar status atual do veículo (para detectar mudança)
  3. VehicleBaseSchema.partial().safeParse(formData)
     - km_entry ignorado mesmo se enviado (RF-015)
     - Se vehicle.status === 'rented': forçar status = 'rented' (RN-002)
     - status aceita apenas ['available','reserved','maintenance','sinister']
  4. Se parsed.status ≠ vehicle.status: recordStatusTransition(...)
  5. UPDATE vehicles
  6. Fotos: upsert por URL presente; DELETE por null (remove do Storage + tabela)
  7. logAction + revalidatePath
  8. Se obrigações enviadas: upsert em vehicle_obligations via saveVehicleObligations
```

#### 3.3.3 Vender ou Desativar

```
POST → changeVehicleStatus(motorcycleId, { new_status: 'sold' | 'inactive' })
  (Client exibe modal de confirmação antes — RF-018)
  1. Resolver user + tenantId
  2. Buscar status atual
  3. canChangeStatus(current, new_status) → false se rented (RN-001)
  4. UPDATE motorcycles SET status = new_status
  5. recordStatusTransition(...)
  6. logAction + revalidatePath
```

#### 3.3.4 Reativar

```
POST → changeVehicleStatus(motorcycleId, { new_status: 'available' })
  (Sem modal — RF-021)
  Mesmo fluxo de 3.3.3; canChangeStatus('sold'|'inactive', 'available') = true (RN-004)
```

#### 3.3.5 Automático via contrato (RF-022 / RF-023)

**Gap atual:** `createContract` não atualiza `motorcycles.status`. Adicionar:

```
createContract — após insert em rentals:
  a. Buscar moto: select status
  b. UPDATE motorcycles SET status = 'rented'
  c. recordStatusTransition({ previousStatus: moto.status, newStatus: 'rented', userId })

terminateContractByCustomer / terminateContractByCompany — após UPDATE existente:
  recordStatusTransition({ previousStatus: 'rented', newStatus: 'available', userId })
```

#### 3.3.6 Listagem

```
Server Component:
  1. Query motorcycles: WHERE tenant_id + status IN [...] + ilike (placa/marca/modelo)
  2. Sub-query vehicle_photos: WHERE motorcycle_id IN (ids) AND slot = 'principal'
  3. Map<motorcycleId, url> para renderização
  4. Contadores: query de todos os status do tenant → aggregate no cliente
```

### 3.4 Fluxos de Falha

| Situação | Resposta |
|---|---|
| Placa duplicada | `CONFLICT`, `field: 'license_plate'` |
| Campos obrigatórios ausentes | `VALIDATION_ERROR`, campo específico |
| IMEI inválido | `VALIDATION_ERROR`, `field: 'tracker_imei'` |
| Formato/tamanho de foto inválido | Validado no cliente antes do upload; sem chamada à action |
| Upload de foto falha | `failedSlots[]` no retorno; dados textuais já salvos (RNF-009) |
| Vender/Desativar veículo Locado | `FORBIDDEN` — `canChangeStatus()` false; botões nem exibidos no cliente |
| Falha DB ao mudar status | `INTERNAL` — modal exibe erro; histórico NÃO escrito |
| Veículo não encontrado | `NOT_FOUND` — Next.js `notFound()` |

### 3.5 Helper `recordStatusTransition`

```ts
// apps/web/src/lib/vehicle-status-history.ts
export async function recordStatusTransition(
  supabase: SupabaseClient,
  params: {
    motorcycleId: string
    tenantId: string
    previousStatus: VehicleStatus | null
    newStatus: VehicleStatus
    userId: string | null
  }
): Promise<void> {
  const { error } = await supabase.from('vehicle_status_history').insert({
    motorcycle_id:   params.motorcycleId,
    tenant_id:       params.tenantId,
    previous_status: params.previousStatus,
    new_status:      params.newStatus,
    changed_by:      params.userId,
  })
  if (error) throw new Error(`recordStatusTransition failed: ${error.message}`)
}
```

---

## §4 Modelo de Dados

### 4.1 ENUMs PostgreSQL novos

```sql
CREATE TYPE vehicle_status AS ENUM (
  'available',    -- Disponível
  'rented',       -- Locado
  'reserved',     -- Reservado
  'maintenance',  -- Em manutenção
  'sinister',     -- Sinistrado
  'sold',         -- Vendido
  'inactive'      -- Desativado (mantido do schema anterior)
);

CREATE TYPE vehicle_photo_slot AS ENUM (
  'principal', 'front', 'left_side', 'right_side', 'rear', 'dashboard'
);
```

### 4.2 Extensão da tabela `motorcycles`

#### 4.2.1 Pré-flight (executar antes de qualquer ALTER)

```sql
-- Deve retornar 0 linhas para prosseguir
SELECT status, count(*) FROM motorcycles
WHERE status NOT IN ('available','rented','maintenance','inactive')
GROUP BY status;

SELECT acquisition_type, count(*) FROM motorcycles
WHERE acquisition_type NOT IN ('zero_km','purchase','consignment','lease','donation','other')
GROUP BY acquisition_type;
```

#### 4.2.2 Backfill de acquisition_type

```sql
UPDATE motorcycles SET acquisition_type = 'used'  WHERE acquisition_type = 'purchase';
UPDATE motorcycles SET acquisition_type = 'other' WHERE acquisition_type = 'lease';
```

#### 4.2.3 Converter `status` para ENUM e atualizar `acquisition_type`

```sql
-- Status: VARCHAR+CHECK → ENUM (inactive permanece — D2)
ALTER TABLE motorcycles
  DROP CONSTRAINT IF EXISTS motorcycles_status_check,
  ALTER COLUMN status TYPE vehicle_status USING status::vehicle_status,
  ALTER COLUMN status SET DEFAULT 'available'::vehicle_status;

-- acquisition_type: atualizar CHECK
ALTER TABLE motorcycles
  DROP CONSTRAINT IF EXISTS motorcycles_acquisition_type_check;

ALTER TABLE motorcycles
  ADD CONSTRAINT motorcycles_acquisition_type_check
  CHECK (acquisition_type IN (
    'zero_km', 'used', 'settled', 'financed', 'consignment', 'donation', 'other'
  ));
```

#### 4.2.4 Novas colunas

```sql
ALTER TABLE motorcycles
  ADD COLUMN km_entry                      INTEGER,
  ADD COLUMN has_tracker                   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN tracker_brand                 VARCHAR(100),
  ADD COLUMN tracker_model                 VARCHAR(100),
  ADD COLUMN tracker_imei                  VARCHAR(15),
  ADD COLUMN has_insurance                 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN insurance_monthly_amount      DECIMAL(10,2),
  ADD COLUMN insurance_expiry_date         DATE;

ALTER TABLE motorcycles
  ADD CONSTRAINT motorcycles_tracker_imei_format
    CHECK (tracker_imei IS NULL OR tracker_imei ~ '^\d{15}$'),
  ADD CONSTRAINT motorcycles_tracker_fields_coherence
    CHECK (has_tracker = true OR (tracker_brand IS NULL AND tracker_model IS NULL AND tracker_imei IS NULL)),
  ADD CONSTRAINT motorcycles_insurance_fields_coherence
    CHECK (has_insurance = true OR (insurance_monthly_amount IS NULL AND insurance_expiry_date IS NULL));
```

> `photo_url` mantida mas depreciada — nova leitura usa `vehicle_photos`. Remoção em PRD futuro.

### 4.3 Nova tabela `vehicle_status_history`

```sql
CREATE TABLE vehicle_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  motorcycle_id   UUID NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
  previous_status vehicle_status,
  new_status      vehicle_status NOT NULL,
  changed_by      UUID,           -- NULL = sistema/migration
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Sem updated_at: tabela append-only (RN-007)
);

CREATE INDEX idx_vsh_motorcycle ON vehicle_status_history(motorcycle_id);
CREATE INDEX idx_vsh_tenant     ON vehicle_status_history(tenant_id);
CREATE INDEX idx_vsh_created    ON vehicle_status_history(motorcycle_id, created_at DESC);

ALTER TABLE vehicle_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vsh_select_tenant" ON vehicle_status_history
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));

CREATE POLICY "vsh_insert_tenant" ON vehicle_status_history
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
-- UPDATE e DELETE bloqueados por ausência de política (RN-007)
```

> Exceção ao padrão: sem `updated_at` nem trigger — append-only por design (RN-007).

### 4.4 Nova tabela `vehicle_photos`

```sql
CREATE TABLE vehicle_photos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  motorcycle_id UUID NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
  slot          vehicle_photo_slot NOT NULL,
  url           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_vehicle_photos_slot ON vehicle_photos(motorcycle_id, slot);
CREATE INDEX idx_vehicle_photos_tenant      ON vehicle_photos(tenant_id);
CREATE INDEX idx_vehicle_photos_motorcycle  ON vehicle_photos(motorcycle_id);

CREATE TRIGGER update_vehicle_photos_updated_at
  BEFORE UPDATE ON vehicle_photos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE vehicle_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_vehicle_photos" ON vehicle_photos
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()));
```

### 4.5 Bucket `vehicle-photos`

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-photos', 'vehicle-photos', false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "vehicle_photos_tenant_access" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'vehicle-photos'
    AND (storage.foldername(name))[1] IN (
      SELECT tenant_id::text FROM tenant_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'vehicle-photos'
    AND (storage.foldername(name))[1] IN (
      SELECT tenant_id::text FROM tenant_members WHERE user_id = auth.uid()
    )
  );
```

Estrutura de path: `{tenantId}/{motorcycleId}/{slot}/{filename}`.
URLs via `supabase.storage.from('vehicle-photos').createSignedUrl(path, 3600)` (RNF-005).

### 4.6 Migration de backfill (arquivo separado)

```sql
-- Histórico inicial para motos existentes (R-002)
INSERT INTO vehicle_status_history
  (motorcycle_id, tenant_id, previous_status, new_status, changed_by, created_at)
SELECT id, tenant_id, NULL, status, NULL, created_at
FROM motorcycles;

-- Foto principal a partir de photo_url existente
INSERT INTO vehicle_photos (motorcycle_id, tenant_id, slot, url)
SELECT id, tenant_id, 'principal', photo_url
FROM motorcycles
WHERE photo_url IS NOT NULL
ON CONFLICT (motorcycle_id, slot) DO NOTHING;
```

### 4.7 Índices adicionais para performance (§8)

```sql
CREATE INDEX idx_motorcycles_tenant_status
  ON motorcycles(tenant_id, status);

CREATE INDEX idx_motorcycles_tenant_created
  ON motorcycles(tenant_id, created_at DESC);
```

### 4.8 Schemas Zod — `packages/core/src/schemas/vehicles.ts`

```ts
export const VehicleStatusEnum = z.enum([
  'available', 'rented', 'reserved', 'maintenance',
  'sinister', 'sold', 'inactive',
])
export type VehicleStatus = z.infer<typeof VehicleStatusEnum>

export const VehiclePhotoSlotEnum = z.enum([
  'principal', 'front', 'left_side', 'right_side', 'rear', 'dashboard',
])
export type VehiclePhotoSlot = z.infer<typeof VehiclePhotoSlotEnum>

export const AcquisitionTypeEnum = z.enum([
  'zero_km', 'used', 'settled', 'financed', 'consignment', 'donation', 'other',
])

const imeiSchema = z.string().regex(/^\d{15}$/, 'IMEI deve ter 15 dígitos').optional().nullable()

// VehicleBaseSchema: objeto puro sem refinamentos — usado em VehicleSchema.partial() em updateVehicle.
// Zod não permite .partial() sobre ZodEffects (resultado de .refine()), por isso o objeto base
// é exportado separadamente. VehicleSchema = VehicleBaseSchema + refinamentos cruzados.
export const VehicleBaseSchema = z.object({
  license_plate:             z.string().trim().min(1).max(10),
  renavam:                   z.string().trim().min(1).max(20),
  make:                      z.string().trim().min(1).max(100),
  model:                     z.string().trim().min(1).max(100),
  year_manufacture:          z.string().trim().max(10).optional().nullable(),
  year_model:                z.string().trim().max(10).optional().nullable(),
  color:                     z.string().trim().max(50).optional().nullable(),
  fuel:                      z.string().trim().max(50).optional().nullable(),
  chassis:                   z.string().trim().max(20).optional().nullable(),
  engine_capacity:           z.string().trim().max(20).optional().nullable(),
  km_entry:                  z.number().int().min(0).optional().nullable(),
  observations:              z.string().trim().max(2000).optional().nullable(),
  acquisition_type:          AcquisitionTypeEnum.optional().nullable(),
  purchase_date:             dateString.optional().nullable(),
  acquisition_amount:        z.number().positive().max(9_999_999).optional().nullable(),
  fipe_value:                z.number().positive().max(9_999_999).optional().nullable(),
  previous_owner:            z.string().trim().max(200).optional().nullable(),
  previous_owner_cpf:        z.string().trim().max(14).optional().nullable(),
  registered_owner_name:     z.string().trim().max(200).optional().nullable(),
  registered_owner_document: z.string().trim().max(20).optional().nullable(),
  registered_owner_type:     z.enum(['cpf', 'cnpj']).optional().nullable(),
  registration_state:        z.string().trim().max(2).optional().nullable(),
  ownership_transferred:     z.boolean().optional(),
  ownership_transfer_date:   dateString.optional().nullable(),
  // status restrito a 4 valores selecionáveis manualmente (RF-016)
  status: z.enum(['available', 'reserved', 'maintenance', 'sinister']).optional(),
  has_tracker:               z.boolean().optional(),
  tracker_brand:             z.string().trim().max(100).optional().nullable(),
  tracker_model:             z.string().trim().max(100).optional().nullable(),
  tracker_imei:              imeiSchema,
  has_insurance:             z.boolean().optional(),
  insurance_monthly_amount:  z.number().positive().max(9_999_999).optional().nullable(),
  insurance_expiry_date:     dateString.optional().nullable(),
})

export const VehicleSchema = VehicleBaseSchema.refine(
  (d) => !d.has_tracker || (d.tracker_brand && d.tracker_model && d.tracker_imei),
  { message: 'Preencha marca, modelo e IMEI do rastreador', path: ['tracker_brand'] }
).refine(
  (d) => !d.has_insurance || (d.insurance_monthly_amount && d.insurance_expiry_date),
  { message: 'Preencha valor mensal e vencimento do seguro', path: ['insurance_monthly_amount'] }
)

export const VehicleStatusTransitionSchema = z.object({
  vehicle_id: z.string().uuid(),
  new_status: VehicleStatusEnum,
})

export const VehiclePhotoUpsertSchema = z.object({
  vehicle_id: z.string().uuid(),
  slot:       VehiclePhotoSlotEnum,
  url:        z.string().url(),
})
```

---

## §5 APIs

### 5.1 `createVehicle`

```ts
export async function createVehicle(
  input: unknown
): Promise<ActionResult<{ id: string; failedSlots?: VehiclePhotoSlot[] }>>
```

Input: `MotorcycleSchema` + `photos?: Record<VehiclePhotoSlot, string>` (URLs já no Storage).
Erros: `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR` (campo+mensagem), `CONFLICT` (`license_plate`), `INTERNAL`.
`failedSlots` presente quando algum upsert de foto falhou; dados textuais já persistidos (RNF-009).

### 5.2 `updateVehicle`

```ts
export async function updateVehicle(
  motorcycleId: string,
  input: unknown
): Promise<ActionResult<{ id: string; failedSlots?: VehiclePhotoSlot[] }>>
```

Input: `VehicleBaseSchema.partial()` + `photos?: Record<VehiclePhotoSlot, string | null>` (`null` = deletar slot).

> **Nota:** usa `VehicleBaseSchema.partial()` (objeto puro) em vez de `VehicleSchema.partial()` porque `VehicleSchema` é `ZodEffects` (resultado de `.refine()`), e Zod não permite `.partial()` sobre `ZodEffects`. As validações cruzadas de rastreador/seguro não fazem sentido em updates parciais.

Regras: `km_entry` ignorado; `status` bloqueado em `rented` se veículo está Locado; `status` não aceita `rented/sold/inactive`.
Efeito colateral: se status mudou → `recordStatusTransition`.
Erros: idem §5.1 + `NOT_FOUND`.

### 5.3 `changeVehicleStatus`

```ts
export async function changeVehicleStatus(
  motorcycleId: string,
  input: unknown
): Promise<ActionResult<{ id: string }>>
```

Input: `VehicleStatusTransitionSchema` — `new_status` aceita apenas `'sold'`, `'inactive'`, `'available'`.
Regra: `canChangeStatus(current, new)` — tabela de transições:

| De \ Para | available | sold | inactive |
|---|---|---|---|
| available/reserved/maintenance/sinister | ✅ | ✅ | ✅ |
| **rented** | ❌ | ❌ | ❌ |
| sold / inactive | ✅ (Reativar) | ❌ | ❌ |

Erros: `UNAUTHORIZED`, `FORBIDDEN` (`canChangeStatus=false`), `NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL`.

### 5.3b `saveVehicleObligations`

```ts
export async function saveVehicleObligations(
  vehicleId: string,
  obligations: Array<{
    type: 'ipva' | 'licensing' | 'dpvat'
    amount: number
    due_date: string
    status: 'pending' | 'paid' | 'exempt'
    reference_year: number
  }>,
): Promise<ActionResult<void>>
```

Upsert em `vehicle_obligations` com `onConflict: 'vehicle_id,type,reference_year'`.
Resolve `tenantId` server-side; injeta `tenant_id` em cada linha do upsert.
Chamada ao final do submit de edição (após `updateVehicle`), somente se houver linhas com `amount` ou `dueDate` preenchidos (ou `status === 'exempt'`).

### 5.4 `deleteVehiclePhoto`

```ts
export async function deleteVehiclePhoto(
  motorcycleId: string,
  slot: VehiclePhotoSlot
): Promise<ActionResult<void>>
```

Sequência: buscar URL → `storage.remove([path])` → `DELETE vehicle_photos WHERE motorcycle_id AND slot`.

### 5.5 Modificações em `contratos/actions.ts`

| Função | Mudança |
|---|---|
| `createContract` | Adicionar: UPDATE motorcycles SET status='rented' + `recordStatusTransition('rented')` |
| `terminateContractByCustomer` | Adicionar: `recordStatusTransition('available')` após UPDATE existente |
| `terminateContractByCompany` | Idem |

### 5.6 Helper `recordStatusTransition`

Lança exceção em falha (não retorna ActionResult) — garante que a action caller seja interrompida (RN-006). Ver §3.5.

### 5.7 Reads — Server Component queries

| Query | Tabelas | Filtros |
|---|---|---|
| Listagem | `vehicles` + sub-query `vehicle_photos(slot=principal)` | `tenant_id`, `status IN [...]`, `ilike` |
| Contadores | `vehicles` | `tenant_id` — aggregate no cliente |
| Detalhe | 6 tabelas via `Promise.all` | `vehicle_id` em todas |
| Edição | `vehicles` + `vehicle_photos` + `vehicle_obligations` + `vehicle_documents (type=crv, is_current=true)` | `vehicle_id` — 4 queries em paralelo |

Página de edição: as 4 queries rodam em `Promise.all`; `vehicle_obligations` retorna ordenado por `due_date DESC` (pega o mais recente de cada tipo); `vehicle_documents` retorna via `.maybeSingle()` (CRV atual). Os campos `crv_number` e `crv_exercise_year` são injetados em `initialData` a partir do doc CRV, pois não existem na tabela `vehicles`.

URLs de fotos: `createSignedUrl(path, 3600)` em paralelo no Server Component (RNF-005).

---

## §6 Segurança

### 6.1 Autenticação

Middleware Next.js redireciona para `/login` se sessão ausente. Cada Server Action inicia com `auth.getUser()` → `UNAUTHORIZED` se null.

### 6.2 Autorização

Única persona: **Operador de Frota** — membro autenticado do tenant (PRD §5.1). Autorização por isolamento de tenant, não por role.

Toda query usa RLS: `tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid())`. Server Actions verificam `getCurrentTenantId` como defesa dupla.

`canChangeStatus()` aplicada server-side — não confia em validação de cliente.

### 6.3 Auditoria

| Trilha | Tabela | Conteúdo | Escrita |
|---|---|---|---|
| Log geral | `audit_logs` | CRUD em `motorcycles` e `vehicle_photos` | `logAction(...)` nas Server Actions |
| Histórico de status | `vehicle_status_history` | Transições de status (consultável pelo operador) | `recordStatusTransition(...)` |

### 6.4 Dados pessoais (RNF-008)

`registered_owner_name`, `registered_owner_document`, `previous_owner`, `previous_owner_cpf` são nullable — anonimizáveis via UPDATE sem excluir o veículo. Endpoint formal: PRD futuro.

### 6.5 Storage

Bucket `vehicle-photos`: `public=false`, `file_size_limit=5MB`, `allowed_mime_types=[jpeg,png,webp]`. Policy por `tenant_id` no path. URLs assinadas (1h).

---

## §7 Observabilidade

### 7.1 Sem métricas instrumentadas
GoMoto não possui stack de métricas externa. Observabilidade via `audit_logs` + `vehicle_status_history` + stderr do servidor.

### 7.2 Eventos a logar

Via `logAction`: `createVehicle` (create/motorcycles), `updateVehicle` (update/motorcycles), `changeVehicleStatus` (update/motorcycles), `deleteVehiclePhoto` (delete/vehicle_photos).

Via `console.error`: falha em `recordStatusTransition` (com `motorcycleId`, `tenantId`, statuses — sem CPF/IMEI/URLs), falha de upload de foto (com `motorcycleId`, `failedSlots[]`), pré-flight da migration com valores inesperados.

**Não logar:** CPF/CNPJ, IMEI, URLs com tokens, payloads completos de formulário.

---

## §8 Performance e Escalabilidade

### 8.1 Metas (RNFs)

| RNF | Meta | Estratégia |
|---|---|---|
| RNF-001 | Listagem <2s / ≤200 motos | Dois-fetch sem N+1 + índices `idx_motorcycles_tenant_status` + `idx_vehicle_photos_slot` |
| RNF-002 | Upload <10s / ≤5MB | Upload direto ao Storage (client-side); `onUploadProgress` para barra; slots em paralelo |
| RNF-003 | Detalhe <3s | 6 queries em `Promise.all`; todas indexadas por `motorcycle_id` |

### 8.2 Listagem

```ts
// Dois-fetch (sem N+1)
const [motos, photoRows] = await Promise.all([
  supabase.from('motorcycles').select(...).eq('tenant_id', tenantId)...,
  supabase.from('vehicle_photos').select('motorcycle_id, url').in('motorcycle_id', motoIds).eq('slot', 'principal'),
])
const photoMap = new Map(photoRows.data?.map(r => [r.motorcycle_id, r.url]))
```

Busca textual `ILIKE`: sem `pg_trgm` em V1 — 200 linhas = <5ms mesmo em scan completo.

Contadores: aggregate no cliente a partir de query de status sem paginação.

### 8.3 Detalhe

6 queries em `Promise.all`. Bottleneck = round-trip rede ao Supabase (~30–80ms). URLs assinadas em paralelo (`Promise.all`). Total esperado: bem dentro de 3s.

### 8.4 Upload

Upload client-side direto ao Storage. `Promise.allSettled` para múltiplos slots em paralelo. `failedSlots` para slots que falharam.

### 8.5 Pontos de revisão para crescimento futuro

| Threshold | Ação |
|---|---|
| >500 motos | Paginação server-side (LIMIT/OFFSET ou cursor) |
| >500 motos | Contadores via RPC `COUNT GROUP BY status` |
| >1.000 motos | `pg_trgm` + GIN index para busca textual |
| >10.000 entradas de histórico | `LIMIT 50` + "ver mais" no detalhe |

---

## §9 Test Strategy

### 9.1 Integration test justificado
RF-022/RF-023: `createContract`/`terminateContract` (módulo contratos) escreve em `vehicle_status_history` (módulo veículos) — cruzamento de módulos com estado persistido.

### 9.2 Testes unitários

**`packages/core/src/rules/vehicle-status.spec.ts`**

```ts
describe('canChangeStatus', () => {
  it('permite available → sold')
  it('permite available → inactive')
  it('permite sold → available')       // Reativar (RN-004)
  it('permite inactive → available')   // Reativar (RN-004)
  it('permite available → reserved')
  it('bloqueia rented → sold')         // RN-001
  it('bloqueia rented → inactive')     // RN-001
  it('bloqueia rented → reserved')     // RN-002
  it('bloqueia sold → inactive')
  it('bloqueia inactive → sold')
})

describe('getSelectableStatuses', () => {
  it('available → [sold, inactive]')   // CA-010
  it('sold → [available]')             // CA-011
  it('inactive → [available]')         // CA-011
  it('rented → []')                    // CA-012
  it('reserved → [sold, inactive]')
})
```

**`packages/core/src/schemas/vehicles.spec.ts`**

```ts
describe('MotorcycleSchema — IMEI', () => {
  it('rejeita IMEI com 5 dígitos')       // CA-033
  it('aceita IMEI com 15 dígitos')       // CA-034
  it('exige marca/modelo/IMEI quando has_tracker=true')
  it('exige valor/vencimento quando has_insurance=true')
})

describe('MotorcycleSchema — campos obrigatórios', () => {
  it('rejeita sem license_plate')
  it('rejeita sem renavam')
  it('rejeita sem make')
  it('rejeita sem model')
  it('aceita sem campos opcionais')      // CA-038
})
```

### 9.3 Testes E2E — `apps/web/tests/e2e/motos.spec.ts`

```ts
// Listagem
test('exibe veículos ativos e oculta Vendido/Desativado por padrão')  // CA-003
test('filtro Em manutenção exibe contador e filtra lista')             // CA-002
test('selecionando filtro Vendido exibe veículo vendido')              // CA-004
test('busca textual por marca filtra a lista')                         // CA-005
test('exibe foto principal na linha da tabela')                        // CA-006
test('exibe placeholder quando sem foto principal')                    // CA-007

// Criação
test('formulário exibe todas as seções visíveis simultaneamente')      // CA-013
test('cadastro com campos mínimos salva e redireciona para detalhe')  // CA-014
test('campo obrigatório vazio exibe erro inline e bloqueia submit')    // CA-015
test('placa duplicada exibe: Esta placa já está cadastrada.')          // CA-016
test('tipo zero_km oculta campos de dono anterior')                    // CA-017
test('tipo usado exibe campos de dono anterior')                       // CA-018
test('cadastro gera entrada no histórico com status inicial e usuário')// CA-023

// Detalhe
test('tela exibe todas as áreas de informação')                        // CA-008
test('área Status exibe histórico do mais recente ao mais antigo')     // CA-009
test('Disponível exibe botões Vender e Desativar')                     // CA-010
test('Vendido exibe botão Reativar')                                   // CA-011
test('Locado não exibe nenhum botão de ação de status')               // CA-012

// Edição
test('KM de entrada ausente no formulário de edição')                  // CA-019
test('seletor de status exibe 4 opções manuais')                       // CA-020
test('seletor de status é read-only quando veículo está Locado')       // CA-021
test('alterar status no form gera entrada no histórico')               // CA-022

// Vender / Desativar / Reativar
test('clicar Vender abre modal de confirmação')                        // CA-024
test('cancelar no modal não altera status')                            // CA-025
test('confirmar Vender atualiza para Vendido e registra histórico')    // CA-026
test('confirmar Desativar atualiza para Desativado e registra')        // CA-027
test('Reativar atualiza para Disponível sem modal')                    // CA-028

// Rastreador e Seguro
test('toggle rastreador desativado oculta campos')                     // CA-031
test('ativar toggle rastreador exibe campos')                          // CA-032
test('IMEI com 5 dígitos exibe erro inline')                          // CA-033
test('IMEI com 15 dígitos é aceito')                                  // CA-034
test('toggle seguro desativado oculta campos')                         // CA-035
test('seguro com valor e vencimento salvo e exibido no detalhe')       // CA-036

// Fotos
test('seção Fotos exibe 6 slots com rótulos corretos')                // CA-037
test('salvar sem fotos não bloqueia o cadastro')                       // CA-038
test('upload de PDF exibe erro inline e mantém slot vazio')            // CA-039
test('nova imagem em slot preenchido substitui a anterior')            // CA-040
test('foto principal exibida na listagem')                             // CA-041
```

### 9.4 Integration tests — `apps/web/tests/integration/contract-vehicle-status.spec.ts`

```ts
describe('status automático via contrato', () => {
  it('createContract: moto → rented e histórico registra transição')     // CA-029
  it('terminateContractByCustomer: moto → available e histórico registra')// CA-030
  it('terminateContractByCompany: moto → available e histórico registra') // CA-030 (variante)
})
```

Requer: `supabase start` (Docker local). Rodar: `pnpm --filter web test:integration`.

### 9.5 O que não testar

Setters triviais de formulário, componentes UI sem lógica, migrations SQL (constraints do banco validam), RLS diretamente (coberta pelos E2E com sessão real).

---

## §10 Deploy e Rollback

### 10.1 Pré-condições

`pnpm build` limpo · `pnpm --filter @gomoto/core test` · `pnpm db:reset` com migration aplicada · pré-flight queries (§4.2.1) retornam 0 linhas.

### 10.2 Ordem de deploy

```
1. supabase db push → extend_motorcycles_and_vehicle_entities
   Verifica: motorcycles.status aceita novos valores; vehicle_status_history e vehicle_photos existem

2. supabase db push → backfill_vehicle_status_history
   Verifica: COUNT(vehicle_status_history) = COUNT(motorcycles)

3. Deploy do código (Vercel/CI)
   Verifica: /motos carrega · /motos/[id] acessível · criação funciona

4. Smoke test:
   [ ] Foto principal visível na listagem
   [ ] Histórico com backfill exibido no detalhe
   [ ] Criar veículo mínimo → detalhe
   [ ] Mudar status → histórico atualizado
```

### 10.3 Compatibilidade código antigo × banco novo

Migrations aditivas: código antigo ignora novas colunas nullable e novas tabelas.
`inactive` mantido → sem janela de inconsistência de renomeação.
`acquisition_type`: código antigo que grave `purchase` quebraria — mas o formulário é deployado junto (passo 3).

### 10.4 Rollback

```sql
-- Reverter tabelas novas
DROP TABLE IF EXISTS vehicle_photos;
DROP TABLE IF EXISTS vehicle_status_history;

-- Reverter colunas novas
ALTER TABLE motorcycles
  DROP COLUMN IF EXISTS km_entry,
  DROP COLUMN IF EXISTS has_tracker, DROP COLUMN IF EXISTS tracker_brand,
  DROP COLUMN IF EXISTS tracker_model, DROP COLUMN IF EXISTS tracker_imei,
  DROP COLUMN IF EXISTS has_insurance, DROP COLUMN IF EXISTS insurance_monthly_amount,
  DROP COLUMN IF EXISTS insurance_expiry_date;

-- Reverter acquisition_type
ALTER TABLE motorcycles DROP CONSTRAINT IF EXISTS motorcycles_acquisition_type_check;
UPDATE motorcycles SET acquisition_type = 'purchase' WHERE acquisition_type = 'used';
ALTER TABLE motorcycles ADD CONSTRAINT motorcycles_acquisition_type_check
  CHECK (acquisition_type IN ('zero_km','purchase','consignment','lease','donation','other'));

-- Reverter status para VARCHAR+CHECK
ALTER TABLE motorcycles
  ALTER COLUMN status TYPE VARCHAR(20) USING status::text,
  ALTER COLUMN status SET DEFAULT 'available',
  ADD CONSTRAINT motorcycles_status_check
    CHECK (status IN ('available','rented','maintenance','inactive'));

DROP TYPE IF EXISTS vehicle_status;
DROP TYPE IF EXISTS vehicle_photo_slot;
```

Código: git revert + redeploy. Bucket: esvaziar e deletar via Storage console.

### 10.5 Verificação pós-deploy

```sql
SELECT
  (SELECT COUNT(*) FROM vehicle_status_history)                     AS history_entries,
  (SELECT COUNT(*) FROM motorcycles)                                AS total_motos,
  (SELECT COUNT(*) FROM vehicle_photos WHERE slot = 'principal')    AS fotos_principal,
  (SELECT COUNT(*) FROM motorcycles WHERE photo_url IS NOT NULL)    AS motos_com_photo_url;
-- Esperado: history_entries = total_motos; fotos_principal = motos_com_photo_url
```

---

## §11 Riscos Técnicos e Questões Abertas

### 11.1 Riscos

| # | Risco | Mitigação na Spec |
|---|---|---|
| R-001 (PRD) | `contratos/actions.ts` sem extensão limpa | Gap mapeado em §3.3.5; `createContract` recebe UPDATE de status + `recordStatusTransition` |
| R-002 (PRD) | Motos existentes sem histórico | Migration de backfill §4.6 + §10 passo 2 |
| R-003 (PRD) | Expansão do CHECK constraint de status | `inactive` mantido — sem renomeação (D2) |
| R-004 (PRD) | Operador marca Vendido/Desativado por engano | Modal de confirmação (RF-018) + Reativar disponível |
| R-005 (PRD) | Volume de fotos e custo de storage | `file_size_limit=5MB`; custo negligenciável para ≤200 motos em V1 |
| RT-001 | Rollback de `acquisition_type` parcialmente destrutivo | Documentado em §10.4; query de contagem pré-deploy quantifica risco |
| RT-002 | `photo_url` e slot `principal` out-of-sync | Código novo nunca escreve em `photo_url`; remover em PRD futuro |
| RT-003 | Sessão JWT expira durante upload | `supabase-js` faz refresh automático; falha → `failedSlots` + toast |
| RT-004 | `tenantId` ausente em `createContract` ao chamar `recordStatusTransition` | §3.3.5 prescreve buscar `tenantId` no início da action; verificar na implementação |

### 11.2 Questões Abertas

| # | Questão | Status |
|---|---|---|
| QA-001 (PRD) | Mapeamento de `inactive` para novo conjunto | **Resolvida**: `inactive` mantido (D2) |
| QA-002 (PRD) | Indicação visual de documentos atrasados na listagem | **Adiada**: PRD futuro de controle de documentação |
| QA-S01 | Onde viver os labels PT dos enums? | **Sugestão**: `VEHICLE_STATUS_LABELS: Record<VehicleStatus, string>` em `packages/core/src/types/vehicles.ts` |
| QA-S02 | `km_current` será atualizado nesta Spec? | **Não**: fora de escopo; PRD futuro de odômetro/check-in |

### 11.3 ADRs propostas

| ADR | Decisão | Por que registrar |
|---|---|---|
| [[decisions/0010-galeria-de-fotos-vehicle-photos\|ADR 0010]] | Galeria de fotos como tabela `vehicle_photos` | Padrão reutilizável para futuros módulos com galeria |
| [[decisions/0011-historico-de-status-append-only\|ADR 0011]] | Histórico de status como tabela append-only (sem `updated_at`, RLS granular por operação) | Novo padrão de auditoria no projeto |

---

## §12 Matriz de Rastreabilidade

### Requisitos Funcionais

| PRD Item | Descrição curta | Seções da Spec | Cobertura de Testes |
|---|---|---|---|
| RF-001 | Listagem com paginação/scroll, ordem decrescente | §3.6, §8.2 | E2E: `motos.spec.ts::exibe veículos ativos` |
| RF-002 | Filtro por pílulas de status com contador dinâmico | §3.6, §8.2 | E2E: `motos.spec.ts::filtro Em manutenção exibe contador` |
| RF-003 | Filtro padrão exclui Vendido e Desativado | §3.6 | E2E: `motos.spec.ts::oculta Vendido por padrão`; `motos.spec.ts::filtro Vendido` |
| RF-004 | Busca textual por placa, marca, modelo | §3.6, §8.2 | E2E: `motos.spec.ts::busca textual por marca` |
| RF-005 | Foto slot `principal` na listagem; placeholder se ausente | §3.6, §4.4, §8.2 | E2E: `motos.spec.ts::foto principal`; `motos.spec.ts::placeholder sem foto` |
| RF-006 | Tela de detalhe com todas as áreas | §3.3.1 | E2E: `motos.spec.ts::tela exibe todas as áreas` |
| RF-007 | Área Status: badge + histórico ordenado DESC | §3.3.1, §4.3, §8.3 | E2E: `motos.spec.ts::histórico do mais recente ao mais antigo` |
| RF-008 | Botões Vender/Desativar quando status ≠ rented/sold/inactive | §5.3, §3.3.3 | Unit: `vehicle-status.spec.ts::getSelectableStatuses(available)`; E2E: `motos.spec.ts::Disponível exibe botões` |
| RF-009 | Botão Reativar quando status = sold ou inactive | §5.3, §3.3.4 | Unit: `vehicle-status.spec.ts::getSelectableStatuses(sold/inactive)`; E2E: `motos.spec.ts::Vendido exibe Reativar` |
| RF-010 | Locado: nenhum botão de ação exibido | §5.3, §3.3.1 | Unit: `vehicle-status.spec.ts::getSelectableStatuses(rented) = []`; E2E: `motos.spec.ts::Locado sem botões` |
| RF-011 | Formulário em seções visíveis (sem wizard) | §3.2, §3.3.2 | E2E: `motos.spec.ts::seções visíveis simultaneamente` |
| RF-012 | Campos obrigatórios: placa, RENAVAM, marca, modelo | §4.8, §5.1 | Unit: `vehicles.spec.ts::rejeita sem campos obrigatórios`; E2E: `motos.spec.ts::campo obrigatório bloqueia submit` |
| RF-013 | Rejeitar placa duplicada no tenant | §3.2, §4.2.3, §5.1 | E2E: `motos.spec.ts::placa duplicada exibe erro inline` |
| RF-014 | Dono anterior visível só quando aquisição ≠ zero_km | §3.2, §3.3.2 | E2E: `motos.spec.ts::zero_km oculta campos`; `motos.spec.ts::usado exibe campos` |
| RF-015 | KM de entrada: criação apenas, imutável na edição | §4.2.4, §5.2 | E2E: `motos.spec.ts::km_entry ausente no formulário de edição` |
| RF-016 | Seletor de status: 4 opções; read-only se Locado | §4.8, §5.2 | E2E: `motos.spec.ts::seletor exibe 4 opções`; `motos.spec.ts::seletor read-only quando Locado` |
| RF-017 | Toda mudança de status gera histórico | §3.5, §4.3, §5.2, §5.3 | E2E: `motos.spec.ts::edição gera histórico`; `motos.spec.ts::criação gera histórico` |
| RF-018 | Modal de confirmação antes de Vender/Desativar | §3.3.3 | E2E: `motos.spec.ts::Vender abre modal`; `motos.spec.ts::cancelar não altera status` |
| RF-019 | Confirmar Vender → status=sold + histórico | §3.3.3, §4.1, §5.3 | Unit: `vehicle-status.spec.ts::available→sold`; E2E: `motos.spec.ts::confirmar Vender` |
| RF-020 | Confirmar Desativar → status=inactive + histórico | §3.3.3, §4.1, §5.3 | Unit: `vehicle-status.spec.ts::→inactive`; E2E: `motos.spec.ts::confirmar Desativar` |
| RF-021 | Reativar → status=available sem modal + histórico | §3.3.4, §5.3 | Unit: `vehicle-status.spec.ts::inactive→available`; E2E: `motos.spec.ts::Reativar sem modal` |
| RF-022 | Criar contrato → moto=rented + histórico | §3.3.5, §5.5 | Integration: `contract-vehicle-status.spec.ts::createContract seta rented` |
| RF-023 | Encerrar contrato → moto=available + histórico | §3.3.5, §5.5 | Integration: `contract-vehicle-status.spec.ts::terminate seta available` |
| RF-024 | Seção rastreador: toggle condicional para marca/modelo/IMEI | §3.2, §4.2.4, §4.8 | E2E: `motos.spec.ts::rastreador oculto`; `motos.spec.ts::rastreador exibido` |
| RF-025 | IMEI deve ter 15 dígitos numéricos | §4.2.4, §4.8 | Unit: `vehicles.spec.ts::IMEI 5 dígitos rejeita`; `vehicles.spec.ts::IMEI 15 dígitos aceita`; E2E: `motos.spec.ts::IMEI erro inline` |
| RF-026 | Seção seguro: toggle condicional para valor/vencimento | §3.2, §4.2.4, §4.8 | E2E: `motos.spec.ts::seguro oculto`; `motos.spec.ts::seguro salvo no detalhe` |
| RF-027 | 6 slots nomeados de foto, todos opcionais | §4.1, §4.4, §5.1 | E2E: `motos.spec.ts::6 slots com rótulos`; `motos.spec.ts::sem fotos salva` |
| RF-028 | Aceitar JPG/PNG/WEBP ≤5MB; erro inline para inválidos | §4.5, §3.2 | E2E: `motos.spec.ts::PDF rejeitado`; `motos.spec.ts::nova imagem substitui anterior` |
| RF-029 | Foto slot `principal` na listagem | §3.6, §4.4, §5.7, §8.2 | E2E: `motos.spec.ts::foto principal na listagem` |

### Requisitos Não Funcionais

| PRD Item | Descrição curta | Seções da Spec | Cobertura de Testes |
|---|---|---|---|
| RNF-001 | Listagem <2s / ≤200 motos | §8.2 (índices + dois-fetch) | N/A — índices `idx_motorcycles_tenant_status` + `idx_vehicle_photos_slot` garantem O(log n) |
| RNF-002 | Upload <10s / ≤5MB; feedback visual | §8.4 (upload direto, `onUploadProgress`) | N/A — `file_size_limit=5MB` no bucket; benchmark manual |
| RNF-003 | Detalhe <3s | §8.3 (`Promise.all` de 6 queries) | N/A — benchmark manual; estrutura paralela garante latência = query mais lenta |
| RNF-004 | Isolamento de tenant | §4.2–§4.5 (RLS), §6.2 | E2E: implícito em todos os testes com sessão autenticada por tenant |
| RNF-005 | URLs assinadas com expiração para fotos | §5.7, §6.5 | N/A — bucket `public=false` + `createSignedUrl(3600)` no Server Component |
| RNF-006 | Chrome, Firefox, Edge, Safari (2 últimas versões) | N/A — responsabilidade da stack (Next.js + Tailwind) | N/A |
| RNF-007 | Utilizável a partir de 1024px | N/A — responsabilidade do layout Tailwind | N/A |
| RNF-008 | Dados pessoais anuláveis/anonimizáveis | §4.2.4 (campos nullable), §6.4 | N/A — nullabilidade garantida pelo schema SQL; PRD futuro de LGPD formalizará endpoint |
| RNF-009 | Falha de upload não bloqueia dados textuais | §3.2, §5.1 (`failedSlots`) | E2E: `motos.spec.ts::salva dados mesmo com slot falho` |

### Regras de Negócio

| PRD Item | Descrição curta | Seções da Spec | Cobertura de Testes |
|---|---|---|---|
| RN-001 | Locado não pode ir para Vendido/Desativado | §5.3 (`canChangeStatus`), §3.3.3 | Unit: `vehicle-status.spec.ts::bloqueia rented→sold`; `::bloqueia rented→inactive` |
| RN-002 | `rented` só atribuído/removido via contrato | §5.3, §5.2 | Unit: `vehicle-status.spec.ts::changeVehicleStatus rejeita rented` |
| RN-003 | `sold`/`inactive` só via ações dedicadas | §4.8 (status restrito a 4 no schema), §5.2 | Unit: `vehicles.spec.ts::schema não aceita sold/inactive` |
| RN-004 | Reativar → sempre Disponível | §5.3, §3.3.4 | Unit: `vehicle-status.spec.ts::sold→available`; `::inactive→available` |
| RN-005 | Exatamente 1 status ativo por veículo | §4.1 (coluna scalar única) | N/A — garantido por estrutura: 1 coluna scalar por row |
| RN-006 | Toda mudança gera histórico obrigatório | §3.5 (`recordStatusTransition` lança exceção), §4.3 | Unit: `vehicle-status.spec.ts::recordStatusTransition propaga erro`; Integration: `contract-vehicle-status.spec.ts` |
| RN-007 | Histórico imutável | §4.3 (sem política UPDATE/DELETE), §6.2 | N/A — garantido por ausência de políticas RLS UPDATE/DELETE |
| RN-008 | Criação gera 1ª entrada no histórico (previousStatus=null) | §3.2, §4.6 | E2E: `motos.spec.ts::criação gera histórico com status anterior vazio` |
| RN-009 | Placa única por tenant | §4.2.3 (UNIQUE constraint), §5.1 | E2E: `motos.spec.ts::placa duplicada exibe erro inline` |
| RN-010 | KM de entrada imutável — **revisada 2026-10-13: gravado uma vez só** (vazio → valor permitido na edição; troca/remoção proibidas, trigger `vehicles_km_entry_guard`) | §4.2.4, §5.2 | E2E: `motos.spec.ts::km_entry ausente no formulário de edição` |
| RN-011 | Dono anterior só quando aquisição ≠ zero_km | §3.2, §4.8 | E2E: `motos.spec.ts::zero_km oculta campos de dono anterior` |
| RN-012 | Máximo 1 rastreador por vez; novo substitui | §4.2.4 (colunas únicas em motorcycles) | N/A — garantido por estrutura: 1 set de colunas scalar por row |
| RN-013 | Cada slot comporta 1 foto; upload substitui | §4.4 (UNIQUE INDEX `(motorcycle_id, slot)`), §5.2 | E2E: `motos.spec.ts::nova imagem substitui anterior no slot` |

---

## Checklist de aprovação

- [x] Sem placeholders `<!-- preencher -->`
- [x] Cobertura da matriz: 100% (29 RFs + 9 RNFs + 13 RNs = 51 itens)
- [x] Toda tabela nova tem `tenant_id` + RLS + trigger `updated_at` (exceto `vehicle_status_history` — exceção documentada, append-only por design)
- [x] Nenhum anti-padrão GoMoto adotado (sem `createClient()` em page.tsx, sem Zod duplicado, sem lógica em UI handler)
- [x] Decisões arquiteturais não triviais referenciadas a ADRs propostas (D1 e D4)
- [x] Schema Zod único em `@gomoto/core`; nunca duplicado em `apps/web`
- [x] `km_entry` imutável prescrito em §5.2 e §4.2.4
- [x] Gap RF-022 identificado e coberto em §3.3.5 e §5.5

**Aprovado por:** Alan em 2026-07-01
