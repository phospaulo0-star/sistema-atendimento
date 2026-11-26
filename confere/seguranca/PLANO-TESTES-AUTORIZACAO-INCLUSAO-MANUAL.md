# CONFERE DOS PAVILHÕES — Casos de teste de autorização e inclusão manual

**Status:** plano de testes funcionais e de segurança; ainda não executado contra a aplicação.  
**Branch:** `feature/confere-pavilhoes`  
**Escopo:** autorização no servidor, inclusão manual, exclusão lógica, reativação e conciliação posterior com PDF.

## 1. Objetivo

Transformar as permissões já confirmadas em cenários verificáveis antes de implementar rotas, serviços ou telas. Os testes devem provar que a autorização é aplicada no backend, independentemente do que a interface exibe.

## 2. Premissas funcionais confirmadas

- Administrador, Chefe e Auxiliar possuem acesso às oito áreas.
- Responsável de área atua somente nas áreas/celas vinculadas ao seu usuário.
- Responsável de área pode incluir manualmente um interno em cela de sua responsabilidade.
- Na inclusão manual, nome e cela são obrigatórios. Data de entrada, procedência e setor de trabalho podem permanecer pendentes até a importação do PDF seguinte.
- Responsável de área pode excluir logicamente e reativar internos somente em suas áreas vinculadas; ambas as operações exigem motivo e auditoria.
- UUID é a identidade técnica do interno; nome não é único.
- A importação posterior deve completar/atualizar o cadastro existente, sem duplicá-lo. Correspondência ambígua ou homônimo exige revisão humana.
- Responsável de área pode aprovar inclusões, alterações e exclusões propostas pelo PDF, exclusivamente na área vinculada, após revisar as divergências.
- A senha diária vigente é exigida para mutações; a sessão pode permanecer aberta após as 08h, mas a API bloqueia novas mutações até a atualização da senha.

## 3. Cenários de inclusão manual

| ID | Cenário | Resultado esperado |
|---|---|---|
| INC-01 | Responsável vinculado à Área A inclui nome em cela ativa da Área A | Permitido; cria interno e localização inicial na mesma transação |
| INC-02 | Responsável da Área A tenta incluir em cela da Área B | Negado no servidor; nenhuma gravação parcial |
| INC-03 | Responsável tenta incluir em cela inativa | Negado |
| INC-04 | Inclusão sem nome | Rejeitada por validação |
| INC-05 | Inclusão sem cela | Rejeitada; não criar interno sem localização |
| INC-06 | Inclusão com nome e cela, sem data de entrada, procedência ou setor de trabalho | Permitida; campos complementares ficam pendentes/NULL |
| INC-07 | Nome contém apenas espaços | Rejeitado após normalização/validação |
| INC-08 | Dois internos diferentes possuem o mesmo nome | Não impor unicidade por nome; exigir identificação/revisão quando houver possível correspondência |
| INC-09 | Falha ao gravar localização ou auditoria após iniciar inclusão | Rollback integral; não deixar interno órfão |
| INC-10 | Reenvio do mesmo comando offline com mesmo identificador e mesmo conteúdo | Devolver resultado original sem duplicar cadastro |
| INC-11 | Mesmo identificador de operação reutilizado com conteúdo diferente | Rejeitar e registrar conflito/auditoria |
| INC-12 | Usuário sem autenticação ou com senha diária vencida tenta incluir | Negar mutação no servidor |

## 4. Cenários de exclusão e reativação

| ID | Cenário | Resultado esperado |
|---|---|---|
| EXC-01 | Responsável exclui interno localizado em área vinculada, com motivo | Exclusão lógica permitida e auditada |
| EXC-02 | Responsável tenta excluir interno de área não vinculada | Negado |
| EXC-03 | Exclusão sem motivo | Rejeitada |
| EXC-04 | Exclusão repetida de interno já excluído | Resposta controlada/idempotente; não duplicar eventos |
| REA-01 | Responsável reativa interno de área vinculada, com motivo e cela válida | Permitido e auditado |
| REA-02 | Responsável tenta reativar interno fora de sua área | Negado |
| REA-03 | Reativação sem motivo | Rejeitada |
| REA-04 | Reativação sem localização/cela válida | Rejeitada; solicitar correção antes |
| REA-05 | Reativação de interno anteriormente excluído | Preservar evento de exclusão e todo histórico anterior |

