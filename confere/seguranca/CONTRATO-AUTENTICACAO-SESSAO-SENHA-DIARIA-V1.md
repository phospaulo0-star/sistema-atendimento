# CONFERE — contrato de autenticação, sessão e senha diária (proposta v1)

**Status:** desenho para implementação e revisão. Não cria usuários, sessões, senhas nem altera o banco.

## 1. Identidades e níveis de autenticação

O CONFERE terá autenticação própria, separada do Sistema Atendimento CPAIG.

- Usuário individual: login e senha pessoal armazenada somente como hash.
- Conta operacional: uma das cinco contas A, B, C, D ou VIRTUAL, conforme vínculo de área.
- Perfil: ADMINISTRADOR, CHEFE, AUXILIAR ou RESPONSAVEL_AREA.
- Senha diária: uma única senha operacional compartilhada por todos os usuários do CONFERE, renovada às 08:00 no horário de Mato Grosso do Sul; não substitui o login individual.

A conta operacional não deve ser inferida de um campo enviado pelo navegador. Ela é resolvida a partir dos vínculos ativos do usuário no banco.

## 2. Armazenamento de senha pessoal

- Armazenar somente hash forte com salt individual.
- Preferir scrypt do módulo nativo `node:crypto` para evitar adicionar dependência sem revisão; parâmetros devem ser versionados e calibrados no ambiente de homologação.
- Comparação em tempo constante.
- Nunca registrar senha, hash, token, cookie ou senha diária em log, auditoria, mensagem de erro ou resposta HTTP.
- Respostas de login devem ser genéricas para não revelar se login existe, está inativo ou se a senha está errada.
- Aplicar limitação de tentativas por login e IP, atraso progressivo e trilha de auditoria sem guardar segredos.

A criação/alteração de hash e a política de recuperação de senha precisam de testes específicos antes de ativar login.

## 3. Sessão

O navegador não recebe UUID de usuário como prova de identidade nem guarda credencial PostgreSQL.

Proposta:
- Token de sessão aleatório, criptograficamente seguro, gerado no servidor.
- Banco armazena somente hash do token, usuário, criação, expiração, revogação e metadados mínimos.
- Cookie `HttpOnly`, `Secure`, `SameSite=Lax` (ou mais restritivo se a navegação permitir), escopo `Path=/`, sem acesso por JavaScript.
- Rotação do identificador após login e elevação de autenticação.
- Logout revoga sessão no servidor.
- Validação de sessão em cada requisição protegida.
- Proteção CSRF em operações mutáveis, além de validação de Origin/Host.
- Expiração por inatividade e limite absoluto de sessão, definidos antes da homologação.
- Nenhuma rota usa `usuario_id`, perfil, conta ou áreas vindos de `req.body`, query string ou cabeçalho arbitrário como autoridade.

A camada HTTP hidrata `req.auth.user` consultando a sessão e os vínculos atuais no banco. O módulo `seguranca/autorizacao.js` consome esse objeto confiável.

## 4. Regra da senha diária às 08:00

Fuso operacional: `America/Campo_Grande`. O servidor, não o relógio do navegador, determina a janela válida.

- Antes das 08:00, a senha diária vigente continua válida.
- Às 08:00, a senha diária anterior deixa de autorizar novas mutações.
- Sessão existente pode continuar aberta para consulta e para informar a nova senha diária.
- Até validar a senha diária atual, operações de inclusão, alteração, movimentação, aprovação, conferência e demais mutações ficam bloqueadas.
- Nova sessão após a virada também precisa cumprir a regra da senha diária antes de operar.
- O servidor valida a senha diária em cada comando mutável, consultando o período de validade e a conta operacional vinculada.
- Não confiar em flag `senhaDiariaOk` mantida somente no navegador.
- Após validar, a sessão pode receber um comprovante de validação curto e revogável, mas a API deve revalidar a janela de validade e a conta antes da mutação.

A senha diária não deve ser enviada em texto claro para outros usuários, registrada em logs nem armazenada em navegador persistente.

