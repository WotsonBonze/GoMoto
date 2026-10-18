---
status: rascunho v1.0
versão: 1.0
autor: Alan (com agente IA)
data: 2026-06-18
related:
  - "[[Telas/Manutenção]]"
  - "[[Telas/Contratos]]"
  - "[[Telas/Motos]]"
  - "[[Banco de Dados]]"
  - "[[Fluxos de Negócio]]"
  - "[[PRDs/0002-cadastro-de-motos-documentacao-e-tco]]"
tags:
  - prd
  - manutencao
  - mobile
  - preventiva
---

# PRD 0003 — Manutenção preventiva: planos, responsabilidade contratual e registro pelo cliente

> 🟡 **Status: rascunho v1.1** em 2026-06-19. Substitui a versão "lista de fases sem schema" anterior. 9 decisões originais; D3 e D4 **revisadas em 2026-06-19** (ver §13). Próximo passo: concluir **F2** (telas de plano + atribuição à moto) — ver §12.

> ✏️ **Revisão 2026-06-19 — simplificação de responsabilidade e remoção de `category`/`type`**
>
> Após implementar F1 e F2 percebemos que:
> - **Toda manutenção do plano é preventiva** por contrato — `maintenance_plan_items.type` era ruído de UI sem variação útil.
> - **Quem paga não cabe em regra automática** no V1 — a regra por categoria contratual (D3) virou cerimônia sem benefício claro. Operador decide caso a caso ao **criar/executar/dar baixa** em uma manutenção (já é o que acontece hoje no modal de conclusão).
>
> **Mudanças no escopo V1:**
> - `category` e `type` saem de `maintenance_plan_items` (migration `drop_category_type_from_plan_items`).
> - `contract_maintenance_rules`, `contracts.default_maintenance_*` e `resolveResponsibility()` ficam **adiados** para um PRD futuro de "regras de responsabilidade".
> - Snapshot em `maintenances.effective_executor` / `effective_customer_payer_pct` **continua valendo** — é o operador quem preenche no modal de conclusão (sem pré-cálculo automático).
> - `is_critical` **fica** no schema (reservado para PRD futuro de bloqueio por crítica vencida — D8, inalterado).
>
> As seções afetadas (§3.2, §5.2, §5.5, §5.6, §6.3, §6.4, §6.9, §7.3, §7.4, §12) ganharam markers `⏸ Adiado` ou foram editadas para refletir o novo escopo.

---

## 1. Contexto

Hoje a manutenção preventiva no GoMoto vive numa mistura de estruturas:

- A regra dos intervalos canônicos está **hardcoded** em `packages/core/src/rules/maintenance.ts` (`STANDARD_INTERVALS`, 27 entradas com duplicatas com/sem acento, `getInterval()` faz lookup tolerante via `normalize()`).
- A tabela `maintenance_items` existe no schema desde a Fase 1 do monorepo mas está **órfã**: o bootstrap do wizard de motos cria registros em `maintenances` direto, sem amarrar `standard_item_id`.
- A função `calculateMaintenanceStatus` classifica em `overdue/upcoming/scheduled/completed` usando um threshold fixo (10% do intervalo padrão / 18 dias) — sem nenhuma configuração visível ao operador.
- O modal de conclusão em `/manutencao` mostra um dropdown `responsibility ∈ {split, company, customer}` por item concluído. **Bug ativo:** essa escolha **não persiste** no banco — não há coluna em `maintenances`. O valor é calculado pra preview de custo e some no save. O lançamento espelho em `expenses` quando o operador escolhe "customer" só consolida o débito conceitual.
- Não existe entidade de "plano de manutenção" — todos os tenants herdam a mesma lista hardcoded e a mesma frota (Honda Biz, Yamaha Factor) usa o mesmo intervalo.
- Não existe entidade de "regra contratual" — cada contrato é mudo sobre quem executa e quem paga a manutenção.
- Não existe fluxo de cliente — o mobile bootstrap ([[Estado Atual]]) tem login funcional, mas zero tela de produto.
- Não existe registro pelo cliente nem fluxo de aprovação.

Resultado: o módulo de manutenção entrega **menos do que poderia** para o operador (sem configuração de plano, sem responsabilidade contratual visível) e **nada** para o cliente (sem mobile, sem registro, sem aprovação).

Este PRD reposiciona a manutenção como **três entidades distintas e bem modeladas**:

1. **Plano de manutenção** — configurável por tenant, com itens próprios, categoria e thresholds.
2. **Regra contratual** — default por contrato + override por categoria/item, expressa "quem executa e quem paga".
3. **Registro pelo cliente** — evidência submetida via mobile, com fluxo de aprovação.

E ataca o débito acumulado: tira intervalos do código, persiste o snapshot de responsabilidade, remove o lançamento espelho em `expenses`, e refatora `calculateMaintenanceStatus` pra função 100% pura sem lookup interno.

---

## 2. Glossário

| Termo | Definição |
|---|---|
| **Plano de manutenção** | Conjunto nomeado de itens com intervalos e thresholds, criado por usuário do tenant. Ex.: "Plano Honda CG 160", "Plano Honda Biz Frota Premium". |
| **Item do plano** | Linha do plano com descrição, categoria, intervalo (km e/ou dias) e configurações. Ex.: "Troca de óleo, oil, 1000 km". |
| **Categoria de item** | Agrupamento semântico (`oil`, `filter`, `brake`, `tire`, `wear_part`, `inspection`, `fluid`, `transmission`, `other`) usado para regras contratuais por categoria. |
| **Sugestão de item** | Item canônico oferecido na criação do plano para reduzir digitação. Vive em `packages/core` como constante; clicar **copia** para o plano (sem FK). |
| **Manutenção** | Registro em `maintenances` representando uma ocorrência do item (agendada ou concluída) para uma moto específica. |
| **Threshold de alerta** (`warn_threshold_pct`) | Percentual do intervalo que dispara o estado `upcoming`. Ex.: 10% de 1000 km = 100 km antes do vencimento. |
| **Executor** | Quem leva a moto à oficina/realiza a manutenção. Binário: `company` (empresa) ou `customer` (cliente). |
| **Pagador** | Quem arca financeiramente. Modelado como `customer_payer_pct INTEGER 0-100`; empresa = 100 − cliente. Permite 100/0, 50/50, 70/30, etc. |
| **Responsabilidade efetiva** | Snapshot do `executor` + `customer_payer_pct` no momento da conclusão da manutenção. Persistido em `maintenances.effective_*`. Imutável retroativamente. |
| **Regra contratual** | Override do contrato sobre a responsabilidade default. Pode ser por categoria (preferido) ou por item específico (escape hatch). |
| **Registro pelo cliente** | Evidência de execução submetida pelo cliente via mobile (data, KM, oficina, valor, fotos). Vive em `maintenance_records`, separada de `maintenances`. |
| **Aprovação** | Fluxo onde operador revisa e aprova/rejeita um registro do cliente. Configurável por tenant + override por contrato. |
| **Item crítico** (`is_critical`) | Flag no item do plano usada futuramente para bloqueio de locação. **Sem uso operacional no V1** — só populado para que o PRD futuro de "regras avançadas" não precise migrar dados retroativamente. |

---

## 3. Objetivos e não-objetivos

### 3.1 Objetivos (V1)

