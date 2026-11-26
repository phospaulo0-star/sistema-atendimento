# Revisão técnica do modelo — CONFERE DOS PAVILHÕES (v1.1)

**Status:** revisão de engenharia/documentação; não é migração SQL e não foi aplicada ao Neon.  
**Ambiente-alvo:** projeto `confere-pavilhoes-dev`, branch `confere-dev`.  
**Código:** branch GitHub `feature/confere-pavilhoes`.

## 1. Correções e decisões estruturais

### 1.1 Oito áreas e cinco contas

A estrutura confirmada possui oito áreas operacionais agrupadas em cinco contas:

1. Pavilhão A — conta A;
2. Pavilhão B — conta B;
3. Pavilhão C — conta C;
4. Disciplinar Risco — conta C;
5. Disciplinar — conta C;
6. Pavilhão D — conta D;
7. CP — conta D;
8. Pavilhão Virtual — conta Virtual.

As áreas agrupadas sob C e D continuam independentes para listagem, cela, conferência, relatórios e localização. Chefe e auxiliar terão acesso às oito áreas. As permissões de ação continuam sujeitas ao perfil e à auditoria.

### 1.2 Identificador do interno

Manter apenas `internos.id UUID PRIMARY KEY DEFAULT gen_random_uuid()` como identificador técnico permanente, invisível na interface e independente de RGI. Não criar outro UUID redundante. Nome não é único; homônimos podem coexistir e nunca serão associados automaticamente apenas pelo nome.

### 1.3 Cela obrigatória e integridade de área

**Decisão confirmada:** não pode existir interno cadastrado em uma área sem cela definida.

- `localizacoes.cela_id` será NOT NULL.
- `celas` terá UNIQUE (`id`, `area_id`).
- `localizacoes` terá FK composta (`cela_id`, `area_id`) → `celas(id, area_id)`.
- Linha de PDF sem cela válida fica em staging como divergência e não cria cadastro ativo até correção humana.

Isso impede localização sem cela e vínculo de cela pertencente a outra área.

### 1.4 Identidade permanente da cela

**Decisão confirmada:** o código identifica sempre a mesma cela dentro do mesmo pavilhão/área. O código de uma cela que deixar de existir não poderá ser reutilizado para identificar outra cela na mesma área. O cadastro da cela deve ser inativado, preservando sua identidade e histórico. A mesma numeração pode existir em áreas diferentes, pois a identidade é contextualizada pela área. Manter UNIQUE (`area_id`, `codigo`) também sobre registros inativos, sem apagar a cela antiga.

### 1.5 Localização atual e histórico

- Índice único parcial em `localizacoes(interno_id) WHERE fim_em IS NULL`.
- Toda mudança encerra a localização anterior e abre a nova na mesma transação.
- Antes de mover, a API bloqueia o registro do interno com `SELECT ... FOR UPDATE`.
- Nunca atualizar o registro histórico para fingir que aquela sempre foi a localização atual.
- FKs históricas usam `ON DELETE RESTRICT`; desativar em vez de apagar.

### 1.6 Exclusão e reativação

- `internos.status_cadastro`: ATIVO ou EXCLUIDO.
- Exclusão exige motivo e responsável, grava histórico e auditoria e encerra localização ativa na mesma transação.
- Não apagar cadastro, movimentações ou histórico.
- **Decisão confirmada:** administrador, chefe e auxiliar podem reativar cadastro excluído.
- Reativação é operação própria, auditada, exige motivo e nova localização/cela válida. Não reabre silenciosamente a localização antiga.

## 2. Entidades e relações propostas

| Entidade | Responsabilidade e relações principais |
|---|---|
| `areas` | UUID, código único, nome, conta (A/B/C/D/VIRTUAL), ativa |
| `celas` | UUID, area_id FK, código, ordem, ativa; UNIQUE (area_id, código) e UNIQUE (id, area_id) |
| `internos` | UUID, nome, data de entrada, procedência, setor de trabalho, status, datas e responsáveis |
| `localizacoes` | interno_id, area_id, cela_id obrigatória, início/fim, motivo, responsável, evento de origem |
| `usuarios` | UUID, login único, nome, hash de senha, perfil, ativo, último acesso |
| `usuario_areas` | associação usuário/área e permissões; chefe e auxiliar abrangem todas as áreas |
| `historico_eventos` | eventos de negócio exibidos na ficha e nos relatórios |
| `auditoria` | trilha técnica append-only: ator, ação, entidade, instante, sessão/dispositivo, correlação e detalhes |
| `importacoes` | área, arquivo, SHA-256, operador, estado, resumo e timestamps |
| `importacao_linhas` | linhas extraídas em staging, dados brutos, sugestão de correspondência, decisão humana |
| `movimentacoes` | ocorrências independentes, com início/fim e responsáveis próprios |
| `transferencias` | origem, destino, interno, solicitante, motivo, estado e idempotência |
| `transferencias_aprovacoes` | decisão, usuário do destino, instante e observação |
| `conferencias` | cabeçalho, área, modalidade, status, início/fim e responsável |
| `conferencia_itens` | snapshot imutável de interno, nome, área, cela e resultado |
| `plantoes` | período 08h–08h no fuso de Campo Grande, equipe e estado |
| `senhas_diarias` | usuário/conta, hash, início/fim de validade, geração e estado |
| `plantao_resumos` | fotografia de resumo por área e período, versão e hash |

