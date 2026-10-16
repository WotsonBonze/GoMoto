# 🏍️ GoMoto

**ERP completo de locadora de motocicletas.** Next.js 14 + Supabase.

## 📂 Navegação deste projeto

### Base técnica
- [[Arquitetura]] — Stack, estrutura de pastas, padrões de código
- [[Banco de Dados]] — Tabelas, relações, RLS, seed data
- [[Storage Supabase]] — Buckets, paths, como fazer upload
- [[Componentes UI]] — Button, Card, Modal, Table, Badge, Input, Sidebar, Mapa
- [[Tipos TypeScript]] — Interfaces e union types (`src/types/index.ts`)
- [[Design System]] — Paleta, tipografia, espaçamento, tokens visuais
- [[Utilitários e Libs]] — utils.ts, schemas Zod, supabase client/server
- [[Guia de Desenvolvimento]] — Como adicionar tela, tabela, componente, item de nav

### Telas (campos, filtros, queries, lógica)
- [[Telas]] — Índice com link para cada tela
- [[Home]] · [[Dashboard]] · [[Login]] · [[Motos]] · [[Clientes]] · [[Contratos]] · [[Cobranças]] · [[Fila]] · [[Entradas]] · [[Despesas]] · [[Multas]] · [[Manutenção]] · [[Processos]] · [[Relatórios]] · [[Configurações]]

### Operação e negócio
- [[Fluxos de Negócio]] — Locação, manutenção, financeiro, fila, saída de cliente
- [[Roadmap]] — Próximos passos, backlog, o que está mockado
- [[Benchmark/LocaSmart Pro]] — Análise do concorrente (2026-10-10): funcionalidades, cobrança e o que trazer pro GoMoto
- [[Variáveis de Ambiente]] — `.env.local`, `.env.test`, como configurar

### Qualidade e segurança
- [[Segurança]] — CSP, middleware, rate-limiting, hardening
- [[Testes]] — Playwright E2E, specs, helpers
- [[Estado Atual]] — O que funciona, o que falta, últimos commits

## 🎯 Visão geral
Sistema monolítico full-stack para gerenciar:
- **Frota** — cadastro, manutenção preventiva (13 itens padrão), mapa Leaflet
- **Clientes** — dados cadastrais, histórico, status de pagamento
- **Contratos** — modelos `.docx` + locações vinculando cliente + moto (via Fila)
- **Financeiro** — cobranças, entradas, despesas, multas
- **Operações** — fila de espera, manutenção, processos (Q&A)
- **Dashboard** — KPIs, gráficos Recharts, alertas

## 📊 Perfil atual do negócio
- 5 motos, 4 funcionários, 1 filial
- Operador único (sem multi-tenancy)

## ⚙️ Stack resumida
- [[Next.js]] 14.2.35 + TypeScript 5 + TailwindCSS 3.4
- [[Supabase]] (PostgreSQL + Auth + Storage) — projeto `oskgooflepkkjdwxuouj`
- Leaflet 1.9, Recharts 3.8, Zod 4.3, Lucide
- Deploy: Vercel (pendente)

## 🏷️ Tags
`#projeto/ativo` `#stack/nextjs` `#stack/supabase`
