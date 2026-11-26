# Modelo relacional e regras transacionais — CONFERE DOS PAVILHÕES (v2)

**Status:** especificação técnica para revisão. Não é migration SQL e não foi aplicada ao Neon.  
**Banco exclusivo:** projeto `confere-pavilhoes-dev`, branch `confere-dev`.  
**Código:** GitHub `feature/confere-pavilhoes`.  
**Regra de segurança:** nenhuma conexão, tabela ou credencial do Sistema Atendimento CPAIG principal será reutilizada.

## 1. Decisões funcionais consolidadas

### 1.1 Áreas, contas e PDFs

Existem cinco contas de acesso e oito áreas independentes:

| Conta | Área | PDF próprio |
|---|---|---|
| A | Pavilhão A | 1 |
| B | Pavilhão B | 1 |
| C | Pavilhão C | 1 |
| C | Disciplinar Risco | 1 |
| C | Disciplinar | 1 |
| D | Pavilhão D | 1 |
| D | CP | 1 |
| Virtual | Pavilhão Virtual | 1 |

Cada PDF é individual e sempre contém a relação completa e atualizada da respectiva área. Não combinar PDFs de áreas diferentes, mesmo quando pertencem à mesma conta. Cada importação é vinculada a exatamente uma área.

A ausência de um interno no PDF completo é uma divergência/candidato a exclusão, nunca exclusão automática. O operador revisa e confirma individualmente ou em lote, conforme a interface permitir, com trilha de auditoria.

### 1.2 Identidade do interno

- Uma única chave técnica: `internos.id UUID PRIMARY KEY DEFAULT gen_random_uuid()`.
- UUID invisível na interface, permanente e independente de RGI.
- Não criar coluna `codigo_interno` UUID redundante.
- Nome não é único. Homônimos podem coexistir.
- Correspondência de PDF não pode ser decidida somente pelo nome quando houver ambiguidade.

### 1.3 Identidade permanente da cela

O código identifica sempre a mesma cela dentro da mesma área/pavilhão. Se a cela deixar de existir, seu registro será inativado, preservando histórico, e o código não poderá ser reutilizado para outra cela naquela área. A mesma numeração pode existir em áreas diferentes.

Consequências:
- unicidade de `(area_id, codigo_normalizado)` inclui também celas inativas;
- inativar não apaga nem libera o código;
- uma localização sempre referencia a identidade UUID da cela;
- se houver mudança oficial de identificação, tratar como alteração controlada com histórico, não como reaproveitamento silencioso.

### 1.4 Localização e cela obrigatória

Nenhum interno pode permanecer cadastrado/ativo em uma área sem cela definida. Toda localização ativa exige área e cela válidas pertencentes à mesma área. Linhas PDF sem cela válida ficam em staging como divergência e não criam/alteram localização ativa até correção humana.

### 1.5 Exclusão e reativação

Exclusão é lógica, exige motivo e responsável, remove o interno da listagem ativa e preserva ficha, localizações, movimentações e eventos. Administrador, Chefe, Auxiliar e Responsável de área podem excluir internamente (exclusão lógica) e reativar, sempre com motivo, responsável, data/hora e auditoria. O Responsável de área só pode executar exclusão e reativação dentro das áreas vinculadas à sua conta. Reativação exige localização/cela válida e não reabre automaticamente uma localização histórica.

O Responsável de área também pode incluir manualmente um interno em uma cela sob sua responsabilidade. Na inclusão inicial, somente o nome do interno e a cela são obrigatórios; `data_entrada`, `procedencia` e `setor_trabalho` podem ficar NULL/pendentes até a próxima importação do PDF completo daquela área. A inclusão manual deve registrar `created_by`, instante, área/cela e evento de histórico/auditoria. A importação posterior deve completar/atualizar o cadastro existente, sem duplicá-lo; correspondência por nome ambígua ou homônimo exige revisão humana. A autorização é validada no servidor contra o vínculo do Responsável com a área e a cela deve pertencer à área autorizada.

### 1.6 Senha diária e sessão

Na virada das 08h de Campo Grande, a sessão continua aberta, mas novas mutações ficam bloqueadas até informar/atualizar a senha diária vigente. A API valida a senha vigente em cada mutação. Depois de validada, a sessão continua sem novo login. O bloqueio visual não substitui validação no servidor.