### Campos e regras complementares

- `internos`: nome completo NOT NULL; não há UNIQUE em nome; sem campo RGI obrigatório.
- `localizacoes`: `inicio_em` NOT NULL, `fim_em` nullable, `cela_id` NOT NULL.
- `movimentacoes`: uma linha por ocorrência, status ABERTA/ENCERRADA/CANCELADA; múltiplas ocorrências simultâneas permitidas por interno.
- `historico_eventos`: tipo, instante, responsável, motivo, dados anteriores/novos, referência e chave idempotente.
- `auditoria`: append-only; role operacional não recebe UPDATE/DELETE.
- `importacao_linhas`: associação ambígua ou homônimo exige decisão humana.
- `conferencia_itens`: UNIQUE (`conferencia_id, interno_id`); resultado PENDENTE/CONFERIDO/NAO_LOCALIZADO/OUTRA_SITUACAO.

## 3. Constraints, índices e integridade

A futura migration deverá prever:

- PK UUID e FKs explícitas em todas as entidades.
- `ON DELETE RESTRICT` para dados históricos; sem cascatas destrutivas.
- NOT NULL para nome, área, cela, início da localização, status e timestamps indispensáveis.
- CHECKs para status e tipos controlados.
- CHECK `fim_em IS NULL OR fim_em >= inicio_em`.
- UNIQUE (`area_id, codigo`) em celas.
- UNIQUE parcial para uma localização atual por interno.
- UNIQUE (`conferencia_id, interno_id`) em itens de snapshot.
- UNIQUE para chaves idempotentes.
- Índices nas FKs e colunas de filtro por área, cela, status e período.
- Não instalar extensão PostgreSQL sem necessidade comprovada. Busca inicial pode usar índice B-tree sobre nome normalizado; busca aproximada fica para etapa posterior.

## 4. Histórico, auditoria e autorização

Manter duas trilhas separadas:
- **Histórico de negócio:** inclusão, exclusão, alteração, mudança de cela, movimentação, transferência, conferência e fechamento de plantão.
- **Auditoria técnica:** quem executou qual ação, em qual entidade, quando, de qual sessão/dispositivo e com qual identificador de correlação.

Para operações sensíveis, ambas são gravadas na mesma transação da alteração. Se a auditoria falhar, a operação sensível também falha. Não armazenar senha, token, cookie ou URL de conexão em logs ou JSONB. Toda autorização é validada no servidor, inclusive quando a API é chamada diretamente.

## 5. Importação PDF — fluxo seguro

**Decisão confirmada sobre os arquivos:** haverá um PDF individual para cada área, inclusive quando várias áreas estiverem agrupadas na mesma conta. Portanto, serão oito PDFs: A, B, C, Disciplinar Risco, Disciplinar, D, CP e Virtual. Cada arquivo será processado exclusivamente contra a área correspondente; os três PDFs da conta C e os dois PDFs da conta D não serão combinados.

1. Receber PDF e calcular SHA-256 no servidor.
2. Criar importação com área, operador, nome, hash e estado.
3. Extrair linhas para staging; não alterar cadastros/localizações.
4. Validar estrutura e se a importação é completa ou parcial — decisão funcional ainda pendente.
5. Comparar novos, possíveis correspondentes, alterações, mudanças de cela, ausentes e ambiguidades.
6. Homônimos e casos duvidosos exigem decisão humana.
7. Exibir prévia com contagens e mudanças exatas.
8. Ao confirmar, bloquear o lote e aplicar decisões aprovadas em transação.
9. Gravar histórico/auditoria e marcar lote aplicado na mesma transação.
10. Em falha, rollback integral; staging permanece para diagnóstico/cancelamento.

Mesmo arquivo (mesmo hash e área) deve gerar alerta de duplicidade e não ser reaplicado automaticamente. Reimportação intencional exige ação explícita e revisão.

## 6. Transferências e movimentações

Transferência entre contas exige aceite do destino. No aceite:
1. bloquear transferência e cadastro/localização do interno;
2. validar status PENDENTE, origem ainda atual e autorização do destino;
3. validar área/cela de destino ativas e coerentes;
4. encerrar localização de origem e abrir destino;
5. registrar eventos de saída/entrada, aprovação e auditoria;
6. marcar ACEITA; confirmar tudo em uma transação.

