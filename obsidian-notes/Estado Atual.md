# 📊 Estado Atual — [[GoMoto]]

Snapshot em **2026-06-25**.

## ✅ Funcionando end-to-end

- Autenticação (login/logout via Supabase, cookie httpOnly)
- Dashboard com KPIs e gráficos Recharts
- CRUD completo de motos (com mapa Leaflet) — primeira tela migrada para `@gomoto/data`
- CRUD completo de clientes (com filtros, WhatsApp)
- **Locações (Spec 0004 — backend completo)** — tabela `rentals` (ex-`contracts`), 4 migrations (schema base, extensions de `billings`, RPCs atômicos `create_rental_with_charges` / `terminate_rental` / `renew_rental`, coluna `rent_to_own`). Server Actions com 8 operações: criar, encerrar, renovar, baixar pagamento, aplicar desconto, cobrança avulsa, fila, upload de documentos. Regras em `@gomoto/core/rules/rentals.ts`. **Tela `/locacoes` é placeholder** — UI completa pendente.
- CRUD de cobranças (com cálculo de atraso; `original_amount` + `discount_amount` + `calculateFinalAmount`; status `prejudice` substitui `loss`)
- CRUD de entradas, despesas, multas
- Fila de espera integrada ao módulo de locações (inserção via `addToQueue` server action)
- Manutenção (bootstrap a partir do plano atribuído à moto + registro manual + conclusão multi-item via operador no web, com snapshot `effective_executor` / `effective_customer_payer_pct`)
- **Planos de manutenção** — `/planos-manutencao` com CRUD de planos e itens, autocomplete via `SUGGESTED_PLAN_ITEMS`, clone, arquivar, set default. Wizard `/motos` passo 3 atribui plano à moto e materializa `maintenances` previstas por item.
- **Manutenção pelo cliente (mobile + web)** — cliente registra conclusão no Expo Go (KM, oficina, custo, fotos), operador revisa em `/aprovacoes` (aprova preenchendo executor/% pagador ou rejeita com motivo). Badge na sidebar conta pendentes; realtime cross-tab invalida cache automaticamente.
- **Módulo de Vistoria (Spec 0009)** — `/vistorias/perfis` CRUD de Perfil de Vistoria (checklist + itens de imagem); `/vistorias` lista central de pendências (check-in/check-out + análise de periódica); `/vistorias/execute/[id]` execução/análise (mesmo componente reusado na tela da locação, RF-018); vínculos de perfil (check-in/check-out + periódica/frequência) na criação da locação; comparação lado a lado check-in×check-out e histórico agregado na tela do veículo. Vistoria periódica é a primeira escrita do cliente no sistema — app mobile (aba "Vistorias") envia via Route Handler `/api/inspections/schedules/[id]/submit` (Bearer token + service role, ADR 0016), nunca via Server Action. Agendamento upfront via RPC `create_rental_with_charges` estendido; status "atrasada" derivado na leitura (sem cron). Código morto (`checklists`) removido; itens de manutenção "Vistoria..." renomeados para "Revisão..." (colisão de nome resolvida).
- Processos (Q&A interno com ordenação)
- Configurações da empresa
- **Audit logs populados em todas as 7 telas de dashboard** (Fase 5 — gap fechado em 2026-06-12)
- **Pagamento online por gateway (ADRs 0030/0031/0032)** — o tenant conecta quantos quiser e elege UM para cobrar. Três provedores em produção: **Mercado Pago** e **Cora** (OAuth2, geram Pix) e **InfinitePay** (InfiniteTag digitada, gera link de checkout com Pix e cartão). Ciclo completo validado ao vivo nos três: código gerado, pago, webhook confirmou, cobrança fechada e razão balanceado. Escrita da conta por RPC `SECURITY DEFINER`, credencial no Vault, confirmação por RPC transacional sobre o padrão inbox
- **Multi-tenancy:** `tenant_id` injetado server-side em todas as escritas

Ver [[Telas]] para documentação detalhada de cada rota.

## 🏛 Padrão arquitetural atual

Padrão canônico consolidado nas 7 telas em `apps/web/src/app/(dashboard)/*`:

- **Leituras** via hooks de `@gomoto/data` (`useContracts`, `useMaintenances`, etc.) consumidos com `useSupabaseContext()`.
- **Escritas** via Server Actions co-localizadas em `./actions.ts`, com `logAction()` por mutação e `getCurrentTenantId(supabase)` server-side.
- **Storage uploads** seguem no client; a URL gerada é patchada via Server Action.

Detalhes e tradeoffs registrados em [[decisions/0002-padrao-canonico-pagina-server-actions|ADR 0002]].