### 1.7 Acesso

Chefe e auxiliar podem consultar as oito áreas. As ações disponíveis dependem do perfil e são autorizadas no servidor. Contas A, B, C, D e Virtual ficam limitadas às respectivas áreas. A conta C possui três áreas independentes; D possui duas.

## 2. Modelo relacional proposto

Os nomes abaixo são nomes lógicos propostos. Tipos, nomes finais e SQL serão fechados em migration separada, após revisão.

### 2.1 Estrutura organizacional

**`areas`**
- `id` UUID PK.
- `codigo` TEXT NOT NULL UNIQUE — valores controlados para as oito áreas.
- `nome` TEXT NOT NULL.
- `conta_codigo` TEXT NOT NULL — A, B, C, D ou VIRTUAL.
- `ativa` BOOLEAN NOT NULL DEFAULT TRUE.
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL.

**`celas`**
- `id` UUID PK.
- `area_id` UUID NOT NULL FK `areas`.
- `codigo` TEXT NOT NULL.
- `codigo_normalizado` TEXT NOT NULL.
- `ordem_exibicao` INTEGER NULL.
- `ativa` BOOLEAN NOT NULL DEFAULT TRUE.
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL.
- UNIQUE (`area_id`, `codigo_normalizado`) sem filtro por ativa: o número não é reutilizável dentro da área.
- UNIQUE (`id`, `area_id`) para suportar FK composta de localização.

### 2.2 Cadastro e localização dos internos

**`internos`**
- `id` UUID PK DEFAULT `gen_random_uuid()`.
- `nome_completo` TEXT NOT NULL.
- `data_entrada` DATE NULL.
- `procedencia` TEXT NULL.
- `setor_trabalho` TEXT NULL.
- `status_cadastro` TEXT NOT NULL CHECK em ATIVO/EXCLUIDO.
- `created_at`, `updated_at` TIMESTAMPTZ NOT NULL.
- `created_by`, `updated_by` UUID FK usuários.
- Sem UNIQUE em nome; sem RGI como chave.
- Inclusão manual por Responsável de área: nome obrigatório; dados do PDF (`data_entrada`, `procedencia`, `setor_trabalho`) aceitam NULL até a próxima importação. Registrar usuário e instante da inclusão.

**`localizacoes`**
- `id` UUID PK.
- `interno_id` UUID NOT NULL FK `internos`.
- `area_id` UUID NOT NULL FK `areas`.
- `cela_id` UUID NOT NULL.
- `inicio_em` TIMESTAMPTZ NOT NULL.
- `fim_em` TIMESTAMPTZ NULL.
- `motivo` TEXT NULL; obrigatório nas mudanças.
- `responsavel_id` UUID NOT NULL FK `usuarios`.
- `evento_origem_id` UUID NULL.
- FK composta (`cela_id`, `area_id`) → `celas(id, area_id)`.
- CHECK (`fim_em IS NULL OR fim_em >= inicio_em`).
- Índice único parcial: no máximo uma localização atual por interno (`interno_id WHERE fim_em IS NULL`).
- Índice para consultas por área/cela/período.

Uma inclusão manual cria o cadastro do interno e sua localização inicial na cela indicada na mesma transação; exige nome e cela, permite dados complementares pendentes e registra histórico/auditoria. Uma mudança de cela ou área encerra a localização anterior e cria a nova na mesma transação. Não editar localização antiga para simular o passado.

### 2.3 Usuários e autorização

**`usuarios`**
- `id` UUID PK; `login` TEXT UNIQUE NOT NULL; `nome_exibicao` TEXT NOT NULL.
- `senha_hash` TEXT NOT NULL; `perfil` controlado; `ativo` BOOLEAN NOT NULL.
- timestamps e último acesso.

**`usuario_areas`**
- `usuario_id` UUID FK; `area_id` UUID FK; `permissoes`/escopo de ação.
- PK composta (`usuario_id`, `area_id`).
- Atribuições do chefe/auxiliar cobrem as oito áreas, sem conceder ações além do perfil.
- Administrador possui escopo global conforme matriz de permissões.

A autorização é verificada em toda rota da API. Não confiar em botões ocultos ou em filtros enviados pelo navegador.

### 2.4 Eventos, histórico e auditoria