## 5. Conciliação da inclusão manual com o PDF seguinte

| ID | Cenário | Resultado esperado |
|---|---|---|
| PDF-01 | PDF completo da mesma área contém o nome e os dados complementares do cadastro manual | Propor atualização do cadastro existente, preservando o UUID |
| PDF-02 | Correspondência é inequívoca segundo os dados disponíveis | Apresentar correspondência para revisão conforme fluxo de importação; não criar duplicata |
| PDF-03 | PDF contém homônimos ou correspondência ambígua | Marcar divergência e exigir decisão humana |
| PDF-04 | PDF pertence a outra área | Não usar essa linha para completar automaticamente o cadastro |
| PDF-05 | PDF está truncado/incompleto | Falhar validação; não propor exclusões nem aplicar atualização como fotografia completa |
| PDF-06 | Cadastro manual não aparece no PDF completo | Apresentar divergência/candidato para revisão; não excluir automaticamente |

## 6. Aprovação das divergências da importação PDF

| ID | Cenário | Resultado esperado |
|---|---|---|
| APR-01 | Responsável aprova inclusão proposta em PDF da própria área | Permitido; registrar decisão por linha, usuário, data/hora e auditoria |
| APR-02 | Responsável tenta aprovar lote de outra área | Negado no servidor |
| APR-03 | Responsável aprova alteração cadastral em sua área | Permitido após revisão; preservar UUID e dados históricos pertinentes |
| APR-04 | Responsável confirma exclusão de interno ausente em PDF completo | Exigir motivo; exclusão lógica auditada |
| APR-05 | Responsável tenta confirmar exclusão sem motivo | Rejeitar |
| APR-06 | PDF incompleto/truncado apresenta internos ausentes | Não permitir aprovação de exclusões; lote deve falhar na validação de completude |
| APR-07 | Linha apresenta homônimo ou correspondência ambígua | Exigir decisão humana explícita antes da aprovação |
| APR-08 | Lote contém linhas aprovadas e linhas ainda pendentes | Aplicar somente decisões explicitamente aprovadas, conforme regra de atomicidade definida para o lote; nunca aplicar pendências silenciosamente |
| APR-09 | A aprovação é enviada com usuário_id adulterado no payload | Ignorar/rejeitar; usar identidade da sessão autenticada |
| APR-10 | Aprovação repetida com mesma chave de operação | Idempotente; não duplicar eventos nem efeitos |
| APR-11 | Aprovação tenta alterar decisão já aplicada sem fluxo de retificação | Rejeitar e preservar auditoria anterior |
| APR-12 | Falha ao gravar histórico/auditoria durante aplicação | Rollback integral das alterações do lote |

**Permissão de envio confirmada:** Responsável de área pode enviar/iniciar a importação somente para sua área vinculada; Chefe e Auxiliar podem enviar/iniciar importação para qualquer uma das oito áreas. Enviar/iniciar o lote não significa aprovar suas divergências. A permissão do Administrador para enviar/iniciar importações permanece pendente de definição.

## 7. Cenários de envio/início da importação

