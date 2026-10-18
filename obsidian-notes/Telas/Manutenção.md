# 🔧 Tela: Manutenção — [[GoMoto]]

Rota: `/manutencao` | Tipo: Client Component

## Layout

- 5 KPI cards
- Filtros: abas de status + select de moto + select de tipo + busca
- Accordion por moto: pendentes visíveis + histórico colapsável

## KPI Cards

| Card | Cor |
|---|---|
| Vencidas | vermelho `#ff9c9a` |
| Próximas | laranja `#e65e24` |
| Agendadas | roxo `#a880ff` |
| Realizadas no mês | verde |
| Custo do Mês (R$) | — |

## Filtros

| Filtro | Valores |
|---|---|
| Status | all / overdue / upcoming / scheduled / completed |
| Moto | Select de placas |
| Tipo | all / preventive / corrective / inspection |
| Busca | Em `description`, `license_plate`, `model`, `make` |

## Status Dinâmico (`calcularStatus()`)

```javascript
if completed → 'completed'
if predicted_km <= km_current → 'overdue'
if km_current >= predicted_km - (10% do intervalo) → 'upcoming'
if scheduled_date < hoje → 'overdue'
if data <= 18 dias → 'upcoming'
else → 'scheduled'
```

## Agrupamento (Accordion por Moto)

Cabeçalho: ponto colorido + placa bold monospace + marca/modelo + KM atual + badges de contagem por status.

Dentro: tabela de pendentes + toggle de histórico (slice 5 quando colapsado, opacidade 70%).

## Colunas da Tabela (Pendentes)

| Coluna | Conteúdo |
|---|---|
| Item | Descrição bold + `<StatusBadge>` (preventive/corrective/inspection) |
| Previsão | KM previsto ou data agendada |
| Situação | Texto computado: "Vencida há X km" / "Faltam X km" / "Vence em X dias" |
| Status | Badge: Vencida / Próxima / Agendada / Concluída |
| Ações | Edit2, CheckCircle2 (conclusão), Trash2 |

## Formulário de Criação/Edição

| Campo | Tipo | Required | Obs |
|---|---|---|---|
| Motocicleta | select | ✓ | — |
| Tipo | select | ✓ | Seleção entre "Corretiva" e "Preventiva" (além de "Vistoria" para registros legados) |
| Descrição | text | ✓ | — |
| Data Agendada | date | — | — |
| KM no Serviço | number | — | — |
| Custo (R$) | number (step=0.01) | — | — |
| Oficina / Mecânico | text | — | — |
| Data de Conclusão | date | Condicional | Aparece apenas se `completed=true` |
| Marcar como concluída | checkbox | — | Auto-preenche `completed_date=hoje` |
| Observações | textarea (2 linhas) | — | — |

## Modal de Conclusão (2 Etapas)

### Etapa 1: Coleta Base
- KM odômetro, Data conclusão, Oficina, Observações
- **Preview de próximas manutenções:** timeline calculada dos itens que serão agendados
- **Sugestão inteligente:** banner com itens irmãos pendentes/vencidos desta moto → checkbox para incluir na mesma conclusão

### Etapa 2: Detalhamento Financeiro
Por item sendo concluído:
- Toggle de responsabilidade: `split` (50/50) / `company` / `customer`
- Custo em R$
- Fotos: botões "KM" (câmera) e "NF" (arquivo) — apenas marcam status
- Preview: "Empresa: R$X / Cliente: R$X"

Resumo consolidado + checkbox de confirmação (se há split).

## Auto-agendamento Após Conclusão

```javascript
const STANDARD_INTERVALS = {
  'Troca de óleo': { interval_km: 1000 },
  'Vistoria mensal': { interval_days: 30 },
  // ... 27 entradas
}
// próxima = actualKm + interval_km (ou hoje + interval_days)
INSERT INTO maintenances (novo agendamento)
UPDATE motorcycles SET km_current = ? WHERE id = ?
```

## Botão Extra: "Atualizar KM"

Modal específico no header: select de moto + input KM. Só atualiza `motorcycles.km_current`.

## Queries Supabase

```sql
-- Fetch principal
SELECT *, motorcycles(license_plate, model, make, km_current)
FROM maintenances ORDER BY created_at DESC

-- Motos
SELECT id, license_plate, model, make, km_current FROM motorcycles ORDER BY license_plate

-- Contrato ativo da moto (ao iniciar conclusão)
SELECT contract_type, next_billing_date, customers(name)
FROM contracts WHERE motorcycle_id = ? AND status = 'active' LIMIT 1

-- Irmãos pendentes
SELECT *, motorcycles(...)
FROM maintenances WHERE motorcycle_id = ? AND completed = false AND id != ?

-- Conclusão
UPDATE maintenances SET completed=true, completed_date=?, actual_km=?, cost=?, workshop=? WHERE id=?
INSERT INTO maintenances (...) -- novo agendamento
UPDATE motorcycles SET km_current = ? WHERE id = ?
```

## Tags
`#projeto/tela` `#gomoto/manutencao`