**`historico_eventos`** — fatos operacionais legíveis:
- `id` UUID PK; `interno_id` nullable; `area_id` nullable.
- `tipo_evento`, `ocorrido_em`, `responsavel_id`, `motivo`.
- `dados_anteriores` JSONB, `dados_novos` JSONB.
- referência à entidade de origem e `operation_id` UUID UNIQUE quando originado de comando sincronizável.

**`auditoria`** — trilha técnica append-only:
- `id` UUID PK; ator, ação, entidade, entidade_id, instante.
- `device_id`/sessão/correlation_id quando disponíveis.
- detalhes JSONB sanitizados.
- Papel operacional não recebe UPDATE/DELETE. Não registrar senha, hash de senha, cookie, token ou URL de conexão.
- Evento de negócio e auditoria da mutação são gravados na mesma transação.

### 2.5 Importação completa por PDF

**`importacoes`**
- `id` UUID PK; `area_id` NOT NULL FK; nome original; SHA-256; tamanho; operador.
- status: RECEBIDA, EXTRAINDO, AGUARDANDO_REVISAO, APLICANDO, APLICADA, CANCELADA ou FALHA.
- timestamps, resumo e versão do extrator.
- A área é obrigatória e imutável após criação.

**`importacao_linhas`**
- `id` UUID PK; `importacao_id` FK; página/ordem; cela extraída; nome e campos extraídos.
- dados brutos JSONB; candidato `interno_id` nullable; tipo de divergência; decisão; responsável e instante da decisão.
- Linhas sem cela existente/ativa ou com dados insuficientes permanecem como divergência.
- Correspondência ambígua/homônimo exige decisão humana.

**Autorização para envio e aprovação:** Responsável de área pode enviar/iniciar importação somente para sua área vinculada; Chefe e Auxiliar podem enviar/iniciar importação para qualquer uma das oito áreas. A permissão do Administrador para enviar/iniciar o lote permanece pendente. O envio/início não aprova divergências: Responsável de área aprova inclusões, alterações e exclusões propostas somente na própria área, com revisão, motivo obrigatório para exclusões e auditoria.

**Fluxo de importação**
1. Receber o PDF destinado a uma única área; validar tipo, tamanho e integridade; calcular SHA-256.
2. Criar lote e extrair todas as páginas/linhas para staging, sem tocar nos cadastros ativos.
3. Validar que o arquivo representa a relação completa daquela área e que há dados suficientes para uma comparação confiável.
4. Comparar a fotografia recebida com os internos ativos e suas localizações atuais na mesma área.
5. Apresentar inclusão, alteração cadastral, mudança de cela, possível homônimo, linha inválida e interno ausente do PDF.
6. Ausência é candidata a exclusão; nunca excluir automaticamente. Exigir confirmação e motivo.
7. O Responsável de área pode revisar e aprovar as inclusões, alterações e exclusões propostas para a própria área, desde que esteja vinculado a ela. Ambiguidades e homônimos exigem decisão humana explícita; linhas inválidas devem ser corrigidas antes da aplicação. A aprovação registra usuário, data/hora e decisões por linha.
8. Aplicar lote aprovado numa transação: bloquear lote, validar novamente o estado atual e a autorização do aprovador, executar somente as decisões confirmadas, gravar eventos/auditoria e marcar lote aplicado. Exclusões confirmadas exigem motivo obrigatório.
9. Se qualquer etapa transacional falhar, rollback integral. O staging permanece para diagnóstico.
10. Repetição do mesmo SHA-256 na mesma área gera alerta e não reaplica automaticamente. Reprocessamento intencional exige comando explícito e nova revisão.

A importação completa só pode propor ausência/exclusão quando a extração foi validada como completa. PDF truncado, ilegível ou parcialmente extraído deve falhar na validação e não produzir candidatos de exclusão.

### 2.6 Movimentações independentes

**`movimentacoes`**
- `id` UUID PK; `interno_id` FK; tipo controlado; descrição.
- `inicio_em`, `fim_em`; status ABERTA/ENCERRADA/CANCELADA.
- responsáveis de abertura/encerramento; motivo e observação.
- operation_id UUID UNIQUE.
- Permitir várias ocorrências abertas por interno. Cada uma encerra apenas a própria linha.
- O interno continua aparecendo em sua cela/localização, com indicador visual da ocorrência.

