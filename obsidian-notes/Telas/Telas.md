# 🗺️ Índice de Telas — [[GoMoto]]

Documentação detalhada de cada tela: campos, filtros, colunas, ações, queries e lógica de negócio.

## Institucional
- [[Home]] — Landing pública em `/home`, apresentação do produto, CTA Entrar/WhatsApp (mock)

## Autenticação
- [[Login]] — Formulário email/senha, rate-limit, redirecionamentos

## Dashboard e Visão Geral
- [[Dashboard]] — Server Component, 14 queries, 4 KPIs, 5 widgets, 2 gráficos Recharts
- [[Relatórios]] — Cards de relatórios planejados (todos em "Em breve")

## Gestão de Frota e Clientes
- [[Motos]] — Wizard 2 passos, bootstrap de 13 manutenções, mapa Leaflet, 7 colunas
- [[Clientes]] — Sem criação direta (vem da Fila), link WhatsApp, proteção de deleção

## Contratos e Cobranças
- [[Contratos]] — Upload de modelos .docx, variáveis de template, Storage Supabase
- [[Cobranças]] — 6 KPIs financeiros, marcar pago, contabilizar prejuízo, cálculo de inadimplência

## Financeiro
- [[Entradas]] — Accordion por referência, auto-preenchimento de locatário, lookup por contrato ativo
- [[Despesas]] — Upload de NF (aviso se ausente), accordion por categoria, custo por moto
- [[Multas]] — Quickfill CTB, auto-vinculação cliente↔moto, histórico colapsável por moto
- [[ROI do Veículo]] — Retorno do investimento (payback por dinheiro recebido), recebido/em atraso/a receber, despesas empresa×cliente, ocupação

## Operações
- [[Fila]] — Tela mais complexa: reordenação com motivo, cadastro completo, fechamento de contrato em 5 etapas
- [[Manutenção]] — Conclusão em 2 etapas, auto-agendamento, divisão de custo, STANDARD_INTERVALS

## Internos
- [[Processos]] — FAQ interno por categoria com accordion, order personalizado
- [[Configurações]] — Dados da empresa (settings key/value), troca de senha, info da conta

## Tags
`#projeto/telas` `#gomoto`