Recusa não altera localização. Repetir aceite retorna resultado anterior sem duplicar efeitos. Se duas transferências concorrentes tentarem mover o mesmo interno, apenas uma pode concluir. Transferências entre áreas da mesma conta podem dispensar aceite externo, mas continuam registradas. Movimentações abertas acompanham o interno e não são encerradas automaticamente pela transferência.

## 7. Conferência física — snapshot

Ao iniciar, copiar a relação de internos e localização para itens da conferência: interno_id, nome exibido, área, cela, instante do snapshot e resultado inicial PENDENTE. O relatório não deve reconstruir a lista por JOIN com localização atual. Alterações posteriores não modificam o snapshot. Após finalizar, bloquear alterações; correção excepcional exige autorização, justificativa e auditoria ou retificação separada.

## 8. Offline, idempotência e concorrência

Cada operação offline contém operation_id UUID, device_id não secreto, usuário, horário local declarado, tipo e payload. O servidor guarda operação processada com UNIQUE(operation_id) e resultado original. Reenvio idêntico retorna o resultado já registrado; mesmo ID com payload diferente é rejeitado e auditado.

Não usar “última gravação vence” para localização, exclusão, transferência ou resultado final de conferência. Conflitos vão para revisão explícita. A fila local só marca operação sincronizada após confirmação persistida do servidor. IndexedDB e Service Worker precisam ser implementados e testados; sem rede, dispositivos não sincronizam entre si em tempo real.

## 9. Plantão e horário de Campo Grande

- Guardar instantes em `timestamptz`.
- Calcular períodos usando `America/Campo_Grande`, nunca o fuso presumido do navegador.
- Plantões operam das 08h às 08h.
- Fechamento idempotente, com chave única por período e recuperação se o serviço estiver indisponível às 08h.
- Gerar resumos e pendências; não encerrar automaticamente ocorrências abertas.
- Registrar horário do evento informado offline e horário de recebimento pelo servidor separadamente.

## 10. Senhas diárias e sessões

- Guardar somente hash forte da senha diária.
- Validar no servidor `valid_from <= now() AND now() < valid_until`, no instante correspondente às 08h de Campo Grande.
- Rotação persiste mesmo que o usuário esteja desconectado.
- **Decisão confirmada:** às 08h a sessão não é encerrada. Novas ações ficam bloqueadas até o usuário atualizar/informar a senha diária vigente.
- A tela pode permitir apenas a etapa segura de atualização enquanto bloqueada. Depois da validação, a sessão continua e as ações permitidas pelo perfil são liberadas.
- A API valida a senha vigente em cada mutação; não confiar apenas no bloqueio visual.
- Nunca expor senha em URL, logs ou respostas não autorizadas.

## 11. Backup, restauração e plano de testes

Antes de migration importante: criar ponto de restauração, registrar versão, aplicar apenas no ambiente de desenvolvimento, validar constraints/fluxos e testar restauração isolada. Backup só é válido após teste de restauração. Armazenamento e retenção dos PDFs originais ainda precisam ser decididos.

Testes obrigatórios:
- isolamento das oito áreas e cinco contas;
- chefe e auxiliar acessam todas as áreas, mas só executam ações permitidas ao perfil;
- homônimos coexistem e não são associados automaticamente;
- cela não pode pertencer a outra área;
- toda localização exige cela e um interno não tem duas localizações atuais;
- excluído sai da lista ativa, mas histórico permanece;
- reativação por administrador, chefe ou auxiliar exige motivo e auditoria;
- ocorrências simultâneas são independentes;
- transferência pendente/recusada não muda localização; aceite é atômico;
- reenvio offline não duplica eventos;
- snapshot permanece igual após mudanças;
- conferência finalizada não é editável por usuário comum;
- fechamento de plantão repetido não duplica resumo;
- senha às 08h bloqueia mutações até atualização, sem encerrar sessão;
- falha em transação não deixa dados parciais.

## 12. Decisões funcionais confirmadas

| Tema | Decisão |
|---|---|
| Interno sem cela | Não permitido; toda localização exige cela definida |
| Acesso de chefe e auxiliar | Acesso às oito áreas |
| Senha diária às 08h | Sessão permanece; ações bloqueadas até atualizar/informar a senha vigente |
| Reativação de excluído | Administrador, chefe e auxiliar podem reativar, com motivo e auditoria |
| Identidade da cela | Código é permanente dentro da área; não pode ser reutilizado após inativação |
| PDFs de importação | Um PDF separado para cada uma das oito áreas, mesmo nas contas agrupadas |

## 13. Pendências funcionais antes da migration

1. PDF de cada área: representa sempre a relação completa daquela área ou pode ser parcial?
2. Quais tipos adicionais de ocorrência devem existir além dos já listados?
3. Onde guardar o PDF original e por quanto tempo?

**Limite desta etapa:** nenhuma tabela, extensão, role adicional ou migration foi criada/aplicada. Este documento é revisão técnica para aprovação antes de gerar SQL.
