# CONFERE DOS PAVILHÕES — Revisão de lacunas das migrations 001–004

**Status:** revisão documental e técnica; não altera o banco e não substitui testes de integração.  
**Branch de código:** `feature/confere-pavilhoes`  
**Banco de desenvolvimento:** projeto exclusivo `confere-pavilhoes-dev`, branch `confere-dev`.  
**Importante:** as migrations 001–004 estão versionadas, mas não foram aplicadas à branch permanente `confere-dev`. O banco principal do Sistema Atendimento CPAIG permanece intocado.

## 1. Escopo revisado

Foram lidos os arquivos:
- `001-estrutura-inicial-v1.sql` — 19 tabelas de base.
- `002-reforco-integridade-v1.sql` — constraints e chaves compostas.
- `003-protecao-historico-conferencias.sql` — proteção de histórico/auditoria e itens de conferência.
- `004-decisao-transacional-transferencia.sql` — função de decisão transacional de transferência.
- Modelo relacional v2, matriz preliminar de permissões e plano de testes de autorização.

A revisão considera também as decisões recentes: inclusão manual pelo Responsável de área; exclusão e reativação por Administrador, Chefe, Auxiliar e Responsável; aprovação de divergências de PDF pelo Responsável na própria área; envio/início de PDF pelo Responsável na própria área e por Chefe/Auxiliar em qualquer uma das oito áreas.

## 2. O que já existe na estrutura SQL

- Cadastro de usuários, áreas, vínculo usuário-área e celas.
- Cadastro de internos com UUID próprio e campos do PDF.
- Histórico de eventos e auditoria.
- Localizações com histórico e índice para uma localização atual por interno.
- Lotes de importação e linhas extraídas, incluindo campos de decisão, responsável, horário e motivo.
- Movimentações independentes.
- Transferências, aprovações e função transacional de decisão.
- Conferências e itens com dados de snapshot.
- Plantões, resumos, senhas diárias e operações sincronizadas.

Essas estruturas são uma base relacional. A existência de tabelas/colunas não significa que os fluxos de aplicação, autorização e validação estejam implementados.

## 3. Lacunas que precisam ser resolvidas antes de considerar a estrutura pronta

### 3.1 Importação e validação dos oito PDFs — prioridade crítica

A tabela `importacoes` registra arquivo, hash, área, status e remetente; `importacao_linhas` registra linhas extraídas e decisões. Ainda precisam ser definidos/implementados:
- Evidência verificável de que o PDF contém todas as páginas esperadas e a relação completa da área.
- Quantidade de páginas, resultado da extração, versão do extrator, validação de truncamento e motivo de falha.
- Bloqueio explícito de propostas de ausência/exclusão quando o arquivo estiver incompleto, ilegível ou truncado.
- Regra para reconhecer e armazenar a fotografia completa por área, sem misturar as oito áreas.
- Serviço de comparação que produza candidatos de inclusão, correspondência, alteração, mudança de cela, homônimo e possível ausência.
- Aprovação por linha e aplicação atômica das decisões aprovadas.
- Cancelamento sem alterar o cadastro ativo.
- Idempotência para reenvio do mesmo arquivo e proteção contra aplicação duplicada.
- Armazenamento seguro do PDF original e política de retenção, ainda pendente de decisão.

**Regra funcional já confirmada:** PDF incompleto não pode gerar exclusões. Ausência em PDF completo é apenas candidata; nunca exclui automaticamente.

### 3.2 Envio do PDF versus aprovação — permissão atualizada

Permissões confirmadas:
- Responsável de área: pode enviar/iniciar importação somente para sua área vinculada.
- Chefe e Auxiliar: podem enviar/iniciar importação para qualquer uma das oito áreas.
- Responsável de área: pode aprovar inclusões, alterações e exclusões propostas somente em sua área, após revisão.
- Exclusão aprovada exige motivo e auditoria.

Ainda falta decidir se Administrador também poderá enviar/iniciar importações. A matriz e a API devem manter essa permissão como não definida, sem concedê-la por padrão.

### 3.3 Inclusão manual, exclusão e reativação

A tabela `internos` comporta cadastro mínimo, mas o fluxo exige serviço transacional que:
- Permita ao Responsável incluir somente em área/cela vinculada, com nome e cela obrigatórios.
- Crie a localização inicial e os eventos de histórico/auditoria na mesma transação.
- Registre origem do cadastro como inclusão manual e mantenha os dados complementares pendentes até o PDF posterior.
- Faça conciliação posterior sem duplicar o interno.
- Encaminhe homônimos/ambiguidade para revisão humana.
- Faça exclusão lógica e reativação com motivo obrigatório, usuário autenticado, data/hora e evento permanente.
- Preserve ficha, histórico, movimentações e localizações anteriores.

As permissões precisam ser aplicadas no servidor; não basta esconder botões na interface nem confiar no JSONB `permissoes`.

### 3.4 Matriz de autorização e credenciais diárias

