# CONFERE DOS PAVILHÕES — Contrato transacional de aplicação de importação (v1)

**Status:** especificação para implementação; não é migration nem código de produção.  
**Branch:** `feature/confere-pavilhoes`  
**Dependências:** migrations 001, 002 e 005; fluxo de importação PDF v1; validação de PDF completo v1.  
**Objetivo:** definir uma única operação atômica para aplicar decisões aprovadas de um lote, atualizar a fotografia vigente da área e preservar histórico.

## 1. Regra central

A aplicação de um lote é uma única transação PostgreSQL. Ou todas as decisões aprovadas, os eventos de histórico, a auditoria, os marcadores de idempotência e a troca da fotografia vigente são confirmados juntos, ou nada disso é confirmado.

Não pode existir:
- lote marcado como aplicado com apenas parte das linhas aplicadas;
- fotografia vigente atualizada antes dos cadastros;
- cadastro alterado sem evento de histórico e auditoria;
- ausência aplicada automaticamente;
- lote conciliado contra uma fotografia que já deixou de ser vigente;
- aplicação de lote incompleto, cancelado, com falha ou ainda em revisão.

## 2. Pré-condições verificadas no servidor

Antes de abrir a transação, a API deve autenticar a sessão e validar a senha diária. Dentro da transação, deve revalidar tudo que possa mudar durante a operação:

1. O usuário está ativo.
2. O perfil é Responsável de área.
3. O usuário continua vinculado à área do lote.
4. O lote pertence à área solicitada.
5. O lote está em `AGUARDANDO_REVISAO` e teve completude confirmada.
6. Todas as páginas esperadas estão registradas e processadas; não há página pendente ou com falha.
7. O hash e a fotografia-base foram registrados no lote.
8. O lote foi conciliado contra a fotografia atualmente vigente daquela área.
9. Todas as linhas que exigem decisão estão resolvidas; não há homônimo ou divergência crítica pendente.
10. Toda decisão de exclusão lógica tem justificativa não vazia.
11. O identificador idempotente e o hash do payload foram recebidos e validados.

O ator, perfil, vínculo de área e instante da operação devem vir do servidor. Não aceitar essas informações como autoridade do navegador.

## 3. Ordem obrigatória de bloqueios

Usar transação com isolamento adequado e bloqueio pessimista por área. Ordem única para todas as rotas que alterem a fotografia:

1. Bloquear a linha da área com `SELECT ... FROM confere.areas WHERE id = $area_id FOR UPDATE`.
2. Bloquear o lote com `SELECT ... FROM confere.importacoes WHERE id = $batch_id FOR UPDATE`.
3. Verificar a sessão/perfil/vínculo e estado do lote.
4. Ler a fotografia vigente da área.
5. Comparar o ID da fotografia vigente com `importacoes.fotografia_base_id`.
6. Bloquear as linhas de staging que serão aplicadas em ordem determinística (por ID).
7. Bloquear os internos/localizações afetados em ordem determinística para reduzir deadlocks.
8. Validar novamente os valores atuais que serão alterados.
9. Aplicar as operações.
10. Atualizar a fotografia vigente e o estado do lote por último.
11. Confirmar a transação.

Todas as rotas que publicam uma nova fotografia precisam bloquear primeiro a mesma linha de `areas`. Não misturar ordem de bloqueios entre endpoints.

## 4. Verificação da fotografia-base (anti-lote-obsoleto)

A fotografia-base não é apenas uma referência histórica. Ela representa a versão exata contra a qual o Responsável tomou as decisões.

Regra:

- Se a área ainda não possui fotografia vigente, o lote só pode ser o primeiro lote inicial, com `fotografia_base_id IS NULL` e fluxo específico de inicialização aprovado.
- Se existe fotografia vigente, o lote deve apontar exatamente para ela.
- Se o ID atual for diferente do ID gravado no lote, abortar a transação com erro de conflito (HTTP 409 na API), sem modificar cadastro, histórico, fotografia ou estado do lote.
- A API deve exigir nova conciliação e revisão contra a fotografia mais recente.

Não basta verificar `fotografia_base_id` por FK: a FK garante a área, não a atualidade da fotografia.

## 5. Validação da completude antes de qualquer mutação operacional

A validação deve ocorrer antes de processar inclusões, alterações, mudanças de cela ou exclusões.