- ✅ Tenant cria, edita e clona **planos de manutenção** próprios, com itens livres ou copiados de sugestões.
- ✅ Cada moto tem **um plano atribuído**; bootstrap retroativo ajuda migração.
- ✅ Tirar `STANDARD_INTERVALS` do código; refatorar `@gomoto/core/rules/maintenance` para funções 100% puras sem lookup interno.
- ⏸ ~~Contrato pode definir **responsabilidade default** (executor + pagador) + override fino via `contract_maintenance_rules` (por categoria ou item).~~ **Adiado em 2026-06-19** — ver §3.2 e D3 revisado.
- ✅ Conclusão de manutenção **persiste** o snapshot `effective_executor` + `effective_customer_payer_pct` em `maintenances`.
- ✅ Remover o lançamento espelho em `expenses` na conclusão (alinha com PRD 0002 D1).
- ✅ Cliente vê suas preventivas no mobile, com badge de executor ("Leve à oficina" vs "Registrar manutenção").
- ✅ Cliente submete registro de manutenção pelo mobile (KM, oficina, valor, fotos obrigatórias do odômetro + opcionais).
- ✅ Operador aprova/rejeita registros via web; aprovação aplica em `maintenances` e dispara próximo agendamento, transacional.
- ✅ Aprovação configurável por tenant (default) + override por contrato.

### 3.2 Não-objetivos (V1 — explicitamente fora do escopo)

- ❌ **Override de plano por moto individual** (`motorcycle_plan_overrides`). Trata-se em V2 se aparecer demanda; tenant pode criar plano específico ("Plano Moto AB123") como workaround.
- ❌ **Catálogo curado de itens pela plataforma** (tabela `maintenance_item_catalog`). Sugestões vivem em código como constante; tenant tem autonomia total.
- ❌ **Rateio financeiro automático** (gerar `billings` pra cobrar a parte do cliente). O snapshot fica pronto em `maintenances.effective_*`, mas a geração de cobrança é PRD próprio.
- ❌ **Bloqueio de locação por preventiva vencida**. Schema preparado (`is_critical`), lógica fora. PRD futuro de "regras avançadas". Decisão D8.
- ❌ **Regra contratual de responsabilidade** (`contract_maintenance_rules`, `contracts.default_maintenance_*`, `resolveResponsibility`). ⏸ **Adiado (2026-06-19)** para um PRD futuro de "regras de responsabilidade". V1 deixa o operador escolher executor + pagador no momento de criar/executar/dar baixa em cada manutenção. Snapshot em `maintenances.effective_*` continua sendo persistido.
- ❌ **Categoria de item de plano** (`maintenance_plan_items.category`). ⏸ **Adiado (2026-06-19)** junto com `contract_maintenance_rules`, pois sua principal serventia era amarrar regras contratuais por categoria. Reintroduzir quando o PRD de regras voltar.
- ❌ **Ordem de Serviço** (`service_orders` + peças + mecânico + tempo). PRD próprio quando o V1 estiver consolidado. Decisão D9.
- ❌ **Notificações push / WhatsApp / email** de manutenção próxima ou vencida. PRD futuro de "automações".
- ❌ **Cron de "marcar como overdue automaticamente"**. Status é derivado em runtime (`calculateMaintenanceStatus`). Persistir overdue vira parte do PRD de automações.
- ❌ **Override de threshold por categoria** (só por item). Caso raro; tenant define no item se precisar.
- ❌ **Aprovação em múltiplos níveis** (gerente → operador). V1 tem 1 nível. Múltiplos níveis em "regras avançadas".
- ❌ **Reescrita das telas `/manutencao` desktop**. O V1 ajusta o necessário para os novos conceitos (escolha de plano, snapshot de responsabilidade) sem refatorar o resto.
- ❌ **Histórico cumulativo do cliente** ("seu Z trocou 8 óleos em 6 meses"). PRD futuro.

---

## 4. Personas e papéis

| Papel | Como interage |
|---|---|
| `tenant_owner` / `tenant_admin` | Cria/edita planos de manutenção; define responsabilidade default em contrato; configura settings de aprovação; revisa registros do cliente. |
| `tenant_operator` | Atribui plano à moto no cadastro; conclui manutenções operacionais; aprova/rejeita registros do cliente. |
| `tenant_viewer` | Consulta histórico de manutenção e responsabilidade efetiva por moto/contrato. |
| `customer` (mobile) | Vê preventivas com responsável; submete evidência quando executor é cliente; corrige após rejeição. |
| `platform_owner` | Não interage diretamente; relatórios cross-tenant herdarão dados do snapshot. |

---

## 5. Modelo de dados

### 5.1 Nova tabela `maintenance_plans`

```sql
CREATE TABLE maintenance_plans (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         VARCHAR(200) NOT NULL,
    description  TEXT,
    is_default   BOOLEAN NOT NULL DEFAULT false,
    archived_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apenas 1 plano default por tenant (pré-seleção no wizard).
CREATE UNIQUE INDEX maintenance_plans_default_unique
    ON maintenance_plans (tenant_id)
    WHERE is_default = true AND archived_at IS NULL;

CREATE INDEX idx_maintenance_plans_tenant ON maintenance_plans(tenant_id);

ALTER TABLE maintenance_plans ENABLE ROW LEVEL SECURITY;
-- Policies seguem padrão get_user_tenants() + bypass platform admin.

CREATE TRIGGER trg_maintenance_plans_updated_at
    BEFORE UPDATE ON maintenance_plans FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### 5.2 Nova tabela `maintenance_plan_items`

> ✏️ **Revisão 2026-06-19:** `category` e `type` foram dropados (migration `drop_category_type_from_plan_items`). Toda manutenção do plano é preventiva por contrato; categoria volta junto com o PRD futuro de regras de responsabilidade.

```sql
CREATE TABLE maintenance_plan_items (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id              UUID NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE,

    name                 VARCHAR(200) NOT NULL,

    interval_km          INTEGER CHECK (interval_km IS NULL OR interval_km > 0),
    interval_days        INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
    warn_threshold_pct   INTEGER CHECK (warn_threshold_pct IS NULL OR (warn_threshold_pct > 0 AND warn_threshold_pct <= 100)),
    is_critical          BOOLEAN NOT NULL DEFAULT false,

    tip                  TEXT,
    sort_order           INTEGER NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (interval_km IS NOT NULL OR interval_days IS NOT NULL)
);

CREATE INDEX idx_maintenance_plan_items_tenant ON maintenance_plan_items(tenant_id);
CREATE INDEX idx_maintenance_plan_items_plan ON maintenance_plan_items(plan_id);

ALTER TABLE maintenance_plan_items ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_maintenance_plan_items_updated_at
    BEFORE UPDATE ON maintenance_plan_items FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### 5.3 Alterações em `motorcycles`

```sql
ALTER TABLE motorcycles
    ADD COLUMN maintenance_plan_id UUID REFERENCES maintenance_plans(id) ON DELETE SET NULL;

CREATE INDEX idx_motorcycles_maintenance_plan ON motorcycles(maintenance_plan_id);
```

`NULL` permitido para suportar migração progressiva: motos existentes sobem sem plano e o operador atribui no próximo acesso à tela `/motos` (banner discreto, sem bloqueio — mesmo padrão do PRD 0002 §10).

### 5.4 Alterações em `maintenances`

