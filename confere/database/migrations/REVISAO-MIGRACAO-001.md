# Migration 001 — estrutura inicial do CONFERE

**Arquivo:** `001-estrutura-inicial-v1.sql`  
**Branch de código:** `feature/confere-pavilhoes`  
**Commit:** `794756f89ac76167548b9ecb1e3ad06b9ea36640`  
**Banco alvo de desenvolvimento:** projeto exclusivo `confere-pavilhoes-dev`, database `neondb`, branch permanente `confere-dev`.

## Estado

- SQL versionado no GitHub para revisão.
- Estrutura equivalente testada em branch temporária Neon em 26/11/2026.
- Resultado do teste: 19 tabelas, 44 índices, 231 restrições e 185 colunas.
- Branch temporária de teste removida após a validação.
- **Não aplicado** na branch permanente `confere-dev`.
- Nenhuma alteração no banco do Sistema Atendimento CPAIG principal.

## Escopo desta migration

Cria o schema `confere` e a estrutura-base de áreas, usuários, escopos de usuário, celas, internos, localizações, importações e staging de linhas, movimentações, transferências e aprovações, conferências e snapshots, plantões, senhas diárias, resumos, eventos, auditoria e operações sincronizadas.

Não insere usuários, senhas, áreas ou dados reais. Não instala extensões. Não cria funções ou triggers.

## Revisões necessárias antes de produção

1. **Seed das oito áreas:** inserir códigos e nomes oficiais em migration separada, com validação das associações A/B/C/D/Virtual.
2. **Auditoria append-only:** restringir UPDATE/DELETE por privilégios e/ou triggers, incluindo estratégia de proprietário/role de migração separada da role da aplicação.
3. **Snapshots imutáveis:** impedir alteração dos itens depois da finalização; definir fluxo formal de retificação com auditoria.
4. **Transferências:** reforçar FKs compostas para garantir que a cela de origem/destino pertence à área indicada; definir atomicidade e aprovação de destino no serviço.
5. **Importações:** área imutável, verificação de PDF completo, hash duplicado por área e bloqueio de candidatos a exclusão quando a extração estiver incompleta.
6. **Senhas diárias:** definir unicidade/precedência da senha por conta ou usuário e política de validade a partir das 08h de Campo Grande.
7. **Permissões:** fechar matriz por perfil e garantir autorização no servidor; JSONB não substitui validação de escopo.
8. **Histórico e reativação:** definir eventos obrigatórios e exigir motivo/responsável em todas as operações sensíveis.
9. **Offline:** validar idempotência também quando o mesmo operation_id reaparece com payload diferente; definir retenção e estados de conflito.
10. **Retenção de PDFs:** destino e prazo de guarda continuam pendentes.

## Importante

O teste da migration valida sintaxe e criação das estruturas no PostgreSQL. Não comprova, sozinho, as regras transacionais, segurança, autorização, imutabilidade, rotina de plantão, extração de PDF ou sincronização offline. Essas regras exigem implementação e testes de integração.

A próxima etapa é revisar e corrigir os pontos acima em migrations incrementais e testes isolados. Não aplicar esta migration na branch permanente sem autorização específica.


## Migration 002 — reforço de integridade

Arquivo: `002-reforco-integridade-v1.sql`  
Commit: `54832e0770dca90f1a613a5822dd1459e500226c`

A migration complementar adiciona:
- correspondência obrigatória entre cada código de área e sua conta (A/B/C/D/Virtual);
- FK composta para garantir que a localização de origem da transferência corresponde à mesma área e cela registradas;
- FKs compostas para garantir que as celas de origem e destino pertencem às áreas informadas;
- uma aprovação registrada por transferência;
- unicidade de hash de PDF dentro da mesma área;
- alvo exclusivo de senha diária (por usuário ou por conta);
- unicidade do início de validade de senha por usuário/conta;
- coerência entre resultado de conferência e identificação/data de quem marcou;
- coerência entre encerramento de movimentação e responsável pelo encerramento.

### Resultado do teste combinado

As migrations 001 + 002 foram executadas em branch Neon temporária isolada:
- 19 tabelas;
- 50 índices;
- 242 restrições;
- 185 colunas.

A branch temporária foi descartada depois da consulta de validação. Nenhuma alteração foi aplicada na branch permanente `confere-dev`.

### Limites que permanecem

As constraints não substituem:
- transação de transferência com bloqueios e validação de status/origem atual;
- autorização do responsável da área de destino;
- trilha append-only protegida por role/permissões;
- bloqueio de edição de conferência finalizada e processo de retificação;
- validação de completude do PDF antes de gerar candidatos a ausência;
- validação de senha diária em toda mutação pela API.

Esses pontos precisam ser implementados e testados na camada de serviço, com desenho específico de permissões do banco. Ainda não foi criada role de aplicação nem concedidos privilégios.