### 2.7 Transferências entre áreas

**`transferencias`**
- `id` UUID PK; interno; localização/área/cela de origem; área/cela destino.
- solicitante, motivo, instante, status PENDENTE/ACEITA/RECUSADA/CANCELADA, operation_id UNIQUE.

**`transferencias_aprovacoes`**
- `id` UUID PK; transferência FK; decisão; usuário destino; instante; observação.

Transferências entre áreas da mesma conta (ex.: Pavilhão C → Disciplinar/Disciplinar Risco; Pavilhão D → CP): o Responsável ativo vinculado à área de origem pode efetivar diretamente, sem aguardar aceite do destino. O servidor bloqueia a transferência e o interno/localização, confirma status PENDENTE, origem atual e destino/cela ativos, encerra origem, abre destino e grava histórico/auditoria na mesma transação. Não registrar aprovação fictícia do destino.

Transferências entre contas distintas exigem aceite do Responsável ativo vinculado à área de destino. O servidor bloqueia a transferência e o interno/localização, confirma status PENDENTE, origem ainda atual, destino autorizado e cela ativa, encerra origem, abre destino, grava histórico, aprovação e auditoria e marca ACEITA em commit único.

Recusa não altera localização. Repetir a mesma operação idempotente devolve o resultado original. Movimentações abertas acompanham o interno e não são encerradas pela transferência.

### 2.8 Conferência física e snapshot

**`conferencias`**
- `id` UUID PK; área; modalidade POR_CELA/GERAL; status EM_ANDAMENTO/FINALIZADA/CANCELADA.
- início/fim, responsável e observação.

**`conferencia_itens`**
- `id` UUID PK; `conferencia_id`; `interno_id`.
- snapshots de nome, área, código da cela e localização no instante de início.
- resultado PENDENTE/CONFERIDO/NAO_LOCALIZADO/OUTRA_SITUACAO.
- outra_situacao nullable; marcado_por e marcado_em.
- UNIQUE (`conferencia_id`, `interno_id`).

Ao iniciar, criar snapshot transacional da relação aplicável. Relatório final usa somente snapshot, nunca a localização atual. Mudanças posteriores não alteram os itens. Somente o Responsável da área vinculada pode finalizar a conferência e retificar uma conferência finalizada daquela área. A finalização encerra a edição comum. Retificação é excepcional e pode ser realizada pelo próprio Responsável da área, com justificativa própria e auditoria. Não exige aprovação de segundo usuário. Deve preservar a versão anterior e registrar os valores anteriores e novos.

### 2.9 Plantões, senhas e resumos

**`plantoes`**
- início/fim como TIMESTAMPTZ, identificador do ciclo/equipe, status, fechamento e responsável.
- períodos locais 08h–08h em `America/Campo_Grande`.

**`senhas_diarias`**
- usuário/conta, hash, início/fim da validade, gerada_em, gerada_por, estado.
- armazenar apenas hash forte. Validade calculada no servidor a partir das 08h locais.
- sessão persiste; mutações exigem senha diária vigente.

**`plantao_resumos`**
- plantão, escopo/área, JSONB do resumo, gerado_em, versão e hash.
- Resumo é fotografia auditável; não substitui eventos originais.

## 3. Regras de integridade e concorrência

1. FKs históricas com RESTRICT; não usar cascatas destrutivas.
2. CHECKs para estados e intervalos de tempo coerentes.
3. Uma localização atual por interno, garantida por índice único parcial.
4. Cela pertence à área indicada, garantida por FK composta.
5. Cela obrigatória em toda localização.
6. Código de cela único por área mesmo depois de inativado.
7. Um item por interno em cada snapshot de conferência.
8. Chaves de idempotência únicas para comandos de sincronização e operações mutáveis.
9. Bloqueio FOR UPDATE em interno/localização, lote de importação, transferência e fechamento de plantão.
10. Toda mutação de múltiplas tabelas usa transação; falha em auditoria provoca rollback da operação.
11. Não usar “última gravação vence” para localização, exclusão, transferência, conferência ou importação.
12. Datas armazenadas como TIMESTAMPTZ; regras operacionais calculadas com `America/Campo_Grande`.

## 4. Offline e sincronização

Cada comando offline contém operation_id UUID, device_id, usuário autenticado, tipo, payload e horário local declarado. O servidor registra também o horário de recebimento.

