# Modelo de dados — CONFERE DOS PAVILHÕES (v1 — proposta para revisão)

**Status:** desenho técnico; ainda não aplicado ao Neon.  
**Projeto exclusivo:** `confere-pavilhoes-dev` / branch `confere-dev`.  
**Repositório/branch:** `phospaulo0-star/sistema-atendimento` / `feature/confere-pavilhoes`.

> Este documento descreve uma proposta de modelagem. Não cria tabelas, não executa migrações e não altera o banco do Sistema Atendimento CPAIG.

## 1. Princípios obrigatórios

1. Banco e credenciais exclusivos do CONFERE. A aplicação principal não compartilha tabelas nem conexão.
2. Identidade interna própria: UUID automático, único, permanente e não exibido na tela. Não usar RGI como chave, nem exigir RGI.
3. Nome não é identificador único. Homônimos e nomes semelhantes exigem conferência humana.
4. Histórico é preservado. Exclusão lógica encerra a participação ativa, sem apagar cadastro, localizações ou eventos.
5. Toda ação relevante registra responsável, data/hora, origem e motivo quando aplicável.
6. Datas operacionais são armazenadas como `timestamptz`; apresentação e virada de plantão usam `America/Campo_Grande`.
7. Importações e transferências são processos controlados, auditáveis e transacionais.
8. Operações offline usam identificador idempotente gerado no dispositivo; sincronização só confirma a remoção da fila local após confirmação do servidor.

## 2. Áreas e contas

As áreas são unidades independentes de localização. A conta de acesso pode administrar uma ou mais áreas:

| Conta | Áreas |
|---|---|
| A | Pavilhão A |
| B | Pavilhão B |
| C | Pavilhão C; Disciplinar Risco; Disciplinar |
| D | Pavilhão D; CP |
| Virtual | Pavilhão Virtual |

As três áreas da conta C e as duas áreas da conta D permanecem separadas para listagem, cela, conferência e relatórios. Transferências entre áreas sob a mesma conta podem ser registradas sem aceite externo, mantendo histórico. Entre contas diferentes, exigem aceite do responsável destino.

## 3. Entidades e relações propostas

### 3.1 `areas`

- `id` UUID PK.
- `codigo` texto curto único (ex.: `PAV_A`, `DISC_RISCO`, `CP`).
- `nome` texto.
- `conta_codigo` texto: `A`, `B`, `C`, `D`, `VIRTUAL`.
- `ativa` boolean.
- `created_at`, `updated_at` timestamptz.

Restrição: código único; conta_codigo limitado aos cinco códigos conhecidos. Desativar área não apaga seus dados.

### 3.2 `celas`

- `id` UUID PK.
- `area_id` UUID FK → `areas.id`.
- `codigo` texto (identificação da cela conforme PDF/listagem).
- `ordem_exibicao` inteiro opcional.
- `ativa` boolean.
- `created_at`, `updated_at`.

Restrição única (`area_id`, `codigo`). Uma cela pertence a uma única área. Não reutilizar o mesmo registro de cela em áreas diferentes.

### 3.3 `internos`

- `id` UUID PK, gerado no banco.
- `codigo_interno` UUID NOT NULL UNIQUE DEFAULT `gen_random_uuid()`; identificador técnico permanente, não mostrado na interface.
- `nome_completo` texto NOT NULL.
- `data_entrada` date nullable.
- `procedencia` texto nullable.
- `setor_trabalho` texto nullable.
- `situacao_cadastro` texto controlado: `ATIVO`, `EXCLUIDO` (preferir CHECK ou tabela de domínio).
- `created_at`, `updated_at`, `created_by`, `updated_by`.

Não criar UNIQUE para nome. Não incluir RGI como chave ou campo obrigatório. Mudança de nome deve ser registrada em histórico/auditoria.

### 3.4 `localizacoes`

Histórico temporal da localização do interno.

- `id` UUID PK.
- `interno_id` UUID FK → `internos.id`.
- `area_id` UUID FK → `areas.id`.
- `cela_id` UUID FK → `celas.id`.
- `inicio_em` timestamptz NOT NULL.
- `fim_em` timestamptz nullable.
- `motivo` texto nullable (obrigatório para mudança).
- `responsavel_id` UUID FK → usuário.
- `evento_origem_id` UUID nullable, para ligar à movimentação/transferência.
- `created_at`.

Regras:
- No máximo uma localização atual por interno: índice único parcial em `interno_id WHERE fim_em IS NULL`.
- `celas.area_id` deve corresponder a `localizacoes.area_id`; garantir por validação transacional/trigger ou modelagem de FK composta.
- Ao mudar de cela/área, encerrar a localização anterior e abrir a nova na mesma transação.
- Não atualizar o passado para representar a localização atual.

### 3.5 `usuarios` e permissões