| ID | Cenário | Resultado esperado |
|---|---|---|
| ENV-01 | Responsável envia PDF da própria área | Permitido; lote fica associado à área e ao usuário autenticado |
| ENV-02 | Responsável tenta enviar PDF para outra área | Negado no servidor |
| ENV-03 | Chefe envia PDF de qualquer uma das oito áreas | Permitido |
| ENV-04 | Auxiliar envia PDF de qualquer uma das oito áreas | Permitido |
| ENV-05 | Chefe ou Auxiliar altera a área no payload para uma área diferente da selecionada | Servidor valida escopo e registra a área efetivamente selecionada; não aceitar inconsistência |
| ENV-06 | Usuário sem autenticação ou com senha diária vencida tenta iniciar importação | Negar mutação |
| ENV-07 | Mesmo PDF/hash da mesma área é enviado novamente | Alertar duplicidade e não reaplicar automaticamente |

## 8. Testes transversais de autorização

1. Testar cada operação diretamente na API, sem depender da interface.
2. Alterar no payload o identificador da área/cela para outra área e confirmar que o servidor ignora ou rejeita a tentativa.
3. Confirmar que o usuário responsável é obtido da sessão autenticada, nunca de um campo livre enviado pelo navegador.
4. Confirmar vínculo usuário-área em toda mutação, inclusive em comandos sincronizados offline.
5. Confirmar que data/hora do dispositivo não substitui o horário do servidor na trilha de auditoria.
6. Confirmar que a senha diária é validada em cada mutação.
7. Confirmar que falha ao gravar histórico/auditoria cancela a operação inteira.
8. Confirmar que respostas de erro não revelam dados de internos de áreas não autorizadas.

## 9. Testes de finalização e retificação de conferência física

| ID | Cenário | Resultado esperado |
|---|---|---|
| CNF-01 | Responsável finaliza conferência da própria área | Permitido; grava horário, usuário e auditoria |
| CNF-02 | Responsável tenta finalizar conferência de outra área | Negado no servidor |
| CNF-03 | Administrador, Chefe ou Auxiliar tenta finalizar diretamente | Negado; a competência de finalização é do Responsável da área |
| CNF-04 | Responsável tenta editar marcações após finalizar sem iniciar retificação | Negado; snapshot final permanece preservado |
| CNF-05 | Responsável retifica conferência finalizada de sua área com justificativa | Permitido somente pelo fluxo formal de retificação, com histórico e auditoria |
| CNF-06 | Responsável tenta retificar conferência de outra área | Negado no servidor |
| CNF-07 | Retificação sem justificativa | Negada |
| CNF-08 | Falha ao registrar auditoria durante retificação | Operação inteira revertida |
| CNF-09 | Retificação altera resultado histórico | Preservar versão anterior e registrar valores anteriores/novos; nunca sobrescrever sem trilha |

**Regra confirmada:** a retificação é autorizada pelo próprio Responsável da área, com sua justificativa e registro de auditoria. Não exige aprovação de segundo usuário. Continua sendo um fluxo formal, com preservação da versão anterior e registro dos valores anteriores e novos; não é edição livre.

## 10. Evidências que devem ser coletadas na implementação

Para cada teste: usuário/perfil de teste, área vinculada, requisição sem segredos, resposta HTTP, estado antes/depois, registros de histórico e auditoria, e confirmação de ausência de gravações parciais em falhas.

Não registrar senhas, hashes, cookies, tokens ou URLs de conexão nas evidências.

## 11. Fora do escopo / decisões ainda pendentes

- Quem pode aprovar inclusões, alterações e exclusões sugeridas pela importação PDF.
- Quais ações específicas Chefe e Auxiliar podem executar em nome de qualquer área, além das permissões já confirmadas.
- Se o Administrador também poderá enviar/iniciar importações PDF.

- Quem pode finalizar conferências e quem pode autorizar retificações.
- Tipos adicionais de movimentação/ocorrência.
- Armazenamento e prazo de retenção dos PDFs.

Os itens pendentes não devem ser tratados como permissões liberadas por inferência.

## 12. Limite desta etapa

Este documento é um plano de testes. Não implementa endpoints, não altera tabelas e não aplica migrations. O banco Neon `confere-dev` permanece sem alterações de schema; o banco do Sistema Atendimento CPAIG principal não é utilizado.
