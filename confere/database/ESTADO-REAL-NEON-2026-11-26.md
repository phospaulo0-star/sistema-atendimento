# Estado real do Neon — CONFERE DOS PAVILHÕES
**Data da verificação:** 26/11/2026  
**Projeto:** `confere-pavilhoes-dev`  
**Branch Neon:** `confere-dev`  
**Branch GitHub de trabalho:** `feature/confere-pavilhoes`

## 1. Escopo e segurança
Esta verificação foi somente de leitura no Neon. Nenhuma migration foi executada nesta etapa. O projeto Neon é o ambiente dedicado do CONFERE; não foi feita alteração no banco principal do Sistema Atendimento CPAIG nem no serviço Render principal.

## 2. Estado observado no banco
A branch `confere-dev` está disponível e contém o schema `confere`, com 22 tabelas. Foram encontrados objetos das estruturas-base e das migrations de rastreabilidade/completude de importação, incluindo:
- `confere.importacao_paginas`;
- `confere.fotografias_area`;
- `confere.importacao_operacoes`;
- colunas `fotografia_base_id`, `quantidade_paginas_pdf`, `completude_confirmada_em` e `completude_confirmada_por`.

As consultas de contagem realizadas anteriormente nesta branch retornaram zero registros nas tabelas principais consultadas (`areas`, `usuarios`, `internos`, `importacoes`, `importacao_linhas`, `importacao_paginas`, `fotografias_area` e `importacao_operacoes`). Portanto, a estrutura está vazia de cadastros e lotes operacionais nesses conjuntos consultados.

## 3. Migrations 003 e 004
A inspeção dos catálogos PostgreSQL em 26/11/2026 encontrou:
- nenhuma função registrada no schema `confere`;
- nenhum trigger de usuário nas tabelas do schema `confere`.

Isso confirma que os objetos centrais das migrations 003 e 004 não estão instalados nesta branch:
- **003 — proteção de histórico/conferências:** funções `fn_bloquear_alteracao_historico`, `fn_proteger_conferencia_item`, `fn_proteger_conferencia` e seus triggers não foram encontrados.
- **004 — decisão transacional de transferência:** função `fn_decidir_transferencia` não foi encontrada.

Os arquivos SQL existem na branch GitHub:
- `migrations/003-protecao-historico-conferencias.sql`;
- `migrations/004-decisao-transacional-transferencia.sql`.

A migration 003 contém comentários dizendo que não foi aplicada à branch permanente. A migration 004 também está versionada como SQL, mas sua função não existe no banco verificado.

## 4. Migrations de importação
Os objetos observados no banco são compatíveis com as estruturas adicionadas pelas migrations 005 e 006:
- 005: rastreabilidade por página, fotografias por área, fotografia-base e estado/idempotência por linha;
- 006: confirmação de completude do PDF e tabela de operações idempotentes.

A presença dos objetos foi verificada diretamente no catálogo e nas tabelas/colunas. Não foi encontrada, nesta etapa, uma tabela de controle de migrations que permita certificar a ordem histórica exata em que cada arquivo foi executado.

## 5. Próximos passos seguros
1. Não reaplicar 001, 002, 005 ou 006: seus objetos correspondentes já existem e as migrations contêm comandos que podem falhar por duplicidade.
2. Revisar tecnicamente 003 e 004 antes de qualquer aplicação, incluindo compatibilidade dos nomes de colunas e regras de autorização.
3. Preparar uma branch Neon temporária a partir de `confere-dev` para validar 003 e 004 em conjunto, com testes comportamentais e limpeza da branch temporária.
4. Só depois apresentar o plano e solicitar autorização expressa antes de qualquer escrita na branch permanente `confere-dev`.
5. Manter o CONFERE isolado; não integrar ao servidor principal nem ao Render principal nesta fase.

## 6. Limites desta verificação
A confirmação de ausência de funções e triggers é baseada em consultas aos catálogos PostgreSQL. A contagem zero refere-se às tabelas explicitamente consultadas, não a uma afirmação sobre toda e qualquer tabela. A estrutura do banco, por si só, não comprova que a aplicação, autenticação, parser PDF, rotas ou serviço de importação estejam implementados.