No mínimo:
- quantidade real de páginas do PDF registrada no lote;
- exatamente uma linha em `importacao_paginas` por página física;
- sequência física sem lacunas ou duplicações;
- todas as páginas em estado `PROCESSADA` ou `VAZIA_VALIDADA`;
- nenhuma página em `PENDENTE` ou `FALHA`;
- hash de cada página presente quando aplicável;
- contagem de linhas reconciliada com os dados extraídos;
- validação de paginação impressa quando o PDF a possuir;
- confirmação explícita de completude pelo operador;
- nenhum erro crítico de parser/OCR ou linha inválida não resolvida.

A tabela atual de páginas não registra, isoladamente, todos os metadados do PDF (por exemplo, total físico declarado pelo parser e confirmação do operador). A API deverá manter esses valores em metadados de lote validados ou será necessária migration adicional após revisão. Não inventar o total esperado quando o PDF não tiver paginação confiável.

**Falha em qualquer condição:** rejeitar a aplicação e manter a fotografia vigente e os dados ativos intactos.

## 6. Idempotência e repetição segura

A API deve aceitar um `operation_id` único por solicitação lógica e calcular um hash canônico do payload no servidor.

- Primeira chamada: registra a operação e processa.
- Repetição do mesmo `operation_id` e mesmo hash após commit: retorna o resultado original sem repetir efeitos.
- Mesmo `operation_id` com hash diferente: rejeitar como conflito e registrar evento de segurança.
- Falha/rollback antes do commit: não deixar operação marcada como concluída.
- Não gerar um novo `operation_id` automaticamente ao repetir a mesma requisição do cliente.

A unicidade de `importacao_linhas.operation_id` evita duplicação por linha, mas não substitui a idempotência do comando de aplicação do lote. Avaliar uma tabela própria de operações de importação ou reutilizar `operacoes_sincronizadas` com semântica formal definida.

## 7. Aplicação por tipo de decisão

Executar somente linhas aprovadas e ainda não aplicadas.

| Decisão | Operação exigida |
|---|---|
| INCLUIR | Criar `internos`, localização inicial e evento/auditoria |
| ATUALIZAR | Atualizar somente campos autorizados; registrar antes/depois |
| MOVER | Encerrar localização atual e abrir localização na cela aprovada; registrar antes/depois |
| EXCLUIR | Exclusão lógica; preservar cadastro, localizações e histórico; motivo obrigatório |
| VINCULAR | Associar linha ao UUID escolhido após decisão humana; não criar duplicata |
| IGNORAR | Registrar decisão e motivo quando necessário; não alterar cadastro/localização |

`POSSIVEL_AUSENCIA` não é uma decisão automática. Só pode ser convertida em exclusão lógica por decisão humana explícita do Responsável, com motivo obrigatório. Se a decisão permanecer pendente, o lote não pode ser aplicado.

A aplicação deve verificar que o interno ainda está na situação/cela esperada pela revisão. Se mudou depois da conciliação, abortar ou devolver a linha para revisão, sem sobrescrever a movimentação mais recente.

## 8. Histórico e auditoria dentro da mesma transação

Para cada mutação operacional, inserir:
- evento em `historico_eventos`;
- registro em `auditoria`;
- ator autenticado;
- área;
- instante do servidor;
- tipo de evento;
- referência ao lote e à linha;
- motivo;
- valores anteriores e novos, sem incluir senhas, tokens ou segredos;
- `operation_id` estável.

Se qualquer inserção de histórico/auditoria falhar, a transação inteira deve sofrer rollback.

## 9. Publicação da nova fotografia

A nova fotografia representa o conjunto validado e efetivamente aplicado, não apenas o PDF recebido.

Dentro da mesma transação, depois de aplicar todas as decisões:
1. Confirmar que todas as linhas obrigatórias estão aplicadas ou explicitamente ignoradas/rejeitadas conforme regra aprovada.
2. Marcar fotografia anterior como `vigente = false` (se existir).
3. Criar fotografia nova vinculada ao lote, com contagens e hash do conjunto.
4. Atualizar status do lote para `APLICADA` e `aplicado_em`.
5. Inserir evento de auditoria da publicação da fotografia.
6. Commit.

O índice único parcial `uq_fotografia_vigente_por_area` é uma última barreira contra duas fotografias vigentes. Ele não substitui o bloqueio da área nem garante, sozinho, que a fotografia nova corresponda a um lote completo.

Se a criação da nova fotografia falhar, o rollback deve restaurar a fotografia anterior como vigente e desfazer todas as alterações operacionais do lote.

## 10. Pseudocódigo de referência (não executável)

