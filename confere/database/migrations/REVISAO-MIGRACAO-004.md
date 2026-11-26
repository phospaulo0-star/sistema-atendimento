# CONFERE DOS PAVILHÕES — Revisão da migration 004

## Objetivo

Centralizar a decisão de transferência em uma função transacional no PostgreSQL, garantindo que aceite e recusa tenham efeitos distintos e auditáveis.

## Arquivo versionado

`confere/database/migrations/004-decisao-transacional-transferencia.sql`

Commit: `08fc2f461e762582787ae63fb09efd9da6ff384a`

## Comportamento previsto

A função `confere.fn_decidir_transferencia`:
1. aceita somente ACEITA ou RECUSADA e exige justificativa;
2. bloqueia a linha da transferência com `FOR UPDATE`, impedindo duas decisões concorrentes;
3. exige usuário ativo e vínculo com a área de destino;
4. exige interno ativo;
5. confirma que a localização de origem informada ainda é a localização atual do interno;
6. confirma que área e cela de destino existem e estão ativas;
7. registra uma única aprovação/recusa;
8. em caso de recusa, atualiza apenas o estado da transferência e grava histórico/auditoria, sem alterar localização;
9. em caso de aceite, encerra a localização de origem, cria a localização de destino, atualiza a transferência e grava histórico/auditoria dentro da mesma transação.

Se qualquer etapa falhar, a transação que chamou a função deve ser revertida integralmente.

## Validação realizada

- A função PL/pgSQL foi criada com sucesso em uma branch Neon temporária após a estrutura 001 + 002.
- As migrations-base 001 + 002 foram preparadas e a branch temporária foi descartada sem aplicar alterações na branch permanente.
- A tentativa de executar o roteiro de teste comportamental com dados fictícios foi bloqueada pelas configurações de segurança da ferramenta. Portanto, aceite/recusa ainda precisam de teste de integração com fixture de teste antes de considerar a função aprovada.
- Nenhum dado real foi inserido.
- Nenhuma migration foi aplicada à branch permanente `confere-dev`.

## Pontos que ainda exigem revisão antes de produção

- Definir a política para transferências entre áreas da mesma conta: o requisito funcional permite registro sem aceite externo; a função atual exige vínculo do decisor com a área de destino em todos os casos. A API deve encaminhar o fluxo interno apropriado ou a função deve receber uma regra explícita para essa exceção.
- Validar que o responsável tem permissão específica para decidir, não apenas vínculo à área. A matriz de permissões ainda será detalhada.
- Integrar a atualização/encerramento de movimentação do tipo TRANSFERENCIA, se aplicável ao fluxo final.
- Aplicar role de aplicação de menor privilégio e conceder EXECUTE somente a usuários/serviços autorizados.
- Implementar idempotência de chamadas na API e tratar repetição de requisições.
- Criar testes concorrentes para duas decisões simultâneas, origem já alterada, destino inativo, usuário sem vínculo, recusa sem mudança de localização e rollback em falha de auditoria.

## Atenção

A função é `SECURITY INVOKER` por padrão. Ela não eleva privilégios. A API não deve confiar em `p_usuario_id` enviado livremente pelo cliente: deve derivá-lo da sessão autenticada no servidor.
