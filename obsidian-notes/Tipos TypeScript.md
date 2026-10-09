# 🏷️ Tipos TypeScript — [[GoMoto]]

Arquivo: `src/types/index.ts`. Todos os tipos globais do sistema.

## Enums / Union Types

```typescript
type MotorcycleStatus = 'available' | 'rented' | 'maintenance' | 'inactive'
type DocumentType    = 'drivers_license' | 'proof_of_residence' | 'contract' | 'identification' | 'deposit' | 'other'
type ChargeStatus    = 'pending' | 'paid' | 'overdue' | 'loss'
type ContractStatus  = 'active' | 'closed' | 'cancelled' | 'broken'
```

## Interfaces

### Document
```typescript
interface Document {
  id: string
  type: DocumentType
  name: string
  url?: string
  uploaded_at: string  // ISO 8601
}
```

### Motorcycle
```typescript
interface Motorcycle {
  id: string
  license_plate: string
  model: string
  make: string
  year: number
  color: string
  renavam: string
  chassis: string
  fuel: string
  engine_capacity: string
  previous_owner?: string
  previous_owner_cpf?: string
  purchase_date: string
  fipe_value: number
  maintenance_up_to_date: boolean
  status: MotorcycleStatus
  photo_url?: string
  km_current?: number
  observations?: string
  created_at: string
  updated_at: string
}
```

### Customer
```typescript
interface Customer {
  id: string
  name: string
  cpf: string
  rg?: string
  state?: string
  phone: string
  email?: string
  address?: string
  zip_code?: string
  emergency_contact?: string          // legado, texto livre
  emergency_contact_name?: string
  emergency_contact_phone?: string
  emergency_contact_name2?: string
  emergency_contact_phone2?: string
  emergency_contact_name3?: string
  emergency_contact_phone3?: string
  drivers_license?: string
  drivers_license_validity?: string
  drivers_license_category?: string
  birth_date?: string
  payment_status?: string
  drivers_license_photo_url?: string
  document_photo_url?: string
  observations?: string
  documents: Document[]
  in_queue: boolean
  active: boolean
  departure_date?: string
  departure_reason?: string
  rental_history?: CustomerRentalHistory[]
  created_at: string
  updated_at: string
}
```

### Contract
```typescript
interface Contract {
  id: string
  customer_id: string
  motorcycle_id: string
  start_date: string
  end_date: string
  monthly_amount: number
  status: ContractStatus
  pdf_url?: string
  observations?: string
  created_at: string
  updated_at: string
  // Joins (quando carregado com select):
  customer?: Customer
  motorcycle?: Motorcycle
}
```

### Income (Entradas)
```typescript
interface Income {
  id: string
  vehicle: string        // placa
  date: string
  lessee: string         // nome do locatário
  amount: number
  reference: string      // ex: 'Semanal', 'Mensal', 'Caução', 'Multa'
  payment_method: string
  period_from?: string
  period_to?: string
  observations?: string
  created_at: string
}
```

### Expense (Despesas)
```typescript
interface Expense {
  id: string
  description: string
  amount: number
  category: string
  date: string
  motorcycle_id?: string
  observations?: string
  invoice_url?: string
  attachment_url?: string
  created_at: string
  motorcycle?: Motorcycle  // join opcional
}
```

### Maintenance
```typescript
interface Maintenance {
  id: string
  motorcycle_id: string
  standard_item_id?: string
  type: 'preventive' | 'corrective' | 'inspection'
  description: string
  predicted_km?: number
  actual_km?: number
  scheduled_date?: string
  completed_date?: string
  cost?: number
  completed: boolean
  workshop: string          // sem default; NULL quando não informado
  odometer_photo_url?: string
  invoice_photo_url?: string
  observations?: string
  created_at: string
  updated_at: string
  motorcycle?: Motorcycle   // join opcional
}
```

### Process (Processos internos)
```typescript
interface Process {
  id: string
  question: string
  answer: string
  category: string
  order: number
  created_at: string
  updated_at: string
}
```

## Schemas Zod (`src/lib/schemas.ts`)

Espelham as interfaces com validações:

| Schema | Valida |
|---|---|
| `MotorcycleSchema` | Cadastro/edição de motos |
| `CustomerSchema` | Cadastro/edição de clientes |
| `BillingSchema` | Cobranças |
| `IncomeSchema` | Entradas |
| `ExpenseSchema` | Despesas |
| `FineSchema` | Multas |
| `MaintenanceBootstrapSchema` | Bootstrap inicial de manutenção |

## Tags
`#projeto/tipos` `#stack/typescript`