## ⚠️ Mockado / incompleto

| Item | Situação |
|---|---|
| PDF de contratos | Botão "PDF" gera via docx-preview + print dialog (commit `683a233`) |
| Geolocalização de motos | Lat/lng simulados no mapa; GPS real comentado como "futuro" |
| Emails transacionais | Settings preparado, mas não envia |
| Notificações ao usuário | Não implementado. **Webhooks de gateway existem e rodam em produção** — três Edge Functions (`mercadopago-webhook`, `cora-webhook`, `infinitepay-webhook`) sobre `_shared/inbox.ts` |
| App mobile | Login CPF + listagem de manutenções + registro de conclusão + **BillingsScreen** (cobranças do cliente, filtros, modal de detalhe). Outras telas pendentes |
| `packages/data` cobre só leituras | Mutações vivem em `actions.ts` por tela (decisão registrada na ADR 0002) |

## 🐛 Bugs conhecidos

Nenhum bug crítico aberto.

## 🔒 Invariantes de dinheiro no banco, não no código

Quando dinheiro se move, quem decide é o banco. O padrão ler-decidir-escrever em
passos soltos apareceu em três caminhos diferentes e produziu o mesmo tipo de
estrago em todos — o guarda lê um estado que a escrita seguinte ainda não gravou,
e uma segunda execução passa direto por ele:

| Função | O que era | O que quebrava |
|---|---|---|
| `fn_reverse_payment` | marcar, estornar razão, reabrir cobrança | falha no meio: pagamento estornado com o dinheiro de pé no razão |
| `fn_confirm_gateway_payment` | 4 requisições ao PostgREST | reentrega do provedor criava um SEGUNDO recebimento do mesmo dinheiro |
| `fn_pay_payable` | ler status, marcar pago, lançar | dois cliques simultâneos tiraram **R$ 600** do caixa para uma despesa de R$ 300 |

As três viraram função com a verificação sob `FOR UPDATE` dentro da mesma
transação que lança. Regra para caminho novo que mexe em dinheiro: **se o guarda
e a escrita não estão na mesma transação, o guarda não existe.**

Complemento no schema: `payments_one_per_intent` (índice único parcial) torna
impossível dois pagamentos para o mesmo intent de gateway, inclusive para quem
inserir por fora do código.

## ⏱ Encargo por atraso: grandeza corrente, não dívida nova

[[decisions/0028-encargo-e-grandeza-corrente-nao-divida-nova|ADR 0028]]
(2026-09-01). Encargo realizado vira item da cobrança e passa a compor
`open_amount`. A apuração seguinte usava esse saldo cru como base — e cobrava
multa de novo, com juros sobre o encargo anterior.

A regra hoje: apura-se o encargo **corrente** sobre o principal (saldo menos o
encargo ainda não pago) e **desconta-se o que já foi documentado**. A subtração
faz a multa ser uma vez só sem guardar estado, e `min_amount` passa a valer para
o encargo inteiro em vez de por realização.

Três portas levavam ao mesmo estado — estorno de pagamento, pagamento parcial e
o antigo botão "Consolidar encargo". A correção fica na conta, não no gatilho:
`charge_balances.late_charge_amount` alimenta `calculateAmountDue`, a fonte única
do cockpit, do mobile e do gateway. Portão em `estorno-pagamento.spec.ts`,
verificado nos dois sentidos.

`calculateAmountDue` **lança** se `open_amount`, `paid_amount` ou
`late_charge_amount` faltarem no `select` — coluna ausente virava `NaN`, que
atravessava a conta inteira sem reclamar.

## 🧹 Cancelar desfaz o que o lançamento criou

[[decisions/0029-cancelar-manutencao-desfaz-o-que-ela-criou|ADR 0029]]
(2026-09-03). Manutenção lançada por engano ficava presa: o payable do cliente
executor nasce `paid`, `cancelPayable` recusava payable pago, e a checagem de
exclusão só liberava com ele `cancelled`. A recusa mandava "acerte em Cobranças
antes de excluir" — e "antes" nunca chegava.

Hoje `fn_cancel_payable` desfaz despesa, cobrança de repasse e crédito **numa
transação**, sob trava do payable e do cliente. Toda conta tocada volta a zero:
custo e recuperação saem do DRE, o caixa volta, o saldo de crédito cai pelo
valor concedido e o payable sai de contas a pagar.

Duas recusas, ambas quando dinheiro de **terceiro** se moveu: cobrança de
repasse já paga (estorne o pagamento antes) e crédito que o saldo do cliente já
não cobre. Baixa de despesa é estornada junto — caixa próprio, e o estorno só
reconhece que a saída não devia ter sido lançada; era o único lançamento de
dinheiro sem reversão no sistema.

