# CONFERE DOS PAVILHÕES — Fluxo de importação e conciliação de PDF (v1)

**Status:** desenho técnico para implementação e revisão; não é código executável nem migration.  
**Base:** modelo relacional v2, especificação de validação de PDF completo v1 e permissões já confirmadas.  
**Objetivo:** receber o PDF completo de uma única área, extrair e comparar sem alterar os dados ativos, permitir revisão por linha e aplicar somente decisões aprovadas em transação.

## 1. Princípios que não podem ser quebrados

1. Cada lote pertence a uma única das oito áreas.
2. O PDF deve representar a relação completa e atualizada daquela área.
3. Upload e aprovação são permissões distintas.
4. Responsável de área pode enviar PDF somente para área vinculada; Chefe e Auxiliar podem enviar para qualquer uma das oito áreas.
5. Responsável da área pode aprovar as divergências somente da própria área.
6. A permissão de envio do Administrador permanece indefinida e deve ser negada por padrão.
7. Extração e comparação ocorrem em staging; não alteram internos, localizações ou histórico operacional ativo.
8. PDF incompleto, truncado, ilegível ou parcialmente extraído não pode gerar candidatos de ausência.
9. Ausência em PDF completo é apenas candidata à exclusão. Nunca há exclusão automática.
10. Homônimos e correspondências ambíguas exigem decisão humana.
11. A aplicação das decisões aprovadas é auditada e transacional.
12. O banco principal do Sistema Atendimento CPAIG não participa deste fluxo.

## 2. Atores e responsabilidades

| Ação | Responsável de área | Chefe | Auxiliar | Administrador |
|---|---|---|---|---|
| Enviar/iniciar lote | Sim, área vinculada | Sim, qualquer área | Sim, qualquer área | Não definido; negar por padrão |
| Consultar lote | Área vinculada | Oito áreas | Oito áreas | Oito áreas |
| Revisar/aprovar divergências | Sim, área vinculada | Não definido como aprovador | Não definido como aprovador | Não definido como aprovador |
| Aplicar decisões aprovadas | Sim, área vinculada, via fluxo formal | Não presumir | Não presumir | Não presumir |

A tabela não concede automaticamente permissão de aprovação a Chefe, Auxiliar ou Administrador. Qualquer ampliação depende de decisão expressa e atualização da matriz.

## 3. Máquina de estados do lote

Fluxo recomendado:

`RECEBIDA → VALIDANDO → EXTRAINDO → AGUARDANDO_CONFIRMACAO_COMPLETUDE → AGUARDANDO_REVISAO → APLICANDO → APLICADA`

Estados alternativos:
- `INCOMPLETA`: falha de completude; não gera ausência.
- `FALHA`: erro técnico; nenhum dado ativo pode ter sido aplicado.
- `CANCELADA`: cancelada antes da aplicação.
- `AGUARDANDO_REVISAO`: completude confirmada e divergências calculadas, aguardando decisões do Responsável.

Regras:
- Transições são controladas no servidor, não pelo navegador.
- Não permitir pular de `RECEBIDA` diretamente para `AGUARDANDO_REVISAO`.
- Somente um lote por área pode estar na etapa de aplicação por vez.
- Lote incompleto, cancelado ou com falha não substitui a última fotografia válida da área.
- `APLICADA` só é gravado depois do commit integral das decisões aprovadas.
- Reenvio do mesmo hash na mesma área não deve criar aplicação duplicada.

## 4. Fluxo detalhado

### Fase A — envio e criação do lote

1. Exigir sessão autenticada e senha diária vigente para a mutação.
2. Receber área selecionada e arquivo.
3. No servidor, verificar o perfil e o vínculo de área do usuário.
4. Validar que a área existe e está ativa.
5. Validar formato, assinatura real do PDF e tamanho permitido.
6. Calcular SHA-256 no servidor.
7. Detectar duplicidade do hash na mesma área.
8. Criar lote com status `RECEBIDA`, remetente, área, hash, tamanho, instante e identificador de correlação.
9. Guardar o original em armazenamento de arquivos seguro, separado do PostgreSQL; guardar no banco apenas metadados e referência opaca ao objeto.
10. Se falhar antes da criação do lote, não deixar registro parcial. Se falhar após criar lote, registrar falha controlada e manter diagnóstico sem alterar dados ativos.

O identificador do usuário sempre vem da sessão autenticada. Nunca aceitar `enviado_por`, perfil ou vínculos como autoridade vindos do cliente.

### Fase B — validação e extração para staging

1. Mover lote para `VALIDANDO`.
2. Verificar estrutura, integridade e páginas.
3. Mover para `EXTRAINDO` somente após validação básica.
4. Extrair todas as páginas e linhas para tabelas de staging.
5. Registrar página, ordem, cela, nome, data de entrada, procedência, setor de trabalho e dados brutos necessários para diagnóstico.
6. Registrar métricas por página e por lote.
7. Validar paginação impressa, se existir, e resolver falhas de extração.
8. Se qualquer página falhar, houver truncamento ou linha estruturalmente inválida sem solução, marcar `INCOMPLETA`; não calcular ausências.
9. Se as verificações técnicas passarem, apresentar resumo e alertas para confirmação explícita de que o PDF é a relação completa da área.
10. A confirmação humana não pode superar erro técnico crítico.

