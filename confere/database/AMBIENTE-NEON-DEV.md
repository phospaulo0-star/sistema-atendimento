# Ambiente Neon de desenvolvimento — CONFERE

## Projeto provisionado

- Projeto: `confere-pavilhoes-dev`
- Project ID: `lingering-king-35426730`
- Região: `aws-sa-east-1` (São Paulo)
- PostgreSQL: 18
- Branch: `confere-dev`
- Branch ID: `br-calm-glitter-b63kge9b`
- Database: `neondb`
- Role: `confere_owner`
- Compute: mínimo 0,25 CU; máximo 0,5 CU; suspensão após 300 segundos de inatividade.

## Verificação inicial

Conexão confirmada com uma consulta somente de leitura em 25/11/2026:
- database: `neondb`
- usuário: `confere_owner`
- schema atual: `public`
- PostgreSQL: `18.7`

A branch não contém tabelas de aplicação. Nenhum schema, tabela, extensão, usuário adicional ou migração foi criado após a verificação.

## Configuração do serviço de desenvolvimento

Configurar apenas no futuro serviço Render exclusivo do CONFERE:

- `CONFERE_DATABASE_URL`: URL de conexão da branch `confere-dev`, preferencialmente pooled para o tráfego da aplicação.
- `CONFERE_DB_ENV=development`
- `CONFERE_DB_ALLOWED_HOST=ep-old-frost-b6hv8zff-pooler.c-2.sa-east-1.aws.neon.tech`

A URL completa contém credencial e não deve ser gravada no GitHub, em logs ou enviada em mensagens. Obter a URL diretamente do painel Neon e armazená-la como variável secreta no Render.

O endpoint é exclusivo deste projeto e foi verificado como diferente do endpoint da branch de desenvolvimento do Sistema Atendimento.

## Restrições

- Não configurar este banco no serviço Render do Sistema Atendimento.
- Não usar `DATABASE_URL` do sistema principal.
- Não apontar este ambiente para a branch `dev-sistema-atendimento-v2-10` ou `production` do projeto principal.
- Não criar tabelas/migrações até revisão da modelagem e autorização específica.
