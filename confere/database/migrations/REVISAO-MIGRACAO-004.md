# CONFERE DOS PAVILHÕES — Revisão da migration 004

## Objetivo

Centralizar a decisão transacional de transferências, distinguindo movimentações entre áreas da mesma conta e transferências entre contas distintas.

## Regra funcional confirmada em 26/11/2026

- **Mesma conta (ex.: Pavilhão C → Disciplinar Risco; Pavilhão D → CP):** o Responsável ativo da área de origem pode efetivar diretamente. Não há espera nem aceite do destino.
- **Contas diferentes (ex.: C → D):** continua obrigatório o aceite do Responsável ativo vinculado à área de destino.
- Nos dois fluxos, o servidor valida perfil, vínculo e estado atual; registra histórico e auditoria. O aceite direto da mesma conta não cria uma aprovação fictícia do destino.

## Arquivo versionado

`confere/database/migrations/004-decisao-transacional-transferencia.sql`

A função `confere.fn_decidir_transferencia` é `SECURITY INVOKER`; a API deverá derivar `p_usuario_id` da sessão autenticada, nunca aceitar esse identificador livremente do navegador.

## Validações em branch Neon temporária

Branch: `confere-teste-transferencia-mesma-conta-20261126` (criada a partir de `confere-dev`; somente fixtures sintéticas).

1. **Mesmo grupo C:** Responsável vinculado somente ao Pavilhão C efetivou transferência para Disciplinar Risco; resultado `ACEITA`, localização de origem encerrada, nova localização criada e **zero aprovações formais de destino**.
2. **Bloqueio de origem em transferência entre contas:** Responsável de C tentou transferir para Pavilhão D; operação foi rejeitada por falta de vínculo com a área de destino.
3. **Aceite entre contas:** Responsável vinculado ao Pavilhão D aceitou; resultado `ACEITA`, origem encerrada, nova localização criada e uma aprovação formal registrada.

Os três comportamentos foram executados em uma única transação de teste, com nomes e identificadores fictícios. Nenhum registro foi inserido na branch permanente. Os testes não cobrem concorrência real, integração HTTP/API, autenticação, permissões finais da role de runtime nem encerramento de movimentação do tipo TRANSFERENCIA.

## Pontos restantes antes de produção

- Completar a matriz de permissões e validar autorização por sessão no backend.
- Criar role de aplicação de menor privilégio e conceder somente permissões necessárias; não usar `confere_owner` como role de runtime.
- Testar concorrência, falha de auditoria/rollback, usuário inativo, origem já alterada e destino inativo.
- Definir e implementar a relação com `movimentacoes` do tipo TRANSFERENCIA, se esse registro fizer parte do fluxo operacional final.
- Confirmar idempotência da chamada na API.

## Estado do banco permanente

Nenhuma alteração foi aplicada à branch permanente `confere-dev` nesta rodada. A alteração está versionada no GitHub para revisão; aplicação no banco permanente depende de autorização específica.
