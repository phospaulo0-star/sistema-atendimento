# Revisão técnica — Migration 005

**Escopo:** rastreabilidade de páginas, fotografias completas por área e aplicação idempotente por linha.  
**Dependências:** migrations 001 e 002.  
**Status:** proposta versionada e sujeita a validação; não aplicada à branch permanente `confere-dev`.

## Decisões de modelagem

1. `importacao_paginas` registra uma linha por página física, com número sequencial único dentro do lote, estado de extração, quantidade de linhas, hash diagnóstico e erro/alerta.
2. `fotografias_area` guarda o histórico de relações completas aceitas. A restrição única parcial permite apenas uma fotografia vigente por área.
3. A FK composta entre fotografia e importação garante que a fotografia pertença à mesma área do lote.
4. `importacoes.fotografia_base_id` registra a fotografia usada na conciliação. A FK composta impede associar fotografia de outra área. A API deve comparar esse identificador com a fotografia vigente no início da aplicação, sob lock da área.
5. `importacao_linhas` recebe estado de aplicação, instante e `operation_id` único. A constraint impede marcar uma linha como aplicada sem decisão aprovada, usuário, horário e identificador idempotente.
6. A migration não cria função para decidir completude nem para aplicar lote. Essas operações dependem de validação do arquivo, regras de autorização, lock, auditoria e transação integral no serviço. Não há exclusão automática.

## Regras obrigatórias na API

- Um lote só pode ser considerado completo se todas as páginas esperadas estiverem registradas e em estado `PROCESSADA` ou `VAZIA_VALIDADA`, sem lacunas na sequência física, e as verificações estruturais do PDF tiverem passado.
- Uma página `FALHA`, `PENDENTE`, ausente ou duplicada impede candidatos de ausência.
- Uma fotografia só pode ser criada após confirmação técnica e humana de completude e aplicação integral do lote.
- A troca da fotografia vigente e a aplicação de todas as decisões aprovadas devem ocorrer na mesma transação.
- A fotografia anterior deve ser marcada não vigente, nunca apagada.
- A aplicação deve bloquear a área e confirmar que `fotografia_base_id` ainda é a fotografia vigente. Se não for, cancelar a aplicação e exigir nova conciliação.
- A repetição de uma aplicação com o mesmo `operation_id` e mesmo payload deve devolver o resultado original; payload diferente deve ser rejeitado e auditado.
- A linha só recebe `APLICADA` no mesmo commit dos efeitos operacionais e da auditoria.

## Limites e pontos de atenção

- A constraint SQL não prova que o PDF está completo; isso é responsabilidade do validador e da API.
- A unicidade de fotografia vigente protege contra duas fotografias vigentes concorrentes, mas a transação ainda precisa serializar a aplicação por área.
- `hash_conteudo` por página é diagnóstico; `hash_conjunto` identifica a fotografia ordenada e normalizada.
- A tabela de páginas não substitui `importacao_linhas`; as linhas continuam sendo o staging detalhado.
- Não foi definida retenção nem storage dos PDFs originais. O banco guarda metadados e hashes, não bytes do arquivo.
- A migration não altera dados ativos existentes e não insere usuários, internos ou arquivos.

## Testes propostos

1. Duas páginas com mesmo lote/número: rejeitar.
2. Página número zero ou quantidade negativa: rejeitar.
3. Página com falha não pode satisfazer critério de completude na API.
4. Fotografia vinculada a lote de outra área: FK rejeita.
5. Segunda fotografia vigente para mesma área: índice único rejeita.
6. Fotografias históricas não vigentes coexistem na mesma área.
7. Importação com fotografia-base de outra área: FK rejeita.
8. Linha aplicada sem decisão aprovada: CHECK rejeita.
9. Linha aplicada sem instante ou `operation_id`: CHECK rejeita.
10. Repetição do mesmo `operation_id` em outra linha: UNIQUE rejeita.
11. Lote cuja fotografia-base deixou de ser vigente: serviço bloqueia aplicação.
12. Falha de auditoria durante aplicação: rollback de dados, decisões aplicadas e troca de fotografia.
13. PDF incompleto: zero candidatos de ausência e nenhuma fotografia nova.
14. Aplicação repetida com mesmo identificador e payload: resultado idempotente, sem duplicação.

## Validação e implantação

Esta migration deve ser validada em branch Neon temporária derivada de `confere-dev`. A branch temporária será descartada após inspeção. A branch permanente `confere-dev` e o banco do Sistema Atendimento CPAIG não serão alterados nesta etapa.