- `id` UUID PK.
- `login` texto NOT NULL UNIQUE.
- `nome_exibicao` texto.
- `senha_hash` texto NOT NULL (hash forte; nunca senha em texto).
- `perfil` texto controlado: administrador, chefe, auxiliar, responsável de área.
- `ativo` boolean.
- `created_at`, `updated_at`, `ultimo_acesso_em`.

Tabela associativa `usuario_areas(usuario_id, area_id, permissao)` com PK composta e FKs. A autorização deve ser verificada no servidor em toda operação, não apenas escondendo botões na tela. O administrador tem escopo global; os demais ficam limitados às áreas autorizadas.

### 3.6 `historico_eventos` e `auditoria`

`historico_eventos` registra fatos de negócio legíveis: inclusão, exclusão, alteração cadastral, mudança de cela, entrada/saída de área, início/fim de ocorrência, aceite/recusa, conferência e fechamento de plantão.

Campos mínimos: `id`, `interno_id` nullable, `area_id` nullable, `tipo_evento`, `ocorrido_em`, `responsavel_id`, `motivo`, `dados_anteriores` JSONB, `dados_novos` JSONB, `referencia_tipo`, `referencia_id`, `idempotency_key` UUID UNIQUE.

`auditoria` é append-only: `id`, `ator_id`, `acao`, `entidade`, `entidade_id`, `ocorrido_em`, `ip`/identificador de dispositivo quando disponível, `correlation_id`, `detalhes` JSONB. A aplicação não deve conceder UPDATE/DELETE a usuários operacionais nessa tabela.

### 3.7 `importacoes` e tabelas de staging

`importacoes`: `id`, `area_id`, `arquivo_nome`, `arquivo_hash` SHA-256, `status` (ANALISANDO, AGUARDANDO_REVISAO, APLICADA, CANCELADA, FALHA), `enviado_por`, `criado_em`, `aplicado_em`, `resumo` JSONB.

`importacao_linhas`: `id`, `importacao_id`, `pagina`, `cela_codigo`, `nome_extraido`, `data_entrada`, `procedencia`, `setor_trabalho`, `status_linha`, `interno_sugerido_id` nullable, `confianca` numeric nullable, `decisao`, `decidido_por`, `decidido_em`, `dados_brutos` JSONB.

A importação nunca escreve diretamente em `internos` antes da revisão. Comparação apresenta inclusão provável, alteração, mudança de cela, possível homônimo e possível ausência. Casos ambíguos não são associados automaticamente. Cancelar staging não altera cadastro ativo. Aplicação de um lote aprovado deve ocorrer em uma transação e produzir histórico/auditoria.

### 3.8 `movimentacoes`

Uma linha por ocorrência independente, permitindo várias ocorrências simultâneas para o mesmo interno.

- `id` UUID PK; `interno_id` FK.
- `tipo` controlado: médico, odontológico, autorização, licença judicial 7 dias, trabalho, evasão, transferência, outra ocorrência.
- `descricao`, `inicio_em`, `fim_em` nullable.
- `status` (ABERTA, ENCERRADA, CANCELADA).
- `area_origem_id`, `area_destino_id` nullable.
- `responsavel_abertura_id`, `responsavel_encerramento_id` nullable.
- `motivo`, `observacao_encerramento` nullable.
- `idempotency_key` UUID UNIQUE; `created_at`, `updated_at`.

Cada ocorrência tem encerramento próprio. Encerrar uma não altera as demais. A movimentação não remove o interno da listagem de sua cela; a interface mostra indicação de situação.

### 3.9 `transferencias` e `transferencias_aprovacoes`

`transferencias`: interno, área/cela de origem, área/cela de destino, solicitante, data/hora, motivo, status (PENDENTE, ACEITA, RECUSADA, CANCELADA), identificador idempotente.

`transferencias_aprovacoes`: transferência, decisão, usuário destino, data/hora e observação.

Transferência entre contas: destino precisa aceitar. Ao aceitar, numa única transação:
1. bloquear a transferência e a localização atual do interno;
2. confirmar que ainda está na origem e que o destino está ativo;
3. encerrar localização de origem;
4. abrir localização de destino;
5. registrar evento e auditoria;
6. marcar transferência como aceita.

Se recusada, não alterar localização. Transferência entre áreas da mesma conta pode seguir fluxo simplificado sem aceite, mas deve registrar origem, destino e responsável.

### 3.10 `conferencias` e `conferencia_itens`

`conferencias`: `id`, `area_id`, `modalidade` (POR_CELA, GERAL), `status` (EM_ANDAMENTO, FINALIZADA, CANCELADA), `iniciada_em`, `finalizada_em`, `responsavel_id`, `observacao`.

`conferencia_itens`: `id`, `conferencia_id`, `interno_id`, `nome_snapshot`, `cela_snapshot`, `area_snapshot`, `resultado` (PENDENTE, CONFERIDO, NAO_LOCALIZADO, OUTRA_SITUACAO), `outra_situacao` nullable, `marcado_por`, `marcado_em`.

