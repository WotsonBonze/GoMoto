/**
 * Prompts de extração por tipo de documento (packages/core/src/document-extraction/registry.ts).
 * Texto final é detalhe de implementação, iterável sem mudar o contrato/schema (Spec 0012 §11.2).
 */

/**
 * A CNH tem vários números e datas parecidos (Registro × Espelho × código de
 * segurança × RENACH; nascimento × emissão × 1ª habilitação × validade). Em
 * teste com CNH digital real (2026-10-15) o prompt genérico anterior leu o
 * Nº Espelho como registro em 3/3 chamadas, a letra solta ao lado de "ACC"
 * como categoria e uma vez o Registro no lugar do CPF. Por isso cada campo é
 * ancorado no RÓTULO impresso, e os vizinhos que confundem são nomeados.
 * Formato/DV são conferidos depois, no código (postProcessCnhFields).
 */
export function buildCnhPrompt(): string {
  return `Você está analisando uma Carteira Nacional de Habilitação (CNH) brasileira — foto do cartão
físico ou PDF da CNH Digital (onde o cartão ocupa só parte da página; leia o cartão com atenção,
ignore o QR code e os textos do gov.br/Serpro ao redor).

Existem dois layouts. No modelo novo (2022+) os campos têm número antes do rótulo
(ex.: "4d CPF"); no modelo antigo os rótulos não são numerados. Cada campo abaixo indica o rótulo
nos dois modelos. LEIA O VALOR QUE ESTÁ LOGO ABAIXO/AO LADO DO RÓTULO CERTO — a CNH tem vários
números e datas parecidos, e o erro mais comum é pegar o valor do campo vizinho.

- name: rótulo "2 e 1 NOME E SOBRENOME" (novo) ou "NOME" (antigo). Nome completo, em maiúsculas
  como impresso. NUNCA use os nomes do campo "FILIAÇÃO" (são os pais) nem a linha de nome do
  código MRZ no verso (que usa "<" no lugar de espaços).

- cpf: rótulo "4d CPF" (novo) ou "CPF" (antigo). São exatamente 11 dígitos, impressos como
  000.000.000-00 — devolva só os 11 dígitos. No modelo novo o CPF fica à ESQUERDA do
  "5 Nº REGISTRO"; não troque os dois.

- rg: rótulo "4c DOC IDENTIDADE / ÓRG EMISSOR / UF" (novo) ou "DOC. IDENTIDADE / ÓRG. EMISSOR / UF"
  (antigo). O campo traz número + órgão emissor + UF juntos (ex.: "12345678 SSP SP",
  "254954811 DETRAN RJ"). Devolva SÓ o número do documento, com letras/pontuação que façam parte
  dele, sem o órgão emissor e sem a UF.

- birth_date: rótulo "3 DATA, LOCAL E UF DE NASCIMENTO" (novo) ou "DATA NASCIMENTO" (antigo).
  Impressa como DD/MM/AAAA (no modelo novo seguida da cidade e UF) — devolva em AAAA-MM-DD.

- drivers_license: rótulo "5 Nº REGISTRO" (novo) ou "Nº REGISTRO" (antigo). São EXATAMENTE 11
  dígitos (pode começar com zero — mantenha os zeros à esquerda). No modelo novo costuma estar
  impresso em vermelho. NÃO confunda com:
    • o número impresso na VERTICAL na lateral do cartão (Nº do espelho, 9–10 dígitos);
    • o número do RENACH (começa com sigla de UF, ex.: "SP123456789");
    • o código numérico de segurança do verso, perto de "ASSINADO DIGITALMENTE";
    • o CPF.
  Na CNH nova, os 9 primeiros dígitos do registro também aparecem na 1ª linha do código MRZ do
  verso, logo depois de "I<BRA" — use isso só para conferir a leitura.

- drivers_license_category: rótulo "9 CAT HAB" (novo) ou "CAT. HAB." (antigo). Valores possíveis:
  ACC, A, B, C, D, E, AB, AC, AD, AE. Devolva exatamente um desses, sem espaços.
  NÃO use: a letra grande e solta impressa ao lado da caixa "ACC"; a tabela de categorias do
  verso (linhas ACC, A, A1, B, B1, C, C1, D, D1, BE, CE, C1E, DE, D1E com datas — é só a
  equivalência internacional). Só devolva "ACC" se o campo de categoria estiver vazio e a caixa
  "ACC" estiver preenchida.

- drivers_license_validity: rótulo "4b VALIDADE" (novo) ou "VALIDADE" (antigo). Impressa como
  DD/MM/AAAA, costuma estar em vermelho — devolva em AAAA-MM-DD. NÃO confunda com
  "4a DATA EMISSÃO"/"DATA EMISSÃO" nem com "1ª HABILITAÇÃO".

Para cada campo, informe também o nível de confiança ("high" ou "low"). Use "low" quando o texto
estiver borrado, cortado, com reflexo ou ambíguo, quando a quantidade de dígitos não bater com a
indicada acima, ou quando você não tiver certeza de qual rótulo o valor pertence. Se o campo não
aparecer no documento ou não puder ser lido, retorne "value": null.
Não invente valores e não complete dígitos que não consegue ler.`
}