**O crédito é um POOL**, não uma linha rastreável: não há como saber se *aquele*
crédito foi gasto. O critério é o saldo cobrir a concessão — assim a empresa
retira o que concedeu sem deixar o cliente a descoberto.

## 💸 Crédito do cliente: as duas formas de quitar

Crédito é passivo — dívida da empresa com o cliente, nascida quando ele
desembolsou por algo que cabia à locadora. Há duas formas de quitá-lo, e elas
produzem **exatamente o mesmo resultado contábil**:

| | Abater | Devolver |
|---|---|---|
| Evento | `credit_applied` | `credit_settled` |
| Contrapartida | `contas_a_receber` | `caixa_e_bancos` |
| Quando serve | há cobrança futura | contrato encerrando, ou o cliente pede |

Rastreadas até o fim, receita, custo da empresa e custo do cliente batem nas
duas. O que muda é só o caminho do dinheiro: abater impede a entrada, devolver
deixa entrar e sair.

**O que NÃO serve é estorno.** Estorno desfaz o que não deveria ter acontecido;
o crédito aconteceu e era devido. Inverter `credit_granted` apagaria também a
despesa do serviço e a recuperação da parte do cliente — a moto passaria a
constar com custo zero.

Crédito e caução são estruturalmente a mesma coisa (dinheiro de terceiro que a
empresa devolve), e a caução já tinha as três peças. O crédito só ganhou as
outras duas agora: `fn_settle_customer_credit` (com o saldo verificado sob trava
do CLIENTE, porque saldo derivado não tem linha para travar) e a apuração no
encerramento.

## 🧱 Dívida técnica registrada

**Miudezas de portão e ambiente** (2026-09-06, achadas durante a ADR 0032)

Nenhuma vale um ADR, mas todas custam tempo de quem tropeça:

- **`apps/web/tsconfig.json` tem `exclude: ['tests']`** — as specs E2E **nunca passam pelo typecheck**. Um campo novo obrigatório num descritor diverge em silêncio entre teste e produção, e só aparece quando a suíte roda.
- **`api-payment-intent.spec.ts` insere `is_default: true` direto**, em vez de passar por `fn_set_default_provider_account`. Qualquer dev que conecte um gateway de verdade no banco local quebra a suíte com `duplicate key ... idx_provider_accounts_one_default`.
- **`MERCADOPAGO_CLIENT_SECRET` está Non-sensitive na Vercel** — decisão consciente enquanto se testa, precisa virar Sensitive antes de usuários reais. (`INFINITEPAY_WEBHOOK_URL` já nasceu Sensitive, porque embute o segredo do webhook no path.)
- **Cora, homologação:** o `client_secret` passou pelo transcript de uma conversa e precisa ser rotacionado; e falta pedir a liberação de `http://localhost:3000/*` como `redirect_uri` (produção já funciona).

**Auditabilidade e privilégio no caminho do dinheiro — [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]]** (2026-09-06)

🔴 **CORREÇÃO CRÍTICA AGUARDANDO DEPLOY.** Enquanto as migrations não subirem
para a cloud, produção segue exposta.

Com a **chave anônima** — a que viaja no bundle do navegador de toda página
publicada — e mais nada, era possível lançar no razão de **qualquer empresa**:

```
POST /rest/v1/rpc/post_financial_transaction  → HTTP 200
```