### Fase C — conciliação sem escrita nos cadastros ativos

Comparar staging somente com a última fotografia completa e aplicada da mesma área.

Categorias de comparação:
- `INCLUSAO`: linha sem correspondência atual confiável.
- `CORRESPONDENCIA`: linha compatível com cadastro existente.
- `ALTERACAO`: campos cadastrais diferem.
- `MUDANCA_CELA`: interno corresponde, mas a cela difere.
- `POSSIVEL_HOMONIMO`: mais de um candidato plausível.
- `POSSIVEL_AUSENCIA`: interno da fotografia anterior não aparece na relação completa atual.
- `DIVERGENCIA` / `INVALIDA`: dados insuficientes ou inconsistentes.

Regras de correspondência:
- Não usar nome como chave técnica.
- Normalização de nome (espaços, caixa, acentos e pontuação) serve apenas para localizar candidatos.
- Nome igual não prova identidade.
- Não fazer vinculação automática quando existirem homônimos, múltiplos candidatos ou conflito de dados.
- Dados manuais incompletos podem ser completados pelo PDF posterior quando a correspondência for inequívoca e confirmada.
- A comparação não altera UUID, localização nem status do interno.
- Candidato de ausência só pode existir depois de lote validado como completo.

### Fase D — revisão pelo Responsável da área

A tela de revisão deve mostrar lado a lado:
- informação extraída do PDF;
- cadastro atual;
- área/cela atual e proposta;
- categoria de divergência;
- justificativa/alertas do sistema;
- opções de decisão permitidas.

Decisões possíveis por linha:
- incluir novo interno;
- confirmar correspondência;
- atualizar campos cadastrais;
- mudar cela;
- vincular manualmente a cadastro existente;
- confirmar exclusão lógica;
- ignorar/rejeitar proposta;
- manter pendente para esclarecimento.

Regras:
- Responsável só revisa e decide lote da área vinculada.
- Decisão de exclusão exige motivo obrigatório.
- Decisão ambígua exige seleção humana explícita do cadastro correto; se não houver segurança, manter pendente.
- Cada decisão registra usuário autenticado, instante do servidor, decisão, motivo, valores anteriores/novos e referência da linha.
- Não permitir alteração silenciosa de decisão já aplicada; correção posterior segue fluxo de retificação auditada.
- Enquanto houver linhas acionáveis sem decisão, o lote não deve ser considerado totalmente revisado. O usuário pode salvar progresso e continuar depois.

### Fase E — aplicação transacional

Antes de aplicar:
1. Revalidar sessão, senha diária e autorização no servidor.
2. Confirmar que o Responsável ainda está vinculado à área.
3. Bloquear o lote para evitar aplicação concorrente.
4. Revalidar que a fotografia-base comparada ainda é a fotografia atual da área. Se outro lote já foi aplicado, bloquear e exigir nova conciliação.
5. Revalidar estado atual dos internos/localizações afetados.
6. Confirmar que todas as decisões obrigatórias estão resolvidas.

Na mesma transação PostgreSQL:
- aplicar inclusões aprovadas e criar localização inicial;
- aplicar atualizações cadastrais aprovadas;
- aplicar mudanças de cela aprovadas, encerrando localização anterior e criando nova;
- aplicar exclusões lógicas aprovadas, preservando cadastro e histórico;
- inserir evento de histórico e registro de auditoria para cada operação;
- registrar decisão aplicada por linha;
- atualizar referência da última fotografia válida da área;
- marcar lote como `APLICADA`.

Se qualquer operação obrigatória ou registro de auditoria falhar, executar rollback integral. Nunca deixar lote parcialmente aplicado com status `APLICADA`.

A aplicação deve usar `operation_id`/chave idempotente e hash de payload para impedir que repetição de requisição duplique efeitos. Repetição com mesmo identificador e mesmo payload retorna o resultado já gravado; mesmo identificador com payload diferente é rejeitado e auditado.

## 5. Contrato lógico de serviços (nomes ilustrativos)

Os nomes abaixo descrevem responsabilidades e não representam endpoints já implementados:
- `createImportBatch(userSession, areaId, pdfBytes)`
- `validateImportBatch(batchId)`
- `extractPdfToStaging(batchId)`
- `confirmCompleteness(batchId, userSession)`
- `reconcileImportBatch(batchId)`
- `saveLineDecision(batchId, lineId, decision, reason, userSession)`
- `applyApprovedImport(batchId, operationId, userSession)`
- `cancelImportBatch(batchId, reason, userSession)`

Todos os serviços mutáveis devem:
- derivar o ator da sessão no servidor;
- validar senha diária vigente;
- validar perfil e escopo da área;
- validar transição de estado;
- registrar histórico/auditoria quando aplicável;
- devolver resultado sem expor dados sensíveis ou caminhos internos de armazenamento.

