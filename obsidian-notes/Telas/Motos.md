# 🏍️ Tela: Motos — [[GoMoto]]

Rota: `/motos` | Tipo: Client Component (`'use client'`)

## Layout

- **Mapa Leaflet** (460px altura, SSR=false, isolate z-index) — sempre visível no topo
- **Barra de filtros** abaixo do mapa: 4 pílulas de status + busca textual
- **Tabela** com 7 colunas

## Filtros

| Filtro | Valores | Campo |
|---|---|---|
| Pílulas de status | Todas / Disponíveis / Alugadas / Em Manutenção | `status` |
| Busca textual | Placa, modelo, marca ou cor (case-insensitive) | `license_plate`, `model`, `make`, `color` |

Cada pílula exibe **contador dinâmico**.

## Colunas da Tabela

| Coluna | Conteúdo |
|---|---|
| Placa | Placa + ponto colorido de status (verde/roxo/laranja/cinza) |
| Motocicleta | `{make} {model}` |
| Cliente | Nome do cliente com contrato ativo, ou "Sem locatário" em cinza |
| Valor/Semana | `monthly_amount` formatado — verde `#BAFF1A` se há contrato |
| Endereço | Endereço do cliente (truncado 180px), vazio se sem contrato |
| Status | `<StatusBadge status={...} />` |
| Ações | Eye (detalhes), Edit2 (editar), Trash2 (excluir) |

Clicar na linha → seleciona/centraliza moto no mapa.

## Formulário — `/veiculos/novo` e `/veiculos/[id]/editar` (2026-10-13)

> Um só componente (`veiculos/_components/VehicleForm.tsx`) para criar e editar.
> Padrão **"Essencial + expandir"**: o cadastro pede só o que o veículo precisa
> para entrar na frota; o resto fica em seções recolhidas, abertas sob demanda,
> e pode ser completado depois na edição. Escolhido entre 3 propostas
> (essencial + expandir, cadastro rápido em modal + checklist, assistente em
> etapas) num protótipo clicável. Antes eram 8 seções e ~45 campos à vista, com 4 obrigatórios.

### Card "Essencial" (sempre visível)

| Campo | Coluna | Obrigatório | Obs |
|---|---|---|---|
| Placa | `license_plate` | ✓ | máscara Mercosul, única por tenant |
| Tipo do veículo | `vehicle_type` | ✓ | Moto (`motorcycle`) / Carro (`car`); sem default na criação; o CRLV preenche via `vehicleTypeFromCrlv` |
| Marca | `make` | ✓ | `.toUpperCase()` |
| Modelo | `model` | ✓ | — |
| Ano fabricação | `year_manufacture` | ✓ | 4 dígitos |
| Ano modelo | `year_model` | ✓ | 4 dígitos; igual à fabricação ou o seguinte (`isVehicleModelYearCoherent`) |
| Cor | `color` | ✓ | `.toUpperCase()` |
| KM de entrada | `km_entry` | — | recomendado, base do plano de manutenção. **Gravado uma vez só**: na criação ou, se ficou em branco, na edição (o campo aparece enquanto está vazio). Ao ser gravado, `km_current` sobe para ele |

Moto sem placa (0 km antes do emplacamento) **não** é cadastrável por enquanto.

### Seções recolhidas ("Mais informações", todas opcionais)

| Seção | Conteúdo |
|---|---|
| Identificação complementar | RENAVAM, chassi, combustível, cilindrada, observações |
| Documentação (CRV) | proprietário, CPF/CNPJ, UF, nº do CRV, ano-exercício, transferência, anexo (criação) |
| IPVA e licenciamento | valor, vencimento e situação de IPVA, licenciamento e DPVAT (DPVAT nasce "Isento") |
| Aquisição | tipo, data, valor pago, FIPE, vendedor |
| Rastreador GPS | **escondido** (`VEHICLE_TRACKER_ENABLED = false` em `lib/vehicles/features.ts`) até existir a integração; também some do detalhe. Dados já gravados são preservados na edição |
| Seguro | valor mensal e vencimento (obrigatórios se ligado) |
| Fotos | 6 slots |
| Plano de manutenção | plano + "última vez feito" por item (bootstrap) |