Reproduzido ao vivo e corrigido em duas camadas. A causa é um
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ... TO anon` de 2026-06-27: **toda
tabela e toda função criada depois nasce concedida a `anon`**. Medido antes da
correção: 67 das 71 rotinas de `public` executáveis por `anon`, 37 delas
`SECURITY DEFINER`. As outras funções de dinheiro escaparam por acidente — elas
consultam `get_user_tenants()`, que para `anon` é vazio;
`post_financial_transaction` recebia o tenant por parâmetro e não perguntava
nada.

Implementado (Fases 1, 2 e 2b): o elo `gateway_events → payments → razão` virou
FK; `received_by_system` (`gateway:<provedor>`) distingue máquina de pessoa;
"aceito sem verificar" (ADR 0033) ganhou coluna própria; o `tenant_id` do
evento é carimbado ANTES do trabalho arriscado, então a fila de replay deixa de
ser invisível para quem agiria. Fechados: credencial de gateway fora do alcance
de `authenticated`, `payment_intents` só escrevível por RPC, `INSERT` direto no
razão revogado, e `reversed_at` só aceito depois de o estorno existir no razão.

**Segundo achado crítico, na verificação do primeiro (Fase 2c):** as três
funções de administração da plataforma guardavam com
`IF get_platform_role() <> 'owner'`. Para quem não é admin isso é
`NULL <> 'owner'` = **NULL**, e `IF NULL THEN` não executa — a guarda era pulada
exatamente para quem ela existe para barrar. Reproduzido: um `operator` comum de
tenant promoveu uma segunda conta a `platform_admin` **owner**, que enxerga todos
os tenants. Corrigido com `IS DISTINCT FROM` (NULL-safe, já usado no resto do
schema) + `SET search_path`.

Na mesma varredura: existiam **dois** caminhos concedendo ao `anon` — o
`ALTER DEFAULT PRIVILEGES` e o default do próprio PostgreSQL, que concede
`EXECUTE` a `PUBLIC` em todo `CREATE FUNCTION`. A Fase 2b fechou só o primeiro.
Agora `anon` está fora do schema `public` inteiro, e a migration **se
autoverifica**: falha se sobrar rotina alcançável por anon ou se `authenticated`
perder acesso.

Verificado em banco limpo: suíte E2E **257 passando, 0 falhas**.

**Fase 3 entregue (visibilidade):** views `gateway_event_audit` e
`financial_reconciliation`, e a tela **Configurações → Integrações →
Diagnóstico** (Owner/Admin). A reconciliação — "existe documento que não virou
lançamento?" — deixa de existir só como teste de CI e passa a ser respondível
sobre os dados reais.

**Fase 3b: o dreno da fila (fecha a Questão 2 da ADR 0033).**
`idx_gateway_events_unprocessed` sempre foi chamado de fila de replay e nunca
teve consumidor — como respondemos 200 antes de processar, o provedor nunca
reenvia. Agora tem: os processadores saíram dos webhooks para
`_shared/{cora,mercadopago,infinitepay}.ts`, e a Edge Function `gateway-replay`
chama **a mesma função** que a entrega original. Isso é possível porque cada
processador lê só do payload GRAVADO — o replay não pode divergir do webhook
porque não é outro código.

Achado ao testar: `markFailed` gravava `attempts: 1` fixo. Com uma entrega só
ninguém notava; com o dreno, reprocessar dez vezes deixava o contador em 1.
Agora conta.

⚠️ A suíte **não executa** funções Deno. O refactor foi verificado à mão com
`supabase functions serve` + mock da API da Cora servido como função na mesma
rede: ciclo com dinheiro fechou (evento parado → confirmado, R$ 250,00, razão
somando zero). **Os quatro webhooks precisam de deploy.**

**Fase 4 — vigilância ativa.** `GET /api/cron/drain-gateway-events`, cron da
Vercel **diário** (`0 10 * * *` = 07:00 BRT — o Hobby não aceita mais frequente),
drena a fila sozinha: `attempts < 5`, evento com mais de 2 minutos (o webhook
ainda pode estar processando em `waitUntil`), lote de 50.

Com cadência diária o **botão "Reprocessar" da tela é o caminho normal** para
urgência; o cron é a rede que pega o que ninguém viu.
Ficou na aplicação e não no `pg_cron` porque é orquestração HTTP, não SQL — e
assim nenhum segredo novo entra no banco; usa o `CRON_SECRET` que a emissão
manual já usa.

Alerta vai para o log estruturado: `drain.needs_human` (esgotou as tentativas),
`drain.accepted_unverified` (ADR 0033, últimas 24h) e `drain.reconciliation`.
Não foi criado canal de notificação — seria infraestrutura nova, e escolher
destinatário no lugar do humano seria decidir por ele.

⚠️ **Defeito achado ao testar, que valeu a Fase inteira:** faltava
`cache: 'no-store'` na chamada à Edge Function. A rota relatava
`ainda_falhando: 2` **sem ter chamado a função uma vez** — o Next servia a
resposta anterior do cache. A drenagem se declarava saudável sem fazer nada, e
o botão da tela tinha o mesmo defeito num segundo clique.

`CRON_SECRET` **criado em produção** (Sensitive) — não existia, o que significa
que o disparo manual da emissão de cobranças (`/api/cron/issue-charges`) também
estava morto lá, respondendo 500. A Vercel injeta o valor no header
`Authorization` do cron automaticamente.

**Fase 5 — a trilha do tenant passa a ver dinheiro. ADR 0034 CONCLUÍDA.**
`payment_confirmed` e `token_refreshed` estavam no vocabulário de
`lib/audit.ts` desde sempre **sem um único escritor** — a causa era estrutural,
não descuido: a confirmação roda em Deno com `service_role` e `logAction` vive
em `apps/web`.

A trilha do dinheiro passou a ser escrita pelo BANCO, por trigger em `payments`,
na mesma transação. Alcança os três caminhos (webhook, recebimento manual,
abatimento por crédito) sem que nenhum precise lembrar de chamar nada — e não
tem como ser perdida: se o registro falhar, o pagamento não acontece.

`audit_logs.user_id` deixou de ser NOT NULL e ganhou `actor_system`
(`gateway:<provedor>`), com CHECK de exatamente um autor. Papel de máquina não
se disfarça de pessoa. `token_refreshed` sai de `fn_store_provider_credentials`,
sem jamais registrar a credencial.

A trilha virou **imutável inclusive para `service_role`** — as policies eram
SELECT/INSERT, mas RLS é contornada por `SECURITY DEFINER`, que é justamente
como a trilha do dinheiro é escrita.

Defeito achado no caminho: **`logAction` nunca conferia o erro do INSERT**. Uma
gravação recusada pela RLS passava sem deixar nada, nem no log.

**Dinheiro para cobrança cancelada — [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]]** (2026-09-06)

🟡 **Proposta, nada implementado.** Vale para os três gateways, é anterior à
InfinitePay, e foi ela que tornou visível.

Cancelar uma cobrança **não expira o `payment_intent` pendente**, então o código
de pagamento continua vivo no provedor. Se alguém pagar,
`fn_confirm_gateway_payment` não olha o status da cobrança: credita normalmente
e, como a emissão já foi revertida no razão, **`contas_a_receber` fica
negativo** — os livros passam a dizer que a locadora deve ao cliente.

Duas metades. A mecânica (cancelar expira os intents, como
`fn_disconnect_provider_account` já faz) não tem decisão pendente. A outra é
**decisão do humano**: dinheiro que chega para cobrança cancelada vira crédito
do cliente (recomendado) ou continua recebível? Recusar viola a ADR 0024.

Cancelar no provedor — MP e Cora têm endpoint, InfinitePay **não tem** — reduz a
probabilidade, mas não elimina o caso (corrida, falha de rede, janela de status).

Registrada junto: **nada drena a fila de replay** (`gateway_events` com
`processed_at IS NULL`). Como respondemos antes de processar, o provedor não
reenvia — a fila depende de alguém olhar.

**Leitura do cliente sobre o razão — [[decisions/0027-como-o-cliente-le-saldo-derivado-do-razao|ADR 0027]]** (2026-08-31)

**Portão decidido e implementado; uma questão em aberto.** As views de saldo são
`security_invoker`: se uma tabela que elas agregam não for legível pelo cliente,
a view não erra — devolve um número menor, plausível e falso. Foi assim que uma
cobrança de R$ 102,69 com R$ 100,00 abatidos apareceu como R$ 105,45 no app
contra R$ 2,76 no cockpit.

`leitura-do-cliente.spec.ts` fecha a classe: lê **com token do cliente**, nunca
com service role, e congela o inventário das views que ainda divergem
(`customer_credit_balances`, `deposit_balances`, `customer_financial_position` —
todas sobre `financial_entries`, nenhuma consumida pelo app hoje).

Em aberto: como o cliente passa a ler crédito e caução — policy no razão
(expõe custo e estrutura do plano) ou view dedicada `security_definer` (abre
exceção ao invariante de `security_invoker`). Recomendação registrada: a segunda.
Até decidir, **o app não deve exibir crédito nem caução** — hoje mostraria zero.

**Acerto final no encerramento — [[decisions/0026-acerto-final-caucao-e-credito|ADR 0026]]** (2026-08-29)

**Aceita e implementada** (fases 1–3): como caução e crédito são resolvidos ao
encerrar a locação.

O razão já trata os dois como a mesma coisa — dois passivos com os mesmos dois
desfechos, abater a dívida (`→ contas_a_receber`) ou devolver (`→ caixa`). A
tela não: a caução tem decisão obrigatória, o crédito tem um texto e um link
para a ficha, onde só existe devolver em dinheiro. Abater crédito em lote não
existe em lugar nenhum — é uma cobrança por vez.

O sintoma é a apuração pedir *"encerrar mesmo com R$ 1.200,00 em aberto"* de um
cliente cujo dinheiro a empresa está segurando em R$ 1.000 entre caução e
crédito. O líquido real, R$ 200, não aparece.

A ADR fixa o princípio (**abater vem antes de devolver**), a decisão por quantia
e três fases — a primeira só de leitura, sem mudar nenhuma escrita. Duas regras
já decididas: **retenção de caução existe apenas contra dívida** (sem dívida,
devolve-se; para reter por avaria, lança-se a despesa com rateio, que emite a
cobrança), e **qual quantia entra no acerto é escolha do operador**, com caução
primeiro como sugestão e o efeito visível antes de confirmar. As duas quantias
têm a mesma forma de controle — *quanto abater* e *o que fazer com a sobra* —, e
sobra pode ser devolvida em dinheiro.

A primeira regra dissolve um defeito achado por leitura: reter caução de cliente
**sem dívida** credita `contas_a_receber` sem ter onde alocar, e o `unallocated`
volta ignorado pelo chamador.

**Leitura em escala — [[decisions/0025-leitura-em-escala-paginacao-agregacao-indice|ADR 0025]]** (2026-08-18)

Precisa de revisão: **performance das buscas, paginação, agregação e índices**.

Três defeitos do mesmo tipo apareceram em sequência ao testar o sistema como
operador, todos silenciosos e nenhum pego por portão:

- PostgREST corta em **1.000 linhas** sem erro — KPI que soma linhas no cliente
  passa a mostrar parte da carteira com cara de número certo;
- Kong recusa URI acima de **~8 KB** com 414 — `.in()` estoura a partir de ~200
  ids, e o erro era engolido por `?? []`;
- nenhuma listagem tem paginação de UI, e a busca por texto é feita em memória
  depois de trazer as linhas.

`financial_entries` já passou de 1.000 linhas no banco de desenvolvimento. As
views derivadas agregam sobre ela a cada consulta, sem plano medido.

Contenção já aplicada (não substitui a revisão): enriquecimento da lista de
cobranças em lotes, varreduras de reconciliação paginadas, e KPIs do dashboard
vindos de `receivables_summary` / `receivables_by_month`.

## 🧮 Regras de domínio em `@gomoto/core/rules`

Cobertura atual (**163 testes Vitest**, 12 arquivos):

- `rentals` (**novo Spec 0004**) — `calculateProRataValue`, `generateCycleCharges` (mensal e semanal), `isRentalTerminationWithinMinimum`, `calculateMinimumEndDateForRental`, `getEarlyTerminationImpact`. `RentalSchema` (Zod v4). 28 testes.
- `billings` — `isChargeOverdue`, `calculateDaysOverdue`, default rate, punctuality rate, ticket médio, `canRegisterPayment`, `canApplyDiscount`, `calculateFinalAmount`. Status `prejudice` (substituiu `loss`).
- `contracts` — vigência mínima, vigência esperada, classificação de validade (red/orange/green), `CONTRACT_TERMINATION_FINE_BRL`. (tipo histórico; tabela renomeada para `rentals`)
- `motorcycles` — `isIdleMotorcycle`.
- `customers` — `identifyCustomersWithMultipleOverdueCharges`.
- `queue` — notas auditáveis do swap (`getMoveUpNote`, `getMoveDownNote`, `getMoveDownReasonNote`, `QUEUE_REORDER_UP_NOTE`).
- `maintenance` — `STANDARD_INTERVALS`, `KM_POR_DIA`, `getInterval`, `calculateMaintenanceStatus`, `calculateNextMaintenance`.

## 🚀 Roadmap imediato (ordem sugerida)

1. **Deploy no Vercel** — primeiro deploy em produção; conectar repo + env vars no painel.
2. **GitHub Actions CI/CD** — `pnpm build` + lint + Playwright em cada PR.
3. **Resend** — emails de cobrança vencida, lembretes de manutenção.
4. **Upstash Redis** — migrar rate-limit de in-memory pra persistente.
5. **Sentry** — monitoramento de erros em produção (fechar junto com deploy real).

PRD 0003 V1 (manutenção preventiva) — ✅ fechada em 2026-06-20.
Spec 0004 (locação e cobranças) — ✅ backend + core + mobile fechados em 2026-06-25. UI `/locacoes` pendente.

## ✅ Recentemente entregue

- **Um veículo, uma locação — [[decisions/0036-um-veiculo-uma-locacao|ADR 0036]]** (2026-09-10) — O banco não impedia duas locações ativas na mesma moto: a checagem se perdeu na reescrita da Spec 0014, e a própria suíte E2E criava até seis locações ativas num veículo e passava. Agora são duas regras no banco: índice único parcial (uma `active` por veículo, para qualquer caminho de escrita) e trigger de sobreposição de período `[início, fim)`, que fecha o caminho aberto pela ADR 0035 (antecipar o início para antes da devolução da anterior). A migration falha listando as placas se já houver duplicidade. **Rodar a pré-checagem em produção antes do `db push`.**
- **Ajuste de período e condições da locação — [[decisions/0035-ajuste-de-periodo-da-locacao|ADR 0035]]** (2026-09-10) — `/locacoes/[id]/ajustar` passa a ser a dona única dos seis parâmetros do cronograma (início, fim, ciclo, dia de vencimento, valor, pro rata). Antes, `start_date`/`cycle`/`due_day`/`use_pro_rata` não tinham fluxo nenhum — a orientação era "encerre e crie outra locação" — e `end_date` tinha **dois** donos com regras divergentes (Renovar recusava encurtar, Encerrar fechava o contrato). `/reajustar` e `/renovar` viraram redirects. A decisão inteira é `planPeriodAdjustment` (`@gomoto/core`), a MESMA chamada da prévia e da gravação: a tela mostra, antes do clique, quais cobranças emitidas serão canceladas, quais parcelas do plano serão substituídas e quais nascem — marcando as que emitem imediatamente e as que nascem vencidas. `fn_adjust_rental_period` reconfere sob o lock da locação que nenhuma linha a substituir tem cobrança viva (`LINE_HAS_LIVE_CHARGE`) — entre a leitura da tela e a escrita cabem o job de emissão e um webhook. Cobrança **paga** na faixa é impedimento, não cancelamento. **Bug pré-existente achado e corrigido no caminho:** com `use_pro_rata: false`, contrato que começava no próprio dia de vencimento gerava uma cobrança de período ZERO pelo valor cheio — um mensal de 10/10 a 10/03 saía com 6 × R$ 600 em vez de 5; dois testes existentes codificavam o defeito (contavam vencimentos, não períodos) e foram corrigidos junto.
- **Multi-gateway de pagamento — ADRs [[decisions/0030-multiplos-gateways-de-pagamento|0030]], [[decisions/0031-integracao-cora-parceria|0031]] e [[decisions/0032-integracao-infinitepay-checkout|0032]]** (2026-09-04 a 09-06, branch `feat/multiplos-gateways-pagamento`) — A 0030 trocou "o código escolhe o gateway" por "a conta ELEITA diz o provedor", e no caminho corrigiu o G-01: `authenticated` não tinha INSERT/UPDATE em `payment_provider_accounts` desde a Spec 0014, ou seja, conectar gateway **nunca funcionou em runtime**. A 0031 somou a Cora (OAuth2, token de 24h com refresh rotativo, centavos, Pix só com EMV). A 0032 somou a InfinitePay, primeiro provedor sem código de pagamento — devolve URL de checkout, método `payment_link`, credencial é um handle público. Três ciclos fechados em produção com dinheiro real. Duas correções transversais no caminho: o método default passou a vir do gateway eleito (era `'pix'` cravado em dois chamadores) e o meio REAL do pagamento passou a chegar ao razão (`p_method`, que a RPC já esperava e ninguém preenchia). Aberto: [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]].
- **Spec 0004 — locação e cobranças (backend + core + mobile)** (2026-06-25) — Rename completo `contracts` → `rentals` em toda a codebase. 4 migrations: schema `rentals` com `cycle`/`cycle_amount`/`due_day`/`rental_type`/`minimum_months`; extensões em `billings` (`original_amount`, `discount_amount`, `billing_type`, status `prejudice`); 3 RPCs atômicos com `SELECT FOR UPDATE NOWAIT` (sem dupla locação para mesma moto); tabela `queue_entries`. `@gomoto/core` atualizado: `RentalSchema`, `generateCycleCharges` (pro-rata, mensal, semanal), `canRegisterPayment`, `canApplyDiscount`, `calculateFinalAmount` — 163 testes passando. `@gomoto/data`: hooks `useRentals`, `useRentalById`, `useBillingsForCustomer`. 8 Server Actions em `locacoes/actions.ts`. Mobile `BillingsScreen` com grupos por locação, filtros, modal de detalhe, pull-to-refresh, banner offline. E2E stubs em `locacoes.spec.ts` e `billings-rentals.spec.ts`. Tela web `/locacoes` é placeholder — UI completa é próximo passo.
- **PRD 0003 V1 — fechada** (2026-06-20) — F1 a F5 entregues. Smoke test end-to-end no DB local confirma o bootstrap: plano default com 5 itens → moto criada → 5 maintenances `preventive`/`inspection` materializadas. F2 (planos + wizard passo 3) já estava em código quando reabrimos a auditoria — só faltava marcar como concluída nas notas.
- **PRD 0003 F5 — manutenção mobile + aprovação web** (4 commits, 2026-06-20) — `87c84ac` cria `maintenance_records` com RLS (operador via `tenant_isolation`, cliente via `customer_self_select/insert`). `899e42a` adiciona modal de registro no mobile (KM, oficina, custo, foto de hodômetro obrigatória, foto de nota opcional) — upload via `arrayBuffer()` (`fetch().blob()` no RN gera arquivo vazio na Storage). `1764f85` adiciona rota `/aprovacoes` no web com aprovação inline preenchendo `effective_executor`/`effective_customer_payer_pct` no `maintenances` e marcando o record. `bd3b5bb` corrige warn de `MediaTypeOptions` deprecado (substituído por `mediaTypes: ['images']`). `36b4dd0` adiciona badge de pendentes na sidebar + realtime cross-tab via publication `supabase_realtime`. **F3, F4 e F5 do PRD 0003 concluídas.**
- **PRD 0003 F3/F4 — snapshot + mobile listagem** (commits anteriores) — `effective_executor`/`effective_customer_payer_pct` preenchidos na conclusão do operador (sem `INSERT INTO expenses` automático). Mobile lista preventivas com status calculado via `@gomoto/core/rules/maintenance`.
- **Bootstrap `apps/mobile`** (commit `5e036ad`, 2026-06-12) — Expo SDK 52 + Expo Router + metro.config para monorepo PNPM. Bumpado para **SDK 56** (Expo `~56.0.11`, RN `0.85.3`, React `19.2.3`, expo-router `~56.2.10`) para casar com o Expo Go publicado nas lojas — SDK 54 deu `ClassCastException` no runtime do Expo Go atual. Override `@types/react: ^18` no `pnpm-workspace.yaml` evita que tipos React 19 do mobile vazem para o web (que ainda roda React 18 via lucide-react/radix). `metro.config.js` ajustado para PNPM (sem `disableHierarchicalLookup`, com `unstable_enableSymlinks`). Validação pendente: rodar `pnpm --filter @gomoto/mobile dev` e abrir no Expo Go.
- **Geração de PDF de contratos** (commit `683a233`, 2026-06-12) — botão "PDF" lado a lado com "Gerar [template]" usa `docx-preview` + print dialog nativo. Validação visual pendente.
- **Fase 3 — extrair regime de manutenção** (commit `521b9ca`, 2026-06-12) — última concentração grande de regra inline migrada para `@gomoto/core`.

## 📈 Métricas de build

- `pnpm build` sem erros (Turbo cobre `web` + `core` + `data`).
- Dev server: `http://localhost:3000`
- Supabase local: `http://127.0.0.1:54321`
- Projeto Supabase cloud: `oskgooflepkkjdwxuouj`