## 6. Ajustes de modelo de dados a avaliar antes de migration

A estrutura atual já tem `importacoes` e `importacao_linhas`, com status e campos de decisão básicos. Não escrever migration sem primeiro aprovar o desenho final. Avaliar:

### 6.1 Registro por página
Nova tabela conceitual `importacao_paginas`:
- lote, número sequencial físico, número impresso (se houver);
- estado de extração, quantidade de linhas, hash/conteúdo diagnóstico;
- erro/alerta da página, instante de processamento.

### 6.2 Fotografia válida por área
Nova tabela conceitual `fotografias_area` ou referência equivalente:
- área;
- lote que originou a fotografia;
- instante de validação/aplicação;
- contagem de páginas, linhas, celas e internos;
- hash do conjunto extraído;
- versão do validador/extrator.

Deve existir uma única fotografia vigente por área, com histórico preservado. A troca da referência vigente ocorre na mesma transação da aplicação do lote.

### 6.3 Decisão e aplicação por linha
Avaliar colunas/tabela para separar:
- decisão tomada;
- usuário e horário da decisão;
- motivo;
- estado de aplicação;
- operação idempotente;
- dados anteriores/novos;
- referência a eventos/auditoria.

Não duplicar dados já disponíveis sem necessidade. Preferir restrições e FKs para integridade referencial.

### 6.4 Proteção contra concorrência
Avaliar:
- versão da fotografia-base no lote;
- lock por área durante aplicação;
- chave única para lote/hash por área;
- restrição para uma aplicação ativa por área;
- unicidade de decisão/aplicação por linha.

## 7. Casos de teste adicionais do fluxo

| ID | Cenário | Resultado esperado |
|---|---|---|
| IMP-F01 | Usuário tenta informar outro `enviado_por` no payload | Ignorar payload e usar ator da sessão |
| IMP-F02 | Responsável envia para área sem vínculo | Negado no backend |
| IMP-F03 | Chefe/Auxiliar envia para qualquer uma das oito áreas | Lote criado com área escolhida e ator autenticado |
| IMP-F04 | Administrador tenta enviar enquanto permissão não definida | Negado por padrão |
| IMP-F05 | Lote está em extração e usuário tenta aprovar | Negado por estado inválido |
| IMP-F06 | Lote incompleto tenta gerar ausências | Zero candidatos de ausência |
| IMP-F07 | Responsável de área tenta aprovar lote de outra área | Negado |
| IMP-F08 | Há homônimo sem decisão inequívoca | Linha permanece pendente |
| IMP-F09 | Uma decisão de exclusão sem motivo | Negada |
| IMP-F10 | Fotografia-base muda após conciliação e antes da aplicação | Bloquear aplicação e exigir nova conciliação |
| IMP-F11 | Duas aplicações concorrentes do mesmo lote | Uma aplicação; repetição idempotente |
| IMP-F12 | Mesmo operation_id com payload diferente | Rejeitar |
| IMP-F13 | Auditoria falha durante aplicação | Rollback integral |
| IMP-F14 | Erro em uma linha durante aplicação do lote | Nenhum efeito parcial; lote não fica APLICADA |
| IMP-F15 | Lote cancelado antes da aplicação | Dados ativos permanecem inalterados |
| IMP-F16 | Lote antigo tenta aplicar após lote mais recente | Bloquear por fotografia-base obsoleta |
| IMP-F17 | Responsável salva decisões parciais e sai | Progresso permanece em staging; dados ativos intactos |
| IMP-F18 | Aplicação concluída e requisição repetida | Retornar resultado idempotente, sem duplicar histórico/localização |

## 8. Observabilidade e diagnóstico

Registrar eventos operacionais sem guardar segredos:
- lote recebido, validado, extraído, incompleto, confirmado, conciliado, cancelado e aplicado;
- usuário, área, data/hora do servidor, identificador do lote/operação;
- duração e contagem por página;
- contagem de linhas por categoria;
- erro técnico sanitizado e versão do extrator;
- motivo de bloqueio/negação de autorização.

Não registrar senha, hash de senha, token, cookie, URL de conexão, conteúdo integral do PDF em logs ou dados desnecessários de internos.

## 9. Critérios de aceite antes de implementar

- Máquina de estados e transições aprovadas.
- Matriz de permissões consistente com este documento.
- Esquema de metadados por página/fotografia revisado.
- Estratégia de armazenamento e retenção de PDFs definida.
- Testes automatizados de completude, autorização, concorrência, idempotência e rollback preparados.
- Parser testado com amostras reais anonimizadas de cada um dos oito tipos de PDF.
- Nenhuma mutação nos dados ativos antes da aprovação.
- Migration validada em branch Neon temporária antes de qualquer proposta de aplicação na branch permanente.

## 10. Limites desta etapa

Este documento é especificação, não implementação. Não foram criados endpoints, parser, armazenamento de PDF, tabelas adicionais ou migrations. Não houve escrita no Neon. A branch permanente `confere-dev` e o banco do Sistema Atendimento CPAIG permanecem sem alterações.
