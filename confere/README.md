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
- `seguranca/`: políticas de autorização e testes de domínio.

## Estado atual

- A configuração de conexão isolada está documentada em `database/pool.js`; ela exige `CONFERE_DATABASE_URL`, ambiente explicitamente de desenvolvimento/teste e hostname permitido, sem fallback para `DATABASE_URL`.
- O modelo relacional e as migrations 001–006 estão versionados para revisão.
- As migrations 003 e 004 tiveram testes comportamentais em branch temporária com dados sintéticos.
- As regras puras de pré-validação da importação PDF estão em `importacao/regras-aplicacao.js`.
- A primeira camada de autorização de domínio está em `seguranca/autorizacao.js`, com testes em `seguranca/autorizacao.test.js`.
- O contrato de autenticação, sessão e senha diária está especificado em `seguranca/CONTRATO-AUTENTICACAO-SESSAO-SENHA-DIARIA-V1.md`; ainda não há login ativo.
- O plano de privilégios do banco está em `database/PLANO-PERMISSOES-RUNTIME-2026-11-26.md`.

**Limite atual:** ainda não há login HTTP, gestão de sessão, validação da senha diária, endpoints, parser PDF, interface web nem serviço Render exclusivo. A camada de autorização criada é lógica de domínio e não substitui autenticação, consultas ao banco ou revalidação transacional.

## Próximas etapas

1. Executar os testes Node dos módulos puros e corrigir eventuais falhas.
2. Confirmar as decisões pendentes do contrato de senha diária e expiração de sessão.
3. Implementar autenticação/sessões e a migration de sessões em branch Neon temporária.
4. Preparar e testar privilégios mínimos em branch Neon temporária.
5. Implementar serviços, repositórios, endpoints e testes de integração.
6. Criar parser PDF, interface própria e ambiente de homologação separado.
7. Integrar/deploy somente após revisão de segurança e autorização expressa.
