# CONFERE DOS PAVILHÕES

Módulo em desenvolvimento isolado na branch `feature/confere-pavilhoes`.

## Objetivo desta pasta

Concentrar o código próprio do CONFERE DOS PAVILHÕES sem alterar o funcionamento dos módulos atuais do Sistema Atendimento CPAIG.

## Regras de isolamento

- Não modificar `servidor.js`, `server.js`, `package.json` ou arquivos existentes de `public/` nesta etapa.
- Não registrar rotas do CONFERE no servidor principal até existir ambiente de homologação próprio e revisão de segurança.
- Não executar comandos SQL contra o Neon de produção.
- Não armazenar credenciais, tokens, URLs privadas ou dados operacionais neste repositório.
- Não conectar este branch ao serviço Render atualmente usado pelo Sistema Atendimento.
- Toda alteração futura deverá permanecer nesta branch até revisão e aprovação.

## Arquitetura planejada

- `routes/`: rotas HTTP exclusivas do módulo.
- `services/`: regras de negócio e validações.
- `repositories/`: acesso a dados por meio de conexão própria.
- `middleware/`: autenticação e autorização específicas.
- `database/`: migrações SQL para o schema `confere`, executadas somente em banco de testes após validação.
- `public/`: telas próprias do módulo.
- `jobs/`: tarefas agendadas no fuso `America/Campo_Grande`.
- `tests/`: testes automatizados e cenários de homologação.

## Estado atual

Esta pasta contém somente documentação inicial. Nenhuma rota, tela, tabela, usuário ou rotina do CONFERE foi ativada. O módulo ainda não está conectado ao servidor nem ao banco.

## Próximas etapas

1. Definir e validar a configuração independente de banco de testes.
2. Implementar testes de conexão sem executar migrações automaticamente.
3. Criar autenticação isolada e testes de autorização.
4. Criar migrações revisáveis para o schema `confere`.
5. Integrar ao servidor somente após homologação e aprovação expressa.