```sql
ALTER TABLE maintenances
    ADD COLUMN plan_item_id                  UUID REFERENCES maintenance_plan_items(id) ON DELETE SET NULL,
    ADD COLUMN effective_executor            VARCHAR(20) CHECK (effective_executor IN ('company','customer')),
    ADD COLUMN effective_customer_payer_pct  INTEGER CHECK (effective_customer_payer_pct >= 0 AND effective_customer_payer_pct <= 100);

CREATE INDEX idx_maintenances_plan_item ON maintenances(plan_item_id);
```

- `plan_item_id` é nullable: manutenções corretivas (`type='corrective'`) não vêm de plano. `description` continua existindo como texto de exibição/auditoria.
- A coluna existente `standard_item_id` (referência órfã a `maintenance_items`) **é descontinuada**: tabela `maintenance_items` é dropada (ver §10).

### 5.5 Alterações em `contracts`

> ⏸ **Adiado (2026-06-19)** — `default_maintenance_executor` e `default_customer_payer_pct` saem do V1 junto com o PRD futuro de regras de responsabilidade. `maintenance_approval_required` segue em V1 pois pertence ao fluxo de aprovação de registro pelo cliente (D6).

```sql
ALTER TABLE contracts
    ADD COLUMN maintenance_approval_required  BOOLEAN;
```

`NULL` = herda do default do tenant (settings).

### 5.6 Nova tabela `contract_maintenance_rules`

> ⏸ **Adiado (2026-06-19)** — `contract_maintenance_rules` sai do V1 e volta no PRD futuro de regras de responsabilidade. V1 deixa o operador escolher executor + pagador no momento de cada manutenção.

<details>
<summary>Schema original preservado para referência do PRD futuro</summary>