No início, criar snapshot dos internos/localizações incluídos. Snapshot não muda se houver transferência, inclusão ou mudança de cela depois do início. Garantir um item por interno em cada conferência. O relatório final calcula totais a partir dos itens do snapshot.

### 3.11 Plantões, senhas e resumos

`plantoes`: início/fim, equipe/identificação do ciclo, status, fechamento e responsável. O período operacional é 08:00 a 08:00 no fuso `America/Campo_Grande`; guardar instantes com fuso e calcular a data operacional explicitamente.

`senhas_diarias`: usuário/conta, hash da senha, início e fim de validade, gerada_em, gerada_por, ativa. Rotação às 08h MS; autenticação verifica validade no servidor. Senha anterior expira mesmo que a sessão permaneça aberta, conforme política a definir. Não registrar senha em logs.

`plantao_resumos`: plantão, escopo/área, resumo JSONB, gerado_em, versão e hash do conteúdo. Resumo é fotografia auditável; não substitui os eventos originais.

## 4. Índices e integridade essenciais

- Índices em todas as FKs usadas em filtros e joins.
- `internos(codigo_interno)` UNIQUE; pesquisa por nome com índice adequado (trigram/GIN somente se extensão for aprovada; inicialmente B-tree normalizado pode bastar).
- `celas(area_id, codigo)` UNIQUE.
- `localizacoes(interno_id) WHERE fim_em IS NULL` UNIQUE.
- `localizacoes(area_id, cela_id, fim_em)`; `movimentacoes(interno_id, status)`; `movimentacoes(area_origem_id, inicio_em)`.
- `importacoes(area_id, criado_em)`; `importacao_linhas(importacao_id, status_linha)`.
- `transferencias(status, criada_em)`; `conferencia_itens(conferencia_id, resultado)`.
- Chaves idempotentes UNIQUE para comandos offline e endpoints de mutação.
- Usar FKs RESTRICT para impedir apagar cadastros históricos; preferir desativação lógica.
- CHECKs para status e datas coerentes (`fim_em >= inicio_em` quando fim_em não nulo).
- Toda mudança multi-tabela deve usar transação; usar bloqueio `SELECT ... FOR UPDATE` quando houver concorrência.

## 5. Regras transacionais e offline

- Uma ação enviada offline leva UUID de operação, dispositivo, horário local informado e payload. O servidor registra horário de recebimento e horário do evento separadamente.
- Repetir a mesma operação não pode duplicar efeitos: chave idempotente UNIQUE e retorno do resultado já registrado.
- Conflitos (ex.: dois operadores mudam a mesma localização) não são resolvidos por “última gravação vence”; entram em fila de conflito para revisão.
- O cliente só remove operação da fila local depois de resposta persistida do servidor.
- IndexedDB guarda dados necessários e fila; Service Worker atende recursos estáticos. Isso ainda precisa ser implementado e testado em aparelhos reais.
- Offline não permite sincronização instantânea entre dispositivos sem rede. Cada dispositivo sincroniza ao reconectar.

## 6. Fechamento de plantão às 08h

Rotina idempotente por plantão:
1. localizar plantão que termina às 08h locais;
2. adquirir trava para impedir fechamento duplicado;
3. gerar resumos por área e resumo geral;
4. listar pendências e ocorrências ainda abertas sem encerrá-las;
5. registrar entradas, exclusões, mudanças de cela, divergências e conferências;
6. persistir resumo e evento de auditoria;
7. abrir o próximo período operacional, sem apagar dados nem bloquear registros atrasados.

A rotina precisa ser executada por agendador confiável no servidor, com proteção contra execução duplicada e recuperação após indisponibilidade. O fuso deve ser aplicado explicitamente.

## 7. Sequência de implementação sugerida

1. Revisar este modelo e fechar decisões pendentes.
2. Preparar migração SQL versionada, ainda sem executar.
3. Revisar SQL, constraints, índices e plano de rollback.
4. Aplicar somente na branch Neon `confere-dev`, após autorização expressa.
5. Criar testes automatizados de isolamento, permissões, homônimos, transações, concorrência e idempotência.
6. Implementar API e interface por etapas; depois validar offline e restauração de backup.

## 8. Pontos que ainda precisam de confirmação funcional

- Se cada PDF diário representa sempre a fotografia completa de uma área ou pode ser parcial.
- Se a cela pode ter códigos repetidos dentro da mesma área ao longo do tempo (o modelo assume código único por área).
- Como tratar interno sem cela definida no PDF (cela nula/área de triagem).
- Se o chefe/auxiliar tem acesso a todas as áreas ou apenas às áreas explicitamente atribuídas.
- Política de sessão após a senha diária expirar às 08h (forçar novo login ou apenas impedir novas ações).
- Quais tipos adicionais de ocorrência devem existir além dos já listados.
- Retenção e destino dos arquivos PDF originais e backups (banco, Object Storage ou armazenamento externo).

**Nenhuma dessas pendências impede revisar a estrutura inicial, mas precisam ser decididas antes de fechar a migração de produção.**
