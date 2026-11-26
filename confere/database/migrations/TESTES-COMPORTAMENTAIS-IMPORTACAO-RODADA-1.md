# Testes comportamentais isolados — importação PDF e fotografias (rodada 1)

Data: 26/11/2026 (UTC)
Branch GitHub: `feature/confere-pavilhoes`
Projeto Neon: `confere-pavilhoes-dev`
Branch Neon temporária: `mcp-migration-2026-11-26T03-36-48`
Resultado: branch temporária descartada; nenhuma alteração aplicada à branch permanente `confere-dev`.

## Escopo executado

Foram aplicadas somente em branch temporária as migrations 001, 002 e 005, sem comentários SQL que continham ponto e vírgula (a ferramenta de preparação divide o script por ponto e vírgula). Foram inseridos registros exclusivamente sintéticos, com nomes técnicos fictícios e UUIDs de teste. Nenhum dado real foi utilizado.

## Resultados

| Caso | Resultado | Evidência |
|---|---|---|
| Repetir número de página no mesmo lote | BLOQUEADO | Restrição `uq_importacao_pagina`, SQLSTATE 23505 |
| Criar duas fotografias vigentes para a mesma área | BLOQUEADO | Índice único parcial `uq_fotografia_vigente_por_area`, SQLSTATE 23505 |
| Marcar linha como aplicada sem decisão aprovada, responsável e chave idempotente | BLOQUEADO | Check `ck_importacao_linha_aplicacao_coerente`, SQLSTATE 23514 |
| Reutilizar o mesmo `operation_id` em duas linhas | BLOQUEADO | Restrição `uq_importacao_linha_operation`, SQLSTATE 23505 |
| Manter lote sem páginas registradas | PERMITIDO PELO BANCO | Foi possível consultar lote com zero páginas; portanto, completude não é imposta pelo schema |
| Lote continuar apontando para fotografia-base que deixou de ser vigente | PERMITIDO PELO BANCO | Após trocar a fotografia vigente, o lote antigo continuou referenciando a fotografia anterior |

## Conclusões e pendências técnicas

1. As quatro proteções estruturais testadas funcionaram como esperado.
2. A migration 005, sozinha, não impede que um lote sem páginas ou com páginas incompletas seja confirmado como completo. A API deve validar a quantidade total esperada, sequência de páginas, estado de extração, contagens e hashes antes de criar/ativar fotografia ou permitir aplicação.
3. A chave estrangeira de `fotografia_base_id` garante que a fotografia pertence à mesma área, mas não garante que ela ainda seja a fotografia vigente. A API/transação de aplicação deve bloquear a área, reler a fotografia vigente e comparar com a fotografia-base registrada. Se mudou, interromper a aplicação e exigir nova conciliação.
4. A troca da fotografia vigente deve ocorrer na mesma transação que conclui a aplicação do lote, preservando a fotografia anterior como histórica.
5. Estes testes não validam parser real de PDF, OCR, autorização por perfil, concorrência, rollback de aplicação em lote, nem integração HTTP. Não existe ainda serviço de importação implementado para teste ponta a ponta.

## Segurança e limpeza

A branch Neon temporária foi excluída com `apply_changes=false`. A branch permanente `confere-dev` permaneceu sem alterações. Nenhuma alteração foi feita na aplicação CPAIG existente ou na branch `main`.