## 5. Administração e geração diária

A geração e a distribuição da senha diária única e compartilhada ficam autorizadas aos perfis **ADMINISTRADOR, CHEFE e AUXILIAR**. O sistema deverá registrar qual desses responsáveis gerou/renovou a senha e quando isso ocorreu, sem armazenar a senha em texto claro na auditoria. O login permanece individual para identificar cada usuário; a senha diária é comum a todos. A forma de geração, a distribuição segura e a recuperação em caso de perda ainda precisam ser definidas antes da ativação. A geração não pode depender de um valor previsível nem ficar disponível a perfis não autorizados.

O banco atual contém `senhas_diarias`, com hash e intervalo de validade, mas ainda não há serviço de autenticação, sessão, verificação nem rotina de rotação. Não executar job automático até a regra de geração/distribuição e o tratamento de indisponibilidade estarem testados.

## 6. Migração necessária antes do login

O modelo atual não possui tabela de sessões. Uma migration futura deverá criar, no mínimo:

- `sessoes`: ID, usuário, hash do token, criada_em, expira_em, ultimo_uso_em, revogada_em, motivo_revogacao e metadados de segurança minimizados.
- Índice único para hash do token.
- Índices de expiração e usuário.
- Constraints para coerência temporal.
- Política de retenção/limpeza que não apague auditoria operacional.
- Campos adicionais somente se justificados por requisitos concretos.

A migration também deve revisar a tabela `senhas_diarias`: impedir intervalos conflitantes por usuário/conta, definir qual chave de escopo vale para cada tipo de conta e garantir que a janela seja inequívoca.

## 7. Contrato mínimo de rotas (ainda não implementadas)

| Rota | Acesso | Efeito |
|---|---|---|
| POST /auth/login | Público, com rate limit | Valida login/senha e cria sessão |
| GET /auth/me | Sessão válida | Retorna perfil, áreas e estado da senha diária, sem segredos |
| POST /auth/daily-password | Sessão válida | Valida senha diária da conta vinculada |
| POST /auth/logout | Sessão válida | Revoga sessão e limpa cookie |
| POST /auth/change-password | Sessão válida + validação adicional | Troca senha pessoal, revoga outras sessões |

Todas as rotas mutáveis do domínio devem exigir sessão válida, autorização de perfil/área e senha diária vigente. Rotas de consulta exigem sessão válida, mas não necessariamente senha diária atual.

## 8. Testes de segurança obrigatórios

1. Senha pessoal correta/incorreta e usuário inativo.
2. Resposta de login não revela existência do usuário.
3. Token aleatório, hash no banco e cookie com atributos seguros.
4. Rotação de sessão após login; sessão antiga deixa de funcionar.
5. Logout invalida imediatamente o token.
6. Sessão expirada/revogada é rejeitada.
7. Tentativa CSRF e Origin inválida é rejeitada.
8. Às 07:59:59 a senha diária ainda pode autorizar; às 08:00:00 a senha anterior não pode.
9. Sessão existente continua permitindo consulta após 08:00, mas bloqueia mutações até nova senha diária.
10. Alterar conta/área/usuário no payload não muda identidade nem autorização.
11. Usuário Responsável sem vínculo atual perde acesso à área sem precisar encerrar todas as sessões.
12. Duas senhas diárias conflitantes para a mesma conta/janela são impedidas.
13. Logs e auditoria não contêm senha, hash, token ou cookie.

## 9. Decisões pendentes antes de codificar o login

- Prazo de expiração por inatividade e limite absoluto da sessão.
- Política de recuperação/troca da senha pessoal.
- Procedimento de contingência se Neon estiver indisponível no momento da virada das 08:00.

A autorização de geração/distribuição e o uso de uma única senha diária compartilhada estão definidos; as demais decisões pendentes precisam ser confirmadas antes de ativar login e senha diária. Até lá, manter login e senha diária desativados e não criar credenciais reais.
