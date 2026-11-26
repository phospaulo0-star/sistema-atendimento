# Plano de permissões do banco — CONFERE DOS PAVILHÕES

**Status:** proposta técnica para revisão; ainda não aplicada.  
**Ambiente analisado:** projeto Neon exclusivo `confere-pavilhoes-dev`, branch `confere-dev`, schema `confere`.  
**Regra de segurança:** nenhuma alteração de roles, grants, políticas ou schema foi executada nesta revisão.

## 1. Diagnóstico observado

A inspeção somente de leitura encontrou:

- O único role PostgreSQL de aplicação listado é `confere_owner`.
- Esse role tem `LOGIN`, `CREATEDB`, `CREATEROLE` e `BYPASSRLS`; não é apropriado para ser usado pela aplicação web.
- O role proprietário tem privilégios de leitura e escrita amplos nas 22 tabelas do schema `confere`, incluindo `DELETE`, `TRUNCATE` e `TRIGGER`.
- Não foram encontradas políticas RLS no schema `confere`.
- Não foram encontrados privilégios padrão adicionais configurados para o schema.

O diagnóstico não indica exposição pública: ele descreve o estado dos privilégios PostgreSQL consultados. A aplicação ainda não está conectada a esse banco.

## 2. Separação de identidades recomendada

Manter três identidades distintas:

1. **Proprietário/migração** — identidade administrativa usada somente em operações controladas de manutenção e migração. Não deve constar nas variáveis de ambiente do servidor web.
2. **Aplicação em runtime** — role dedicado, com login, sem superusuário, sem criação de banco/roles e sem `BYPASSRLS`. A aplicação usa exclusivamente essa credencial em `CONFERE_DATABASE_URL`.
3. **Operador humano** — usuários Chefe, Auxiliar, Administrador e Responsáveis autenticados pela aplicação. Não recebem credenciais PostgreSQL.

Não reutilizar `confere_owner` como credencial do servidor.

## 3. Princípios para o role de runtime

- Sem `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`.
- Sem propriedade de tabelas, sequences ou funções.
- Sem `CREATE` no schema `confere`.
- Sem `TRUNCATE`, `TRIGGER`, `REFERENCES` ou privilégios globais desnecessários.
- Sem exclusão física de registros operacionais.
- Permissões de leitura e escrita concedidas por tabela e, quando necessário, por coluna.
- Sequências usadas por identidade/serial recebem somente os privilégios estritamente necessários.
- Funções transacionais recebem `EXECUTE` explicitamente; não presumir que a permissão venha automaticamente.
- Revogar privilégios de `PUBLIC` sobre funções sensíveis e conceder somente ao role de runtime, após inventário completo das funções.
- Não usar permissões concedidas em todas as tabelas futuras (`ALTER DEFAULT PRIVILEGES`) sem definir primeiro o processo de migração e revisão.

## 4. Autorização por área

O role PostgreSQL compartilhado não identifica, sozinho, qual pessoa está operando a aplicação. Portanto:

- A API deve autenticar a sessão e derivar o ID do usuário no servidor.
- Nunca aceitar `usuario_id`, perfil ou área de atuação como autoridade vinda do navegador.
- A API valida perfil, área vinculada e regra de negócio em toda operação.
- Transferências e alterações críticas continuam sendo executadas por funções transacionais, com o ator derivado da sessão.
- A regra já definida deve ser mantida: transferência entre áreas da mesma conta pode ser decidida diretamente pelo Responsável da área de origem; transferência entre contas exige decisão do Responsável da área de destino.
- Toda operação relevante grava auditoria com ator, data/hora, motivo e contexto.

Como ainda não há RLS configurado, a primeira versão deve ser tratada como banco privado, acessível somente pelo servidor. Antes de qualquer acesso direto por cliente/browser, será obrigatório projetar e testar RLS ou uma camada equivalente de autorização no banco.

## 5. Matriz inicial de permissões (a validar contra a API)

| Grupo de dados | Runtime recomendado |
|---|---|
| Cadastros e localização atual | SELECT e DML estritamente necessários às rotinas da API |
| Áreas, celas e vínculos de usuários | SELECT; escrita somente por rotinas administrativas controladas |
| Movimentações, transferências e aprovações | SELECT; INSERT/UPDATE somente conforme fluxo transacional |
| Auditoria e histórico | SELECT conforme necessidade; INSERT; sem UPDATE/DELETE |
| Conferências e itens/snapshots | SELECT/INSERT/UPDATE conforme fluxo; sem exclusão física |
| Importações, páginas, linhas, fotografias e operações idempotentes | SELECT/INSERT/UPDATE conforme fluxo de importação; sem TRUNCATE |
| Resumos de plantão | SELECT/INSERT; retificação por fluxo auditado, sem apagar histórico |
| Senhas diárias | acesso mínimo; nunca retornar hashes/segredos à interface |

Esta matriz é um ponto de partida, não um script de GRANT. A lista final depende da API e das funções SQL que efetivamente serão chamadas.

## 6. Testes obrigatórios antes de habilitar runtime

Executar em branch temporária isolada, com dados sintéticos:

1. Conectar usando o role de runtime.
2. Confirmar que SELECT/INSERT/UPDATE permitidos funcionam.
3. Confirmar que CREATE TABLE, DROP, TRUNCATE, DELETE em histórico/auditoria e alterações de schema falham.
4. Confirmar que o runtime não pode criar roles/bancos nem contornar RLS.
5. Confirmar que funções transacionais só podem ser executadas pelo role autorizado.
6. Testar cada perfil e cada área pela API, incluindo tentativas de falsificar `usuario_id` e área no payload.
7. Testar rollback, concorrência e idempotência das operações críticas.
8. Verificar que a aplicação não consegue conectar se `CONFERE_DATABASE_URL` estiver ausente; nunca recorrer a `DATABASE_URL` do Sistema Atendimento.

## 7. Ordem segura de implantação

1. Concluir inventário de tabelas, sequences, funções, ownership e operações da API.
2. Revisar a matriz de permissões com base nesse inventário.
3. Preparar script de roles/grants versionado em `confere/database/`, sem executá-lo no branch permanente.
4. Testar criação e privilégios em branch temporária, usando apenas dados fictícios.
5. Integrar a API usando exclusivamente `CONFERE_DATABASE_URL`.
6. Só depois de testes aprovados, solicitar autorização específica para aplicar a configuração no branch permanente `confere-dev`.

## 8. Limites desta revisão

- Nenhum role foi criado ou alterado.
- Nenhum GRANT/REVOKE, política RLS ou migração foi aplicado nesta etapa.
- Nenhuma alteração foi feita no banco do Sistema Atendimento, no Render principal ou na branch `main`.
- O schema CONFERE existe, mas a API ainda não foi implementada; portanto, não é seguro fechar uma lista definitiva de privilégios antes de conhecer todas as consultas e transações que a aplicação executará.