- **Status:** não faz parte do formulário. O veículo nasce Disponível (DEFAULT da coluna) e o status muda pelas ações da tela de detalhe (`VehicleStatusActions`). A edição não envia `status`.
- **Importação do CRLV:** abre as seções que receberam dados (selo "Do CRLV") e destaca em azul cada campo preenchido. O destaque some quando o operador edita o campo. O tipo (Moto/Carro) também vem do CRLV.
- **Criação:** tudo recolhido. **Edição:** abrem expandidas as seções que já têm dado.
- Selo "Preenchido" na linha da seção recolhida que tem dado.
- RENAVAM e chassi vazios são gravados como `NULL`, não `''`, porque têm índice único por tenant.
- Placa/RENAVAM/chassi duplicados voltam da action com `field` (`uniqueViolation` em `actions.ts`).

### Validação e envio

- `VehicleSchema` (`@gomoto/core`) roda no cliente antes de chamar a action. Todos os campos com problema são marcados de uma vez, e **um erro dentro de seção recolhida abre a seção**.
- A action revalida com o mesmo schema; `updateVehicle` usa `.partial()` e por isso checa a coerência dos anos à parte.
- Rodapé fixo com contador "x/7 obrigatórios preenchidos", Cancelar e Cadastrar/Salvar.
- KM de entrada write-once (2026-10-13): `resolveKmEntryUpdate`/`canEditKmEntry` em `@gomoto/core`, e o trigger `vehicles_km_entry_guard` no banco recusa trocar ou apagar um valor já gravado. O mesmo trigger iguala `km_current` ao KM de entrada no primeiro preenchimento (nunca diminui). Antes, o cadastro deixava `km_current = 0`, e a primeira locação começava em 0 km.
- Veículo legado sem ano ou cor válido precisa ter esses campos preenchidos na próxima edição. No banco local não havia nenhum.

## Queries Supabase

```sql
-- Fetch inicial (paralelo)
SELECT * FROM motorcycles ORDER BY created_at DESC
SELECT *, customer:customers(*) FROM contracts WHERE status = 'active'

-- Criar moto
INSERT INTO motorcycles (..., km_current) RETURNING id

-- Bootstrap (logo após criar)
INSERT INTO maintenances (...) -- múltiplos registros

-- Editar
UPDATE motorcycles SET (...) WHERE id = ?  -- sem km_current

-- Deletar
DELETE FROM motorcycles WHERE id = ?
```

## Estados

| Estado | Renderização |
|---|---|
| loading | Spinner + "Carregando frota..." |
| fetchError | Banner vermelho `bg-[#7c1c1c]` + botão "Tentar novamente" |
| Vazio | Ícone Bike + "Nenhum veículo encontrado." + "Limpar filtros" |
| saving | `Button loading={true}` no modal |

## Lógica Especial

- **`contractByMotoId`** (useMemo): Map `motorcycle_id → contrato+cliente`, O(1) lookup na tabela
- **`filteredMotorcycles`** (useMemo): cascata status → busca; recalcula só quando dados/filtros mudam
- **`visibleMotoIds`**: apenas motos da lista filtrada aparecem no mapa
- **Cores do ponto de status:** available `#28b438` · rented `#a880ff` · maintenance `#e65e24` · inactive `#474747`

## Histórico de Vistorias (Spec 0009, 2026-07-30)

Esta nota cobre só a lista (`/motos`); a tela de **detalhe** (`apps/web/src/app/(dashboard)/veiculos/[id]/page.tsx`, sem nota própria ainda) ganhou uma seção "Histórico de Vistorias" — agrega `inspections` de todas as locações do veículo (`rental:rentals!inner(vehicle_id)`, RF-023/RN-012), com link para `/vistorias/execute/[id]`.

## Tags
`#projeto/tela` `#gomoto/motos`