export function buildFineNoticePrompt(): string {
  return `Você está analisando uma Notificação de Autuação (NA) de trânsito brasileira, em PDF —
o documento com o título "NOTIFICAÇÃO DE AUTUAÇÃO" (não a Notificação de Penalidade, que é um
documento posterior e diferente). Extraia os seguintes campos exatamente como aparecem no
documento:
- license_plate: placa do veículo autuado
- description: descrição da infração cometida
- infraction_date: data em que a infração ocorreu, no formato ISO YYYY-MM-DD
- amount: valor da multa em reais, como número (ex.: 293.47)
- ait_number: número do Auto de Infração de Trânsito (AIT)
- infraction_location: local onde a infração ocorreu (endereço/via)
- renainf_number: número RENAINF (Registro Nacional de Infrações de Trânsito)
- notification_date: data da notificação da autuação, no formato ISO YYYY-MM-DD
- prior_defense_deadline: data limite para interposição de defesa prévia, no formato ISO YYYY-MM-DD
- driver_identification_deadline: data limite para identificação do condutor infrator, no formato ISO YYYY-MM-DD
- senatran_infraction_code: código oficial da infração (campo "código da infração", numérico,
  ex.: "7455" — não confundir com o artigo do CTB)
- senatran_infraction_subcode: campo "desdobramento" — número curto que acompanha o código da infração (ex.: "0", "8", "2")
- issuing_agency_name: nome do órgão autuador por extenso (ex.: "PREF. DE RJ RIO DE JANEIRO")
- issuing_agency_code: código numérico do órgão autuador (campo "código do órgão autuador")
- competent_agency_code: código numérico do órgão competente (campo "código do órgão competente" — pode ser igual ao do órgão autuador)
- competent_agency_name: nome do órgão competente por extenso
- driver_name: nome do condutor, se já identificado no documento (ignore se o campo disser "Não disponível")
- driver_cnh: número da CNH do condutor, se já identificado (ignore se "Não disponível")
- driver_cpf: CPF do condutor, se já identificado (ignore se "Não disponível" ou mascarado)
- driver_document: outro documento do condutor além da CNH, campo "DOC" (ignore se "Não disponível")
- infraction_time: hora em que a infração ocorreu, no formato HH:MM (campo "HORA", ao lado da data da infração)
- measurement_instrument_id: número do equipamento ou instrumento de aferição (radar), quando houver
- traffic_agent_id: identificação/matrícula do agente ou autoridade de trânsito
- measured_speed: velocidade medida em km/h, como número, quando a infração for de excesso de velocidade (campo "medição realizada")
- considered_speed: velocidade considerada em km/h, como número, já com a margem de tolerância aplicada (campo "valor considerado")
- speed_limit: limite de velocidade da via em km/h, como número (campo "limite regulamentado")
- original_renainf_number: número RENAINF da multa original, quando esta notificação for uma reemissão (ignore se "Não se aplica")
- infraction_municipality_code: código do município onde ocorreu a infração
- infraction_municipality_name: nome do município onde ocorreu a infração
- infraction_state: UF (sigla de 2 letras) onde ocorreu a infração
- senatran_message: texto do campo "MENSAGEM SENATRAN", quando não estiver vazio

Para cada campo, informe também o nível de confiança ("high" ou "low") — use "low" quando o
texto estiver borrado, cortado, ambíguo ou você não tiver certeza da leitura. Se o campo não
aparecer no documento, estiver marcado como "Não disponível" ou não puder ser lido, retorne
"value": null. Não invente valores. Não copie texto de outra parte do documento que não
corresponda ao campo.`
}