A estrutura de usuários e vínculos existe, mas faltam:
- Matriz fechada de ações por perfil, incluindo decisões ainda pendentes.
- Verificação server-side do perfil, vínculo de área/cela e senha diária vigente em cada mutação.
- Regra inequívoca para sessão que permanece aberta após 08h: bloquear mutações até atualização da senha, sem encerrar a sessão.
- Validação de validade em `America/Campo_Grande`, sem depender do relógio do navegador.
- Restrições contra senhas diárias sobrepostas/ambíguas e política de emissão/rotação.
- Separação de privilégios entre role proprietária/migration e role da aplicação; a aplicação não deve poder contornar proteções de histórico.

### 3.5 Transferências

A função 004 implementa uma base transacional para aceitar/recusar transferência e foi validada sintaticamente em branch temporária. O teste comportamental completo não foi concluído. Antes de uso real, ainda é necessário:
- Testar aceite, recusa, duplicidade, concorrência e rollback com fixtures controladas.
- Validar que o usuário decisor tem perfil e vínculo com a área de destino.
- Derivar a identidade do usuário da sessão autenticada no servidor, nunca confiar em `p_usuario_id` enviado pelo cliente.
- Definir e implementar a regra já decidida para transferências entre áreas da mesma conta (C/D), que não exigem aceite externo.
- Garantir integração com movimentações abertas e eventos de histórico/auditoria.
- Verificar que recusa mantém a localização original e que aceite encerra origem e cria destino atomicamente.

### 3.6 Conferência física e snapshots

Os campos de snapshot existem e a migration 003 protege alterações posteriores dos itens, mas ainda é necessário:
- Criar a rotina transacional de início que copia a relação completa da área/cela para os itens da conferência.
- Testar que mudanças de cadastro/localização posteriores não alteram o snapshot.
- Somente o Responsável da área vinculada pode finalizar e retificar conferências daquela área. Retificação exige justificativa do próprio Responsável e auditoria, sem aprovação de segundo usuário.
- Garantir que cancelamento/finalização não apaguem itens nem registros.
- Validar relatório final e totais de conferidos, não localizados e outras situações.

### 3.7 Plantões, ocorrências e offline

- Implementar fechamento automático às 08h de Campo Grande e geração de resumo de todas as áreas sem apagar/bloquear registros.
- Definir tipos adicionais de ocorrência além dos já listados; o tipo `OUTRA` existe como fallback, mas precisa de descrição obrigatória e trilha.
- Implementar IndexedDB, Service Worker, fila idempotente, sincronização e resolução de conflitos; não presumir funcionamento offline apenas porque existe a tabela `operacoes_sincronizadas`.
- Testar que a fila local só é limpa após confirmação do servidor/Neon.

### 3.8 Auditoria, histórico e backups

- A migration 003 protege UPDATE/DELETE nas tabelas de auditoria e histórico por trigger, mas a aplicação deve usar role sem privilégios de proprietário e sem capacidade de desabilitar triggers.
- Testar que uma falha ao gravar auditoria causa rollback da operação de negócio.
- Definir armazenamento e retenção de PDFs originais.
- Implementar backup diário e antes de atualizações importantes, verificação de integridade e teste de restauração.

## 4. Especificação detalhada de completude do PDF

Foi criada a especificação `confere/database/ESPECIFICACAO-VALIDACAO-PDF-COMPLETO-V1.md`, com etapas de integridade, extração de todas as páginas, validação estrutural, comparação de plausibilidade, confirmação humana, estados do lote e 18 casos de teste. Ela não implementa o parser nem altera o schema. A especificação também identifica os metadados por página/lote que provavelmente precisarão de migration futura.

## 5. Fluxo de importação e conciliação

Foi criada a especificação `confere/database/FLUXO-IMPORTACAO-CONCILIACAO-PDF-V1.md`. Ela define estados do lote, envio, extração em staging, conciliação, revisão por linha, aplicação transacional, idempotência, concorrência, contrato lógico dos serviços e critérios de aceite. É desenho técnico; ainda não implementa rotas, parser ou migration.

## 6. Ordem recomendada de trabalho

1. Fechar as decisões de permissões ainda pendentes, sem assumir autorização implícita.
2. Especificar a validação de PDF completo e o fluxo de importação staged.
3. Criar migration posterior para os campos/constraints estritamente necessários ao ciclo de importação, após revisão.
4. Implementar serviços transacionais de inclusão manual, exclusão, reativação e aplicação de decisões do PDF.
5. Implementar autorização server-side e separação de roles do banco.
6. Completar testes automatizados de transferências, conferências, auditoria, senha diária e offline.
7. Só depois preparar uma migration consolidada e testá-la em branch Neon temporária.
8. Após testes e aprovação explícita, avaliar aplicação na branch permanente `confere-dev`. Nunca no banco principal CPAIG.

## 7. Decisões ainda pendentes

1. O Administrador poderá enviar/iniciar importações PDF?

4. Onde armazenar os PDFs originais e por quanto tempo?
5. Quais tipos adicionais de ocorrência devem aparecer como opções próprias?

## 8. Estado de segurança desta revisão

- Nenhuma consulta de escrita foi executada no Neon nesta etapa.
- Nenhuma migration foi aplicada à branch permanente `confere-dev`.
- Nenhuma alteração foi feita no banco do Sistema Atendimento CPAIG.
- Este documento é uma revisão de lacunas, não uma declaração de que o módulo já está implementado ou pronto para produção.