```text
applyApprovedImport(session, batchId, operationId, payload):
    actor = authenticate(session)
    assertDailyPassword(actor)

    payloadHash = canonicalHash(payload)

    BEGIN TRANSACTION

    lockArea(batch.area_id)
    lockBatch(batchId)

    priorOperation = findOperation(operationId)
    if priorOperation exists:
        if priorOperation.payloadHash != payloadHash:
            ROLLBACK; return conflict
        if priorOperation.status == COMPLETED:
            COMMIT; return priorOperation.result

    assert actor active
    assert actor role == RESPONSAVEL_AREA
    assert actor linked to batch.area_id
    assert batch.status == AGUARDANDO_REVISAO
    assert batch completeness confirmed
    assert every expected page processed
    assert no unresolved blocking line
    assert exclusion decisions have reasons

    currentPhoto = lockCurrentPhoto(batch.area_id)
    assert currentPhoto.id == batch.fotografia_base_id
        else ROLLBACK; return stale-base conflict

    lockAffectedLinesAndInternalsInStableOrder()
    revalidateCurrentInternLocations()

    register operation as PROCESSING

    for each approved line in stable order:
        apply one approved decision
        write history event
        write audit event
        mark line applied with operation id

    assert all required lines resolved

    set old current photo to not current
    insert new current photo for this batch
    set batch status = APLICADA
    set batch applied timestamp
    mark operation COMPLETED with response

    COMMIT
    return response
```

A implementação deve usar parâmetros SQL, não concatenar valores do usuário. A autenticação e autorização continuam sendo verificadas no backend; não confiar apenas em constraints do banco.

## 11. Matriz de testes para a implementação

| ID | Cenário | Resultado obrigatório |
|---|---|---|
| TX-01 | Lote completo, fotografia-base atual, todas decisões válidas | Commit integral |
| TX-02 | Lote sem páginas ou com uma página pendente | Bloquear antes de qualquer mutação |
| TX-03 | Uma página com falha | Bloquear; sem ausência |
| TX-04 | Fotografia-base diferente da vigente | Conflito 409; sem mutação |
| TX-05 | Outro lote publica fotografia enquanto este aguarda | Este lote bloqueia ao revalidar base |
| TX-06 | Duas aplicações simultâneas na mesma área | Serialização pelo lock da área |
| TX-07 | Duas chamadas simultâneas do mesmo operation_id | Uma execução; outra retorna mesmo resultado |
| TX-08 | Mesmo operation_id com payload diferente | Rejeitar |
| TX-09 | Falha após primeira de várias linhas | Rollback de todas |
| TX-10 | Falha ao inserir auditoria | Rollback de todas |
| TX-11 | Falha ao inserir fotografia nova | Rollback e fotografia anterior continua vigente |
| TX-12 | Linha de ausência sem decisão humana | Bloquear lote |
| TX-13 | Exclusão sem motivo | Bloquear lote |
| TX-14 | Interno mudou de cela depois da conciliação | Bloquear/revisar; não sobrescrever |
| TX-15 | Responsável sem vínculo com a área | Negar, mesmo com ID de lote conhecido |
| TX-16 | Chefe/Auxiliar tenta aplicar sem permissão formal | Negar por padrão |
| TX-17 | Administrador tenta aplicar sem permissão formal | Negar por padrão |
| TX-18 | Requisição repetida após commit | Retornar resultado original sem duplicar eventos |
| TX-19 | Lote cancelado | Bloquear |
| TX-20 | Lote incompleto tenta publicar fotografia | Bloquear |

## 12. Limitações conhecidas do modelo atual

Antes de implementar, revisar estes pontos:
- A tabela `importacoes` não tem ainda um campo formal de confirmação humana de completude e seu ator/horário.
- O estado atual de lote não contém todos os estados do fluxo especificado (por exemplo, `VALIDANDO`, `INCOMPLETA`, `AGUARDANDO_CONFIRMACAO_COMPLETUDE`); uma migration pode ser necessária.
- A migration 005 cria rastreabilidade de páginas, mas não cria função de validação de completude nem serviço de aplicação.
- `operation_id` em `importacao_linhas` é por linha; é necessário formalizar idempotência do comando do lote.
- A matriz de permissão ainda não autoriza Chefe, Auxiliar ou Administrador a aprovar/aplicar por presunção.
- A estratégia de armazenamento e retenção do PDF original permanece pendente.

## 13. Limite desta entrega

Este documento não altera o schema, não cria funções SQL e não implementa endpoints. É o contrato técnico para orientar a implementação segura na API e os testes de integração. Qualquer migration futura será validada primeiro em branch temporária do Neon; a branch permanente `confere-dev` não será alterada sem aprovação específica.
