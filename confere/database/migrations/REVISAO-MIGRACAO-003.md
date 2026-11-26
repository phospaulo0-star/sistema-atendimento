# CONFERE DOS PAVILHÕES — Revisão da migration 003

## Objetivo

Adicionar proteções no banco para impedir alteração ou exclusão de registros de auditoria/histórico e preservar o snapshot de conferências.

## Arquivo versionado

`confere/database/migrations/003-protecao-historico-conferencias.sql`

Commit: `01b7962f306efbebe1a5155709f72a8d48f18383`

## Proteções implementadas

- `auditoria`: bloqueia UPDATE e DELETE.
- `historico_eventos`: bloqueia UPDATE e DELETE.
- `conferencia_itens`: bloqueia DELETE; impede alteração da identidade do item e dos campos de snapshot; permite marcar/atualizar resultado somente enquanto a conferência estiver EM_ANDAMENTO.
- `conferencias`: bloqueia DELETE; impede alteração dos parâmetros de identidade; impede qualquer nova alteração depois de FINALIZADA ou CANCELADA.

O trigger dos itens bloqueia a linha da conferência com `FOR UPDATE` antes de aceitar uma marcação, para serializar a marcação com a operação de finalização.

## Teste isolado

As migrations 001 e 002 foram preparadas em branch temporária. Na mesma branch foram criadas as funções e triggers da migration 003 por transação SQL, pois o preparador de migrations divide o conteúdo por ponto e vírgula e não é adequado para corpos PL/pgSQL.

Consulta de catálogo confirmou:
- 4 triggers de proteção;
- 3 funções PL/pgSQL;
- estrutura-base com 19 tabelas, 50 índices, 242 restrições e 185 colunas.

A branch temporária foi removida após os testes. Nenhuma alteração foi aplicada à branch permanente `confere-dev`.

## Limitações e próximos testes

- A proteção é voltada ao uso normal da aplicação; o proprietário do banco e superusuários ainda podem desabilitar triggers. Antes de produção, separar role proprietária/migration da role da aplicação e conceder somente os privilégios necessários.
- Testar com dados fictícios que UPDATE/DELETE em auditoria e histórico falham.
- Testar que snapshot não pode ser alterado e que itens só podem ser marcados durante conferência aberta.
- A finalização precisa ocorrer em transação na API, validando que todos os itens foram tratados e gravando o resumo final.
- Retificações devem gerar novo registro auditado, nunca editar o resultado final original.
- A autorização por perfil/área e a validação da senha diária permanecem responsabilidade da API, com defesa adicional no banco quando a matriz de permissões estiver fechada.