- UNIQUE(operation_id) impede duplicação.
- Mesmo operation_id e mesmo payload: devolver resultado original.
- Mesmo operation_id com payload diferente: rejeitar e auditar.
- Conflitos de estado atual são encaminhados para revisão, sem sobrescrita automática.
- A fila IndexedDB só marca o comando sincronizado após confirmação persistida do servidor.
- Service Worker disponibiliza recursos estáticos; IndexedDB guarda dados/fila.
- Sem conexão, aparelhos diferentes não se comunicam em tempo real. Cada dispositivo sincroniza quando recuperar acesso ao servidor.

## 5. Fechamento do plantão às 08h

Rotina idempotente:
1. identificar o período que terminou às 08h de Campo Grande;
2. obter trava por identificador único do período;
3. gerar resumo por área e consolidado;
4. listar pendências e ocorrências abertas sem encerrá-las;
5. incluir inclusões, exclusões, transferências, mudanças de cela, divergências e conferências;
6. persistir resumo e auditoria;
7. abrir o novo período, sem apagar dados nem bloquear lançamentos atrasados.

O serviço deve recuperar fechamento perdido por indisponibilidade e não duplicar resumos em reexecução.

## 6. Segurança, backup e armazenamento de PDFs

- Segredos somente em variáveis protegidas do serviço dedicado; nunca no repositório.
- Serviço CONFERE usa apenas a conexão do projeto Neon exclusivo.
- Não compartilhar pool, tabela ou credencial com o servidor principal.
- Backup antes de migrations relevantes e rotina de backup conforme política aprovada.
- Backup só é considerado válido após teste de restauração.
- PDFs originais precisam ser preservados com hash, área, operador e data; destino e prazo de retenção ainda precisam de decisão. Não presumir que o banco relacional será o armazenamento dos arquivos.

## 7. Matriz mínima de testes

- As oito áreas são independentes; contas C e D não misturam listagens nem PDFs.
- Cada PDF é vinculado a uma única área e contém a relação completa dessa área.
- PDF truncado/incompleto não pode propor exclusões.
- Ausência no PDF exige revisão/confirmacão; nunca exclusão automática.
- Homônimos não são vinculados automaticamente.
- Código de cela inativada não pode ser reutilizado na mesma área; código igual em área diferente é permitido.
- Localização sem cela e cela de outra área são rejeitadas.
- Inclusão manual pelo Responsável de área só é permitida em cela de área vinculada; nome e cela obrigatórios, demais dados podem aguardar o PDF seguinte; histórico/auditoria obrigatórios; importação posterior completa o cadastro sem duplicar e ambiguidades exigem revisão humana.
- Responsável de área pode aprovar inclusões, alterações e exclusões propostas pelo PDF somente na área vinculada; decisões por linha, usuário, data/hora e auditoria são obrigatórios; exclusão confirmada exige motivo.
- Exclusão lógica preserva ficha e histórico; Administrador, Chefe, Auxiliar e Responsável de área podem excluir e reativar; o Responsável de área somente nas áreas vinculadas; ambas as ações exigem motivo e auditoria.
- Múltiplas movimentações são independentes.
- Transferência pendente/recusada não muda localização; aceite é atômico.
- Reenvio offline não duplica efeitos; payload diferente com mesmo ID é rejeitado.
- Snapshot não muda após alterações posteriores.
- Fechamento de plantão repetido não duplica resumo.
- Às 08h a sessão continua, mas mutações bloqueiam até senha vigente.
- Falha em qualquer etapa transacional não deixa dados parciais.
- Restauração de backup é testada em ambiente isolado.

## 8. Pendências funcionais restantes

1. Quais tipos adicionais de ocorrência devem existir além dos já listados?
2. Onde guardar os PDFs originais e por quanto tempo?
3. Completar a matriz detalhada de permissões por perfil (administrador, chefe, auxiliar e responsável de área), incluindo se o Administrador pode enviar/iniciar importações PDF.


## 9. Limite desta etapa

Este documento é a especificação relacional e transacional para revisão. **Nenhuma tabela, extensão, role adicional ou migration foi criada/aplicada no Neon.** O próximo passo, após revisão e autorização específica, será preparar um arquivo SQL versionado para revisão — ainda sem aplicá-lo automaticamente.