```sql
CREATE TABLE contract_maintenance_rules (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contract_id              UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

    -- Regra ou por categoria, ou por item (escape hatch).
    category                 VARCHAR(20) CHECK (category IN (
                                'oil','filter','brake','tire','wear_part',
                                'inspection','fluid','transmission','other'
                             )),
    plan_item_id             UUID REFERENCES maintenance_plan_items(id) ON DELETE CASCADE,

    executor                 VARCHAR(20) CHECK (executor IN ('company','customer')),
    customer_payer_pct       INTEGER CHECK (customer_payer_pct >= 0 AND customer_payer_pct <= 100),

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (category IS NOT NULL OR plan_item_id IS NOT NULL),
    CHECK (executor IS NOT NULL OR customer_payer_pct IS NOT NULL)
);

CREATE INDEX idx_contract_maintenance_rules_contract ON contract_maintenance_rules(contract_id);
CREATE INDEX idx_contract_maintenance_rules_tenant ON contract_maintenance_rules(tenant_id);

ALTER TABLE contract_maintenance_rules ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_contract_maintenance_rules_updated_at
    BEFORE UPDATE ON contract_maintenance_rules FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

Precedência aplicada por `resolveResponsibility()`: **item > categoria > default do contrato > NULL** (operador decide caso a caso).

</details>

### 5.7 Nova tabela `maintenance_records`

```sql
CREATE TABLE maintenance_records (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    motorcycle_id          UUID NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    maintenance_id         UUID NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,

    -- Evidência submetida pelo cliente
    submitted_by_user_id   UUID NOT NULL,
    submitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    performed_date         DATE NOT NULL,
    actual_km              INTEGER NOT NULL CHECK (actual_km >= 0),
    workshop_name          VARCHAR(200),
    workshop_cnpj          VARCHAR(20),
    cost                   DECIMAL(10,2) CHECK (cost IS NULL OR cost >= 0),
    observations           TEXT,
    odometer_photo_url     TEXT NOT NULL,
    invoice_photo_url      TEXT,
    evidence_photos        TEXT[] NOT NULL DEFAULT '{}',

    -- Aprovação
    status                 VARCHAR(20) NOT NULL CHECK (status IN (
                              'pending','in_review','approved','rejected'
                           )) DEFAULT 'pending',
    reviewed_by_user_id    UUID,
    reviewed_at            TIMESTAMPTZ,
    rejection_reason       TEXT,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (status != 'rejected' OR rejection_reason IS NOT NULL),
    CHECK (status NOT IN ('approved','rejected') OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

-- Garante no máximo 1 registro aprovado por manutenção; tentativas pending/rejected/in_review são livres.
CREATE UNIQUE INDEX maintenance_records_approved_unique
    ON maintenance_records (maintenance_id)
    WHERE status = 'approved';

CREATE INDEX idx_maintenance_records_tenant ON maintenance_records(tenant_id);
CREATE INDEX idx_maintenance_records_motorcycle ON maintenance_records(motorcycle_id);
CREATE INDEX idx_maintenance_records_maintenance ON maintenance_records(maintenance_id);
CREATE INDEX idx_maintenance_records_status ON maintenance_records(status) WHERE status IN ('pending','in_review');

ALTER TABLE maintenance_records ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_maintenance_records_updated_at
    BEFORE UPDATE ON maintenance_records FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

### 5.8 Storage bucket

- `maintenance-records` (privado, 10 MB max, accept `pdf,jpg,png,webp`) — odômetro, NF, evidências do cliente. Path: `<tenant_id>/<motorcycle_id>/<maintenance_record_id>/<file>`.

### 5.9 Settings por tenant (chaves novas em `settings`)

| Key | Tipo | Default | Significado |
|---|---|---|---|
| `maintenance.approval_required` | boolean | `true` | Aprovação default exigida em registros do cliente. |
| `maintenance.default_warn_threshold_pct` | integer (1-100) | `10` | Threshold default de alerta (em %). |

Função `getMaintenanceSettings(rows): MaintenanceSettings` em `@gomoto/core` agrega chaves `maintenance.*` em objeto tipado.

### 5.10 Tabela descontinuada: `maintenance_items`

`maintenance_items` órfã é **dropada** após verificação de inexistência de FKs ativas. `maintenances.standard_item_id` (não populada na operação atual) é dropada junto. Migração detalhada em §10.

---

## 6. Regras de negócio

### 6.1 `calculateMaintenanceStatus` — refatorada

```ts
calculateMaintenanceStatus({
  completed,
  current_km,
  predicted_km,
  scheduled_date,
  interval_km,             // do plan_item ligado, ou null
  interval_days,
  warn_threshold_pct,      // resolvido antes (item > tenant default)
  today,
}): MaintenanceStatus
```

- `completed=true` → `completed`.
- `predicted_km` definido:
  - `current_km >= predicted_km` → `overdue`.
  - `current_km >= predicted_km − (interval_km × pct/100)` → `upcoming`.
  - senão → `scheduled`.
- `scheduled_date` definido (e `predicted_km` não):
  - `today >= scheduled_date` → `overdue`.
  - `today >= scheduled_date − (interval_days × pct/100)` → `upcoming`.
  - senão → `scheduled`.
- Sem KM nem data → `scheduled` (defensivo).

**Sumiço:** `getInterval`, `normalize`, `STANDARD_INTERVALS` deixam de existir no código.

### 6.2 `calculateNextMaintenance` — refatorada

```ts
calculateNextMaintenance({
  completionKm,
  completionDate,
  interval_km,
  interval_days,
}): { predicted_km?: number; scheduled_date?: string }
```

Recebe intervalo direto (do plan_item), sem lookup por descrição. Quem chama é responsável por buscar o item.

### 6.3 `resolveResponsibility` — ⏸ adiada (2026-06-19)

> Adiada para o PRD futuro de "regras de responsabilidade". V1 não tem pré-cálculo: o operador escolhe executor + `customer_payer_pct` no modal de conclusão (ver §6.9 revisado). O snapshot continua sendo persistido em `maintenances.effective_*`.

<details>
<summary>Spec original preservada para o PRD futuro</summary>

```ts
resolveResponsibility({
  contract,         // default_maintenance_executor, default_customer_payer_pct
  planItem,         // category
  rules,            // contract_maintenance_rules[] do contrato
}): { executor: 'company' | 'customer' | null; customerPayerPct: number | null }
```

Precedência:

1. Regra com `plan_item_id = planItem.id` (override fino).
2. Regra com `category = planItem.category` (override por categoria).
3. Default do contrato (`default_maintenance_executor`, `default_customer_payer_pct`).
4. Nada definido → `null` (operador decide caso a caso na conclusão).

Cada campo (`executor`, `customerPayerPct`) é resolvido de forma independente — uma regra pode setar só executor e deixar o pagador herdar do default.

Função pura, sem side-effects.

</details>

### 6.4 `splitMaintenanceCost` — ⏸ adiada (2026-06-19)

> Função permanece pura e útil, mas como o V1 não tem rateio automático (sem cobrança ao cliente, sem snapshot calculado pelo sistema), ela fica para o PRD futuro junto com a geração de `billings` a partir do snapshot.

<details>
<summary>Spec original preservada</summary>

```ts
splitMaintenanceCost(totalCost: number, customerPayerPct: number): {
  companyAmount: number;
  customerAmount: number;
}
// customerAmount = round2(totalCost * pct / 100)
// companyAmount = totalCost − customerAmount
```

Round 2 casas decimais; empresa absorve a diferença de arredondamento (≤ R$ 0,01).

</details>

### 6.5 `isApprovalRequired` — nova

```ts
isApprovalRequired(tenantSettings, contract): boolean
// contract.maintenance_approval_required ?? tenantSettings['maintenance.approval_required'] ?? true
```

### 6.6 `getWarnThreshold` — nova

```ts
getWarnThreshold(planItem, tenantSettings): number
// planItem.warn_threshold_pct ?? tenantSettings['maintenance.default_warn_threshold_pct'] ?? 10
```

### 6.7 Atribuição de plano à moto

- No wizard de criação de moto (PRD 0002 §7.1, **Passo 3**), o operador escolhe **um plano existente** (select com chips) ou **clona um plano** existente ("Clonar 'Plano CG 160' como 'Plano Yamaha Factor'").
- Se o tenant tem `is_default=true` em algum plano, ele é pré-selecionado.
- Se tenant não tem plano nenhum, o passo exige criação (link "Criar plano agora →" abre `/planos-manutencao` em nova aba ou modal).

> ✏️ **Revisão 2026-08-09** — dois gaps encontrados e corrigidos em `/veiculos`:
> 1. **Bug**: o wizard de criação selecionava o plano e fazia o bootstrap de `maintenances`, mas nunca persistia `vehicles.maintenance_plan_id` (campo nem existia no `VehicleBaseSchema`) — o veículo ficava com o badge "Sem plano" pra sempre.
> 2. **Gap**: `/veiculos/[id]/editar` não tinha nenhuma forma de atribuir plano a um veículo sem plano, nem de trocar o plano de um veículo que já tinha um — a seção "Manutenção" só existia no modo criação.
>
> Fix: nova action dedicada `assignMaintenancePlan` (`apps/web/.../veiculos/actions.ts`) + schema `AssignMaintenancePlanSchema` e função pura `buildMaintenanceBootstrapRows` em `@gomoto/core`. A seção "Plano de Manutenção" do `VehicleForm` agora também aparece no modo edição: troca de plano só atualiza o vínculo (sem re-bootstrap, pra não gerar `maintenances` indesejadas); atribuir um plano a um veículo que não tinha nenhum reaproveita o mesmo fluxo de bootstrap do cadastro. Link "Trocar plano"/"Atribuir plano" adicionado em `/veiculos/[id]` e o badge "Sem plano" em `/veiculos` virou link direto pra edição.
>
> Bônus achado ao testar: os IDs fixos de `maintenance_plans` no `supabase/seed.sql` (`10000000-0000-0000-0000-00000000000X`) não eram UUIDs v4 válidos (nibble de versão `0`), o que quebrava qualquer validação `.uuid()` do Zod contra esses planos (incluindo `createMaintenancePlanItem` pré-existente). Corrigido para `10000000-0000-4000-8000-00000000000X`.
>
> **Segundo bug achado ao testar (mesmo dia)**: salvar o formulário de edição de veículo (por qualquer motivo, inclusive só trocar o plano) corrompia a placa. `applyPlateMask` (`packages/core/src/masks.ts`) é uma máscara progressiva pra digitação — só aceita caracteres em posições específicas do formato de placa real. Ela estava sendo reaplicada em cima do valor **já salvo no banco**, tanto no pré-preenchimento do form quanto na tela de detalhe. Placas fora do formato real (as de seed, `TE1-0001` etc.) tinham os dígitos descartados posição a posição, virando `"TE"` — e como `vehicles_tenant_license_plate_key` é único por `(tenant_id, license_plate)`, a segunda moto editada no mesmo tenant colidia com a primeira, gerando "Erro ao atualizar veículo". Fix: `VehicleForm` (pré-preenchimento) e `/veiculos/[id]` (exibição) pararam de rodar o valor já persistido por `applyPlateMask` — a máscara continua ativa só na digitação nova (`onChange` e import de CRLV).

### 6.8 Bootstrap de `maintenances` ao criar moto

Hoje o passo 3 do wizard pede ao operador "último KM/data de cada item padrão". Refatorado:

1. Operador atribui plano X à moto.
2. Sistema lê `maintenance_plan_items` do plano.
3. Para cada item, operador informa último KM/data realizada (opcional — pode pular pra agendar "hoje").
4. Sistema cria 1 `maintenance` por item:
   - `plan_item_id` = item.id
   - `predicted_km` = ultimo_km + item.interval_km (se km)
   - `scheduled_date` = ultima_data + item.interval_days (se dias)
   - `completed` = false
   - `description` = item.name (snapshot histórico — protege se item renomear)
   - `type` = item.type

### 6.9 Conclusão de manutenção pelo operador

> ✏️ **Revisão 2026-06-19** — sem pré-cálculo automático. O operador escolhe executor e pagador no modal a cada conclusão. Snapshot continua sendo gravado em `maintenances.effective_*`.

- Operador abre modal de conclusão em `/manutencao` (fluxo atual).
- Modal exibe chips livres para executor (Empresa · Cliente) e pagador (Empresa 100% · Cliente 100% · 50/50 · Customizar…). Default = "Empresa 100%" (caso mais comum no operacional atual).
- Operador escolhe caso a caso.
- No save:
  - UPDATE `maintenances` SET `completed=true`, `actual_km`, `completed_date`, `cost`, `workshop`, `effective_executor`, `effective_customer_payer_pct`.
  - INSERT próximo `maintenances` (via `calculateNextMaintenance(planItem)`).
  - UPDATE `motorcycles.km_current` com o `actual_km`.
  - **NÃO INSERE em `expenses`** (mudança vs. estado atual).
  - audit_log (`action='maintenance.completed'`).

### 6.10 Submissão de registro pelo cliente

- Cliente abre app, vê manutenção com `executor='customer'` resolvido.
- Toca "Registrar manutenção feita" → form pede: data, KM, oficina (opcional), valor (opcional), foto odômetro (obrigatória), NF (opcional), fotos extras (opcionais).
- No save:
  - Sistema checa `isApprovalRequired(tenant, contract)`.
  - Se `true`: INSERT `maintenance_records` com `status='pending'`. Cliente vê confirmação "Aguardando aprovação". Operador vê na lista de aprovações.
  - Se `false`: INSERT `maintenance_records` com `status='approved'`, `reviewed_by_user_id=<sentinel system user>`, `reviewed_at=NOW()`. Dispara fluxo de aplicação imediato (§6.11).

### 6.11 Aprovação (ou auto-aprovação) — aplicação transacional

Server Action `approveMaintenanceRecord(recordId)`:

```sql
BEGIN;
  UPDATE maintenance_records SET
    status='approved', reviewed_by_user_id=?, reviewed_at=NOW()
  WHERE id=?;

  UPDATE maintenances SET
    completed=true,
    actual_km=<record.actual_km>,
    cost=<record.cost>,
    completed_date=<record.performed_date>,
    workshop=<record.workshop_name>,
    effective_executor='customer',
    effective_customer_payer_pct=<resolveResponsibility(...).customerPayerPct>
  WHERE id=<record.maintenance_id>;

  -- Próximo agendamento via calculateNextMaintenance(planItem)
  INSERT INTO maintenances (... predicted_km/scheduled_date ...);

  -- Atualiza KM da moto
  UPDATE motorcycles SET km_current = <record.actual_km> WHERE id = ?;

  INSERT INTO audit_logs (action='maintenance_record.approved', ...);
COMMIT;
```

### 6.12 Rejeição

- Operador clica "Rejeitar" → modal pede `rejection_reason` (obrigatório, ≥ 10 chars).
- UPDATE `maintenance_records` SET `status='rejected'`, `reviewed_by_user_id`, `reviewed_at`, `rejection_reason`.
- Cliente recebe (notificação: PRD futuro; por ora a UI mobile mostra ao abrir).
- Cliente clica "Reenviar com correção" → cria **novo** `maintenance_records` com mesmo `maintenance_id`. Os antigos permanecem como histórico.

### 6.13 Estado `in_review`

Reservado no CHECK constraint. **Não usado no V1** — UI transiciona `pending → approved` ou `pending → rejected` direto. Quando aparecer demanda (operação multi-operador), introduz botão "Reservar para análise" sem migration.

---

## 7. Telas e fluxos

### 7.1 Nova tela `/planos-manutencao` (web)

- KPI cards: total de planos, plano default, plano com mais motos atribuídas, itens críticos cadastrados.
- Listagem: nome do plano, nº de itens, nº de motos atribuídas, badge "Default".
- Ações: Criar plano · Clonar plano · Editar · Arquivar.
- Detalhe (drawer): lista de itens com colunas Nome · Categoria · Intervalo · Threshold · Crítico.
  - Botão "Adicionar item" abre modal com **abas**:
    - **"Da sugestão"** — chips de `SUGGESTED_PLAN_ITEMS` agrupados por categoria; clicar pré-preenche o form (categoria + intervalo + crítico default da categoria).
    - **"Item personalizado"** — form livre.
  - Operador pode ajustar antes de salvar.

### 7.2 `/motos` wizard — Passo 3 refatorado

Antes: bootstrap manual dos 13 itens.
Depois:

| Bloco | Conteúdo |
|---|---|
| **Plano de manutenção** | Select de planos do tenant + botão "Clonar plano X" + link "Criar plano agora →". Default pré-selecionado se existir. |
| **Histórico inicial dos itens** | Após selecionar plano, sistema lista os itens. Para cada um: input "último KM" (opcional) + input "última data" (opcional). Vazios = agendar "agora" (predicted_km = km_current; scheduled_date = hoje). |

### 7.3 `/contratos` — editar contrato

> ✏️ **Revisão 2026-06-19** — seção "Manutenção" reduzida ao toggle de aprovação. Default executor/pagador saem com o PRD futuro de regras.

Form principal mantém estrutura atual; adiciona seção **"Manutenção"**:

- Toggle `maintenance_approval_required` com 3 valores: Sim · Não · Usar default do tenant.

### 7.4 Nova rota `/contratos/[id]/manutencao` (web)

> ⏸ **Adiado (2026-06-19)** — tela inteira sai do V1 e volta com o PRD futuro de regras de responsabilidade.

### 7.5 `/manutencao` — modal de conclusão refatorado

> ✏️ **Revisão 2026-06-19** — sem pré-cálculo. Operador escolhe direto.

Mudanças incrementais sobre o modal atual:

- Chips de pagador: `Empresa 100%` (default) · `Cliente 100%` · `50/50` · `Customizar…` (abre input de %).
- Chips de executor: `Empresa` (default) · `Cliente`.
- Após save, persiste em `effective_*` (lê de volta na UI ao reabrir item concluído).
- **Remove** o lançamento em `expenses` que existia (operação invisível no save).

### 7.6 Nova rota `/aprovacoes` (web)

Lista de `maintenance_records` em `status='pending'` ou `in_review`:

- Cards agrupados por moto + cliente.
- Cada card mostra: item da manutenção, KM submetido vs KM esperado, valor, fotos (preview clicável).
- Ações: Aprovar · Rejeitar (com motivo).
- Filtros: status · contrato · cliente · moto.

### 7.7 Mobile — tela "Manutenção"

Lista de manutenções da(s) moto(s) do cliente:

- Agrupado por moto (cliente pode ter mais de um contrato).
- Por item: nome · status (`overdue/upcoming/scheduled/completed`) · KM restante ou data · badge de executor.
- Executor `company`: card com texto "Leve sua moto à oficina X" (oficina vem de `tenant_company_profile.address` ou setting).
- Executor `customer`: botão CTA "Registrar manutenção feita" → abre form.

### 7.8 Mobile — form de registro

Campos:

- Data realizada (date picker; default = hoje; máx = hoje).
- KM atual (input numérico; pré-preenchido com `motorcycles.km_current`).
- Oficina (texto opcional).
- Valor pago (numérico opcional).
- Observações (opcional).
- **Foto do odômetro (obrigatória)** — usa câmera do device.
- Foto da NF (opcional) — câmera ou arquivo.
- Fotos extras (até 5).

Submit → server action → INSERT `maintenance_records`. Mobile mostra tela "Aguardando aprovação" ou "Manutenção registrada" conforme `isApprovalRequired`.

### 7.9 Mobile — histórico

Lista de `maintenance_records` do cliente:

- Status badge (`pending`, `in_review`, `approved`, `rejected`).
- Em rejeitados: motivo + botão "Reenviar com correção" (pré-popula form com últimos dados).

---

## 8. Fluxos críticos (end-to-end)

### 8.1 Tenant novo cria primeiro plano e atribui à primeira moto

```
[Tenant Owner] /planos-manutencao → "Criar plano"
  - Nome: "Plano Padrão"
  - Marca is_default = true
  - "Adicionar item" → aba "Da sugestão" → clica em:
    * Troca de óleo (oil, 1000 km, threshold 10%, crítico não)
    * Filtro de óleo (filter, 4000 km, threshold 10%, crítico não)
    * Pastilha freio traseira (brake, 8000 km, threshold 10%, crítico sim)
    * Pneu dianteiro (tire, 16000 km, threshold 10%, crítico sim)
    * Vistoria mensal (inspection, 30 dias, threshold 10%, crítico não)
  - Salvar

[Tenant Operator] /motos → "Nova moto"
  Passo 1: identificação técnica (PRD 0002 §7.1)
  Passo 2: documentação e aquisição (PRD 0002 §7.1)
  Passo 3: plano "Plano Padrão" pré-selecionado
     - Pra cada item: deixa último KM em branco (não tem histórico)
  Salvar

[Sistema]
  - INSERT motorcycles (maintenance_plan_id = <plano>)
  - INSERT maintenances × 5 (uma por item do plano)
    - predicted_km = km_current + interval_km (se km)
    - scheduled_date = hoje + interval_days (se dias)
```

### 8.2 Conclusão pela empresa com responsabilidade contratual aplicada

```
[Sistema] /manutencao mostra "Troca de óleo — Yamaha Factor" com status "overdue"
[Operador] clica "Concluir"
  Modal abre:
    - Pré-cálculo: contrato da Maria tem default_executor='company', default_customer_payer_pct=0
    - Mas existe contract_maintenance_rule: categoria='oil', executor='customer', customer_payer_pct=100
    - Resolução: como categoria bate, override aplica → executor='customer', payer=100%
    - Mas operador notou que hoje a empresa pagou e levou: clica chip "Empresa 100%" e troca executor pra "Empresa"
  Operador preenche: KM=21030, custo=R$ 60, oficina="Oficina Central", fotos
  Salvar

[Server Action]
  UPDATE maintenances SET
    completed=true, actual_km=21030, completed_date=hoje, cost=60,
    workshop="Oficina Central",
    effective_executor='company', effective_customer_payer_pct=0
  INSERT maintenances (predicted_km=22030)
  UPDATE motorcycles SET km_current=21030
  audit_logs (action='maintenance.completed', meta={ override: true })

[Resultado] Sem INSERT em expenses. Snapshot fica gravado em maintenances.
```

### 8.3 Cliente registra manutenção via mobile com aprovação

```
[Cliente] abre app, aba "Manutenção"
  Vê: "Honda Biz — Troca de óleo, vencida há 50 km, você é o responsável"
[Cliente] clica "Registrar manutenção feita"
  Form:
    - Data: hoje
    - KM: 22050 (pré-preenchido com km_current; cliente confirma)
    - Oficina: "Auto Posto Shell Av. Brasil"
    - Valor: R$ 70
    - Foto odômetro: tira foto
    - NF: tira foto
  Submit

[Server Action submitMaintenanceRecord]
  isApprovalRequired(tenant, contract) = true
  INSERT maintenance_records (status='pending', ...)

[Cliente] vê: "Aguardando aprovação do operador"

[Operador] /aprovacoes vê novo card
  Confere KM (consistente com km_current), oficina, NF
  Clica "Aprovar"

[Server Action approveMaintenanceRecord — transacional]
  - UPDATE maintenance_records SET status='approved', reviewed_at, reviewed_by
  - UPDATE maintenances SET completed=true, actual_km=22050, cost=70,
      workshop="Auto Posto Shell Av. Brasil", completed_date,
      effective_executor='customer', effective_customer_payer_pct=100
  - INSERT next maintenance (predicted_km=23050)
  - UPDATE motorcycles SET km_current=22050
  - audit_logs

[Cliente] na próxima abertura do app vê: "Troca de óleo aprovada ✓"
```

### 8.4 Rejeição + correção pelo cliente

```
[Cliente] submeteu registro com KM=20000 mas km_current da moto era 21500 (regressão impossível)
[Operador] /aprovacoes vê card; KM inconsistente
  Clica "Rejeitar"
  Motivo: "KM informado (20000) menor que o último registrado (21500). Reenvie com o KM correto."

[Cliente] vê motivo no app
  Clica "Reenviar com correção"
  Form pré-preenchido; corrige KM pra 21550
  Submit

[Sistema] novo maintenance_records, mesmo maintenance_id
  - O record rejeitado permanece como histórico
  - Operador aprova o novo (fluxo idêntico ao 8.3 final)
```

---

## 9. Impacto em código existente

| Componente | Mudança |
|---|---|
| `supabase/migrations/<ts>_maintenance_plans.sql` | Migration nova: cria `maintenance_plans`, `maintenance_plan_items`, `motorcycles.maintenance_plan_id`, `maintenances.plan_item_id`. Dropa `maintenance_items` + `maintenances.standard_item_id` após verificação. |
| `supabase/migrations/<ts>_maintenance_responsibility.sql` | Migration nova: `maintenances.effective_*`, `contracts.default_maintenance_*` + `maintenance_approval_required`, cria `contract_maintenance_rules`. |
| `supabase/migrations/<ts>_maintenance_records.sql` | Migration nova: cria `maintenance_records`, bucket de storage, settings defaults. |
| `supabase/seed.sql` | Cria 1 plano demo nos tenants seed com 5 itens clonados de `SUGGESTED_PLAN_ITEMS` (só pra testes E2E). |
| `packages/core/src/data/suggested-plan-items.ts` | **Novo**: constante `SUGGESTED_PLAN_ITEMS` (deduplicada + com `category` + `is_critical` default por categoria). |
| `packages/core/src/rules/maintenance.ts` | **Refatorada**: remove `STANDARD_INTERVALS`, `getInterval`, `normalize`. `calculateMaintenanceStatus` e `calculateNextMaintenance` passam a receber intervalo + threshold como input puro. Acrescenta `resolveResponsibility`, `splitMaintenanceCost`, `isApprovalRequired`, `getWarnThreshold`, `getMaintenanceSettings`. |
| `packages/core/src/schemas/index.ts` | Schemas Zod novos: `MaintenancePlanSchema`, `MaintenancePlanItemSchema`, `MaintenanceRecordSchema`, `ContractMaintenanceRuleSchema`. Ampliações em `MaintenanceSchema` (+`plan_item_id`, `effective_*`), `ContractSchema` (+`default_*`, `maintenance_approval_required`). |
| `packages/data/src/hooks` | Hooks novos: `useMaintenancePlans`, `useMaintenancePlanItems`, `useContractMaintenanceRules`, `useMaintenanceRecords`, `usePendingApprovals`. |
| `apps/web/src/app/(dashboard)/planos-manutencao/page.tsx` | **Nova** tela. |
| `apps/web/src/app/(dashboard)/motos/page.tsx` | Wizard passo 3 refatorado. |
| `apps/web/src/app/(dashboard)/contratos/page.tsx` | Form de contrato com seção "Manutenção". |
| `apps/web/src/app/(dashboard)/contratos/[id]/manutencao/page.tsx` | **Nova** tela de regras contratuais. |
| `apps/web/src/app/(dashboard)/manutencao/page.tsx` | Modal de conclusão usa `resolveResponsibility`; remove insert em `expenses`; persiste `effective_*`. |
| `apps/web/src/app/(dashboard)/manutencao/actions.ts` | Server actions ajustadas; novas: `approveMaintenanceRecord`, `rejectMaintenanceRecord`. |
| `apps/web/src/app/(dashboard)/aprovacoes/page.tsx` | **Nova** tela. |
| `apps/web/src/components/layout/Sidebar` | Itens novos: "Planos" e "Aprovações". |
| `apps/mobile/src/app/(tabs)/manutencao.tsx` | **Nova** tela. |
| `apps/mobile/src/app/manutencao/[id]/registrar.tsx` | **Nova** tela. |
| `apps/mobile/src/app/manutencao/historico.tsx` | **Nova** tela. |

---

## 10. Migração de dados existentes

### 10.1 Itens do plano (substitui `STANDARD_INTERVALS`)

A constante `SUGGESTED_PLAN_ITEMS` em `@gomoto/core` é a fonte da sugestão — não dá pra "migrar plano automaticamente para todos os tenants" porque D2 decidiu que tenant cria. Mas para **dados de seed e testes**:

- Seed insere 1 plano por tenant seed (`gomoto-bonze-dev`, `gomoto-tenant2-dev`) com nome "Plano Padrão", `is_default=true`, e 5 itens clonados de `SUGGESTED_PLAN_ITEMS` pra cobrir os fluxos E2E.

### 10.2 Manutenções existentes

Pra cada manutenção em produção (tenants reais):

- `plan_item_id` fica `NULL` (sem plano amarrado historicamente — esperado).
- `effective_executor` e `effective_customer_payer_pct` ficam `NULL` (não havia coleta antes).

Tela `/manutencao` exibe traço "—" nessas colunas e badge discreto "Antes do registro de responsabilidade" no detalhe. Sem prejuízo operacional.

### 10.3 Motos sem plano

- `motorcycles.maintenance_plan_id` fica `NULL` nas motos existentes.
- Tela `/motos` mostra banner discreto "Atribua um plano de manutenção" em cards sem plano.
- Próxima conclusão de manutenção exige plano (modal pede pra atribuir antes de prosseguir).

### 10.4 Contratos existentes

- `default_maintenance_executor` = `NULL`.
- `default_customer_payer_pct` = `NULL`.
- `maintenance_approval_required` = `NULL` (herda default do tenant = `true`).

Tenant Owner edita contratos progressivamente. Sem prazo forçado.

### 10.5 Drop de `maintenance_items`

Pré-migration:

```sql
SELECT count(*) FROM maintenances WHERE standard_item_id IS NOT NULL;
```

Se > 0, popular `plan_item_id` correspondente antes do drop (improvável — coluna nunca foi usada na operação). Se = 0, drop direto.

---

## 11. Critérios de aceite (V1)

**Schema:**

- [ ] Migrations sobem limpo em `pnpm db:reset`.
- [ ] `maintenance_plans`, `maintenance_plan_items`, `maintenance_records`, `contract_maintenance_rules` têm RLS habilitada e filtram por `get_user_tenants()`.
- [ ] Tabela `maintenance_items` dropada; `maintenances.standard_item_id` dropada.
- [ ] Settings `maintenance.approval_required` e `maintenance.default_warn_threshold_pct` populados nos tenants seed.
- [ ] Bucket `maintenance-records` criado com RLS por tenant.

**Core:**

- [ ] `STANDARD_INTERVALS`, `getInterval`, `normalize` removidos de `@gomoto/core/rules/maintenance.ts`.
- [ ] `SUGGESTED_PLAN_ITEMS` exportado de `@gomoto/core` com `name`, `category`, `interval_km`/`interval_days`, `warn_threshold_pct`, `is_critical`, `type`.
- [ ] `calculateMaintenanceStatus` e `calculateNextMaintenance` aceitam intervalo + threshold como input; sem lookup interno.
- [ ] `resolveResponsibility`, `splitMaintenanceCost`, `isApprovalRequired`, `getWarnThreshold`, `getMaintenanceSettings` implementadas com testes Vitest cobrindo precedência, casos de borda e arredondamento.

**Planos:**

- [ ] Tenant Owner cria plano com nome + descrição.
- [ ] Adicionar item via aba "Da sugestão" pré-popula categoria + intervalo + threshold + `is_critical` da sugestão.
- [ ] Adicionar item via aba "Personalizado" exige nome + categoria + pelo menos um intervalo.
- [ ] Clonar plano cria novo plano com cópia de todos os itens (sem amarrar — itens são cópias independentes).
- [ ] Arquivar plano: motos que apontam para ele continuam funcionando; novos cadastros não podem selecioná-lo.

**Motos:**

- [ ] Wizard passo 3 lista planos do tenant; pré-seleciona default; permite "Criar plano agora" abrindo `/planos-manutencao` em modal/nova aba.
- [ ] Bootstrap cria 1 `maintenance` por item do plano; vazios = predicted_km/scheduled_date a partir de "hoje".

**Responsabilidade contratual:**

- [ ] Editar contrato permite definir executor + pagador default.
- [ ] `/contratos/[id]/manutencao` permite criar regra por categoria (não por item) e por item (escape hatch); ambas atualizam preview de "resultado efetivo".
- [ ] Regra por item tem precedência sobre regra por categoria (testes Vitest).

**Conclusão pelo operador:**

- [ ] Modal pré-calcula executor + pagador via `resolveResponsibility`.
- [ ] Operador pode sobrescrever.
- [ ] Save persiste `effective_*` em `maintenances`.
- [ ] **Nenhum `INSERT INTO expenses`** é feito (validação no test E2E que abre conexão e conta linhas antes/depois).

**Registro pelo cliente:**

- [ ] Mobile mostra manutenções com executor resolvido.
- [ ] Form de registro valida foto odômetro obrigatória.
- [ ] Submit cria `maintenance_records` com status correto conforme `isApprovalRequired`.
- [ ] Auto-aprovação aplica em `maintenances` imediatamente.

**Aprovação:**

- [ ] Tela `/aprovacoes` lista pendentes/in_review por tenant.
- [ ] Aprovar dispara transação completa (record + maintenance + próximo agendamento + km moto + audit).
- [ ] Rejeitar exige motivo ≥ 10 chars.
- [ ] Cliente reenvia com correção → novo record, mesmo `maintenance_id`; antigo permanece no histórico.

**Geral:**

- [ ] `pnpm build` verde; `pnpm test` verde (Vitest com cobertura ≥ 80% das regras puras).
- [ ] Notas Obsidian atualizadas: `Telas/Manutenção`, `Telas/Motos`, `Telas/Contratos`, `Banco de Dados`, `Fluxos de Negócio`, `Estado Atual`.
- [ ] ADR 0006 escrito formalizando o modelo (plano + responsabilidade + snapshot + tabela separada para evidência do cliente).

---

## 12. Faseamento sugerido

> ✏️ **Revisão 2026-06-19** — F3 original (responsabilidade contratual) adiada para PRD futuro. Demais fases renumeradas. Snapshot em `maintenances.effective_*` é introduzido junto com o modal de conclusão revisado.

| Fase | Escopo | Esforço |
|---|---|---|
| **F1 — Plano + core refatorado** ✅ | Migration de `maintenance_plans`/`maintenance_plan_items`, drop de `maintenance_items`. `SUGGESTED_PLAN_ITEMS` em `@gomoto/core`. `calculateMaintenanceStatus`/`calculateNextMaintenance` refatoradas. Testes Vitest. Hooks de leitura. | 2-3 dias |
| **F2 — Telas de plano + atribuição à moto** ✅ | `/planos-manutencao` CRUD + clone + autocomplete (R2: sem category/type). Wizard `/motos` passo 3 refatorado: `useMaintenancePlans` + plano default pré-selecionado, bootstrap por item gerando `maintenances` previstas, banner "X motos sem plano" + badge "Sem plano" na linha. | 2 dias |
| **F3 — Modal de conclusão + snapshot de responsabilidade** ✅ | Migration `maintenances.effective_*` + `contracts.maintenance_approval_required`. Modal de conclusão pede executor + pagador (chips livres, default "Empresa 100%"). Remove insert em `expenses`. **Sem** `resolveResponsibility`, **sem** `contract_maintenance_rules`. | 1-2 dias |
| **F4 — Mobile lista de preventivas** ✅ | Tela `(tabs)/manutencoes.tsx` no mobile consumindo `@gomoto/data`. Badge de executor mostra apenas itens já concluídos com `effective_executor='customer'`. | 2-3 dias |
| **F5 — Mobile registro pelo cliente + aprovação web** ✅ | Migration de `maintenance_records` + reuso do bucket `maintenance-files`. Modal "Registrar conclusão" no mobile (foto hodômetro obrigatória, NF opcional, ArrayBuffer no upload pra contornar blob vazio do RN). Tela `/aprovacoes` com ações inline. Aprovação espelha `maintenance_records` em `maintenances` (sem Server Action — mutations diretas via `@gomoto/data`); rejeição exige motivo. Badge de pendentes na Sidebar + realtime via `supabase_realtime` invalidando cross-tab. | 3-4 dias |

**Total V1 (F1-F5): ~10-12 dias focados.** **V1 fechada em 2026-06-20.**

**Ordem executada:**

- **F1 → F2 → F3** entregou o uso operacional novo no web (plano + snapshot de responsabilidade).
- **F4 → F5** entregou o ciclo mobile completo do cliente.

**Smoke test final (2026-06-20):** bootstrap end-to-end no DB local — plano default com 5 itens → moto criada → 5 maintenances `preventive`/`inspection` geradas. `pnpm build` verde.

**Fora do V1 (PRDs futuros):**

- **Rateio financeiro**: gera `billings` a partir do snapshot `effective_*`. Consome a view `motorcycle_financial_events` (PRD 0002) + nova regra `calculateMonthlyMaintenanceCharge`.
- **Regras avançadas**: bloqueio de locação por preventiva crítica vencida (consome `is_critical` já preparado), oficinas homologadas (workshops como entidade), múltiplos níveis de aprovação, dashboard operacional, indicadores de manutenção.
- **Ordem de Serviço**: `service_orders` + `service_order_items` + `service_order_parts` + `service_order_services`. UX herda do modal multi-item.
- **Automações**: notificações push/WhatsApp/email, cron de marcação automática de overdue, lembretes recorrentes.

---

## 13. Decisões (fechadas em 2026-06-18; D3/D4 revisadas em 2026-06-19)

| # | Decisão | Resolução |
|---|---|---|
| ✅ D1 | Escopo do plano de manutenção | **Tenant cria N planos próprios**; cada moto assignada a 1 plano. Override por moto fora do V1. |
| ✅ D2 | Tratamento de `STANDARD_INTERVALS` hardcoded | Vira constante `SUGGESTED_PLAN_ITEMS` em `@gomoto/core`, deduplicada. ~~Inclui `category`~~ — **revisado 2026-06-19:** `category` removida das sugestões e do schema (ver D3 revisado). Chips na criação do plano **copiam** itens pra `maintenance_plan_items`. Sem FK de catálogo. Sem tabela global. |
| ✏️ D3 | Responsabilidade contratual: granularidade | ~~Default por contrato + `contract_maintenance_rules` permite override por categoria/item. Precedência item > categoria > default. `resolveResponsibility()` pura.~~ **Revisado 2026-06-19 — adiado para PRD futuro.** Operador decide caso a caso ao criar/concluir manutenção. `contracts.default_maintenance_*`, `contract_maintenance_rules` e `resolveResponsibility()` saem do V1. `maintenance_plan_items.category` removida (não há mais granularidade por categoria). Snapshot em `maintenances.effective_*` permanece — preenchido manualmente no modal de conclusão. |
| ✏️ D4 | Modelagem executor × pagador + split | `executor` binário (`company`/`customer`) + `customer_payer_pct INTEGER 0-100`. Snapshot em `maintenances.effective_*` **continua valendo**. **Lançamento espelho em `expenses` removido** na conclusão (alinha com PRD 0002 D1). ~~`splitMaintenanceCost()` pura.~~ **Revisado 2026-06-19:** `splitMaintenanceCost()` adiado junto com `resolveResponsibility()` — sem pré-cálculo no V1, operador escolhe o split direto no modal. |
| ✅ D5 | Registro pelo cliente | Tabela separada `maintenance_records` com FK obrigatória pra `maintenances`. Índice parcial garante 1 `approved` por manutenção. N tentativas livres. Bucket dedicado `maintenance-records`. Aprovação transacional. |
| ✅ D6 | Aprovação: obrigatória ou opcional | Default por tenant em `settings.maintenance.approval_required` + override por contrato (`contracts.maintenance_approval_required NULL = herda`). Estado `in_review` reservado no CHECK mas opcional no V1. `getMaintenanceSettings()` agrega chaves `maintenance.*`. |
| ✅ D7 | Threshold "vencer em breve" | Default por tenant em settings (`maintenance.default_warn_threshold_pct`, default 10) + override percentual opcional por item (`maintenance_plan_items.warn_threshold_pct`). `calculateMaintenanceStatus` refatorada pra função pura. `STANDARD_INTERVALS`, `getInterval`, `normalize` morrem. |
| ✅ D8 | Bloqueio de locação por preventiva vencida | Fora do V1; apenas schema preparado: `is_critical BOOLEAN` em `maintenance_plan_items` (sugestões pré-marcam `true` em brake/tire/inspection). Lógica + UI + override em PRD futuro de "regras avançadas". |
| ✅ D9 | Ordem de Serviço | Fora do V1, sem schema preparatório. `maintenances.workshop` (texto livre) cobre uso atual. PRD futuro próprio com `service_orders` + items + peças + serviços. UX herda do modal multi-item já existente. |

---

## 14. Próximos passos

1. Escrever **ADR 0006 — Plano de manutenção, responsabilidade contratual e registro pelo cliente**, consolidando D1–D9.
2. Implementar **F1** (schema + core refatorado) como primeiro PR — entrega a base sem mudar nenhuma UI. Valida que `pnpm test` continua verde com as funções refatoradas.
3. Atualizar [[Roadmap]] com as 6 fases V1.
4. Pré-checagem antes da migration de drop de `maintenance_items`: confirmar `SELECT count(*) FROM maintenances WHERE standard_item_id IS NOT NULL` = 0 em todos os ambientes (local, cloud).

---

## Tags

`#prd` `#manutencao` `#mobile` `#preventiva`