## Últimos commits relevantes (2026-06-20)

| Commit | Mensagem |
|---|---|
| `36b4dd0` | feat(maintenance): F5.4 — badge de pendentes + realtime cross-tab |
| `bd3b5bb` | fix(mobile): troca MediaTypeOptions.Images por ['images'] |
| `1764f85` | feat(aprovacoes): F5.3 — rota web pra revisão de manutenção do mobile |
| `899e42a` | feat(mobile): F5.2 — registrar conclusão de manutenção |
| `87c84ac` | feat(maintenance): F5.1 — tabela maintenance_records + RLS de aprovação |
| `521b9ca` | refactor(core): extrai rules/maintenance + manutencao consome do @gomoto/core |
| `683a233` | feat(contratos): botão "PDF" gera contrato via docx-preview + print dialog |
| `4950798` | docs: fecha Fase 3 e separa "extrair manutenção" como item próprio |
| `cb74995` | refactor(core): extrai rules/queue + fila consome calculateMinimumEndDate |
| `cdd7063` | docs: ADR 0002 do padrão canônico de tela + atualiza Estado Atual |
| `9751646` | refactor(fila): migra page.tsx para hooks de leitura + Server Actions |
| `7119d7a` | refactor(manutencao): migra page.tsx para hooks de leitura + Server Actions |
| `1887cc0` | refactor(contratos): migra page.tsx para hooks de leitura + Server Actions |
| `84b2e30` | refactor(despesas): migra page.tsx para hooks de leitura + Server Actions |
| `83c1d88` | refactor(multas): migra page.tsx para hooks de leitura + Server Actions |
| `a1fa0cb` | refactor(entradas): migra page.tsx para hooks de leitura + Server Actions |
| `65b6cc0` | refactor(cobrancas): migra page.tsx para hooks de leitura + Server Actions |

## Tags
`#projeto/estado` `#projeto/ativo`
