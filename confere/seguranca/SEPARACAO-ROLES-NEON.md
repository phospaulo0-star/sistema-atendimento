# CONFERE DOS PAVILHÕES — Separação de privilégios do banco

Status: desenho técnico. Nenhuma role nova foi criada e nenhum GRANT foi aplicado.

## Objetivo

Separar a identidade que administra o schema da identidade usada pelo serviço web.

## Papéis propostos

### Role proprietária/migration

- Mantém propriedade do schema `confere`, tabelas, sequências, funções e triggers.
- Usada somente em operações administrativas/migrações controladas.
- Não deve ser configurada como variável de ambiente do serviço web.
- Credencial armazenada apenas no gerenciador de segredos da equipe.

### Role de aplicação

- Não é proprietária do schema.
- Não recebe `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CREATEROLE` ou privilégios de superusuário.
- Recebe apenas `USAGE` no schema e privilégios DML estritamente necessários nas tabelas/views definidas.
- Recebe `EXECUTE` somente nas funções transacionais explicitamente aprovadas.
- Não recebe UPDATE/DELETE em `auditoria` nem `historico_eventos`.
- Não recebe UPDATE/DELETE em snapshots de conferências finalizadas.
- A API deve derivar o usuário da sessão autenticada e validar autorização no servidor.

## Princípio de concessão

Não conceder permissões amplas em todas as tabelas por conveniência. Criar GRANTs por objeto e por operação depois de fechar a matriz de permissões.

A aplicação não deve chamar SQL arbitrário nem aceitar nome de tabela, nome de função ou cláusula SQL enviada pelo cliente.

## Funções transacionais

A função de decisão de transferência atualmente foi desenhada como SECURITY INVOKER (comportamento padrão), sem elevação de privilégios. Portanto, a role da aplicação precisará dos privilégios mínimos sobre as tabelas envolvidas. Uma alternativa futura é uma função SECURITY DEFINER cuidadosamente endurecida, com proprietário dedicado, search_path fixo, validação do usuário autenticado e EXECUTE restrito. Essa alternativa exige revisão de segurança própria e não deve ser habilitada automaticamente.

## Configuração no serviço

Quando houver serviço Render exclusivo do CONFERE:
- `CONFERE_DATABASE_URL`: conexão da role de aplicação para o projeto Neon exclusivo.
- `CONFERE_DB_ENV`: ambiente identificado.
- `CONFERE_DB_ALLOWED_HOST`: hostname permitido para validação de destino.
- Nunca usar `DATABASE_URL` do sistema CPAIG existente.
- Nunca usar credencial proprietária/migration no serviço web.
- Nunca incluir URLs de conexão, tokens ou senhas no GitHub, logs ou mensagens.

## Ordem segura de implantação

1. Fechar a matriz de permissões.
2. Criar role de aplicação no projeto Neon CONFERE, com credencial nova.
3. Aplicar grants mínimos em branch isolada e testar com essa role.
4. Confirmar que a role da aplicação não consegue criar/alterar/apagar schema, nem modificar auditoria/histórico.
5. Confirmar que operações autorizadas funcionam e as não autorizadas falham.
6. Guardar credencial somente em secret do serviço Render exclusivo.
7. Manter role proprietária fora do runtime web.

Nenhuma dessas etapas autoriza uso do banco principal do Sistema Atendimento CPAIG.
