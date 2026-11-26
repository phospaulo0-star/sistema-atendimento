# Revisão técnica do modelo — CONFERE DOS PAVILHÕES (v1.1)

**Status:** revisão de engenharia/documentação; não é migração SQL e não foi aplicada ao Neon.  
**Ambiente-alvo futuro:** projeto `confere-pavilhoes-dev`, branch `confere-dev`.  
**Código:** branch GitHub `feature/confere-pavilhoes`.

## 1. Correções identificadas no modelo v1

### 1.1 Quantidade de áreas

A distribuição confirmada soma **oito áreas**, não sete:

1. Pavilhão A;
2. Pavilhão B;
3. Pavilhão C;
4. Disciplinar Risco;
5. Disciplinar;
6. Pavilhão D;
7. CP;
8. Pavilhão Virtual.

São cinco contas de acesso e oito áreas operacionais. A interface deve agrupar áreas conforme a conta, mas manter dados e conferências separados por área.

### 1.2 Um único identificador permanente para o interno

O modelo v1 propôs `id` UUID e também `codigo_interno` UUID. Isso duplica a mesma função e abre risco de divergência. Recomenda-se manter apenas `internos.id UUID PRIMARY KEY DEFAULT gen_random_uuid()` como identificador técnico permanente, invisível na interface e independente de RGI. Não criar outro código UUID redundante.

O nome nunca será UNIQUE. Homônimos serão distinguidos por análise humana e dados de contexto, nunca por associação automática baseada apenas no nome.

### 1.3 Integridade entre cela e área

Não basta validar `cela_id` e `area_id` separadamente. A FK deve garantir que a cela pertença à mesma área da localização. Recomendação:
- `celas`: UNIQUE (`id`, `area_id`);
- `localizacoes`: FK composta (`cela_id`, `area_id`) → `celas(id, area_id)`;
- `cela_id` pode ser NULL somente se a regra de negócio permitir interno ainda sem cela; a área continua obrigatória.

Isso evita uma localização gravada na Área A apontando para cela da Área B.

### 1.4 Uma localização atual por interno

Manter índice único parcial em `localizacoes(interno_id) WHERE fim_em IS NULL`. A abertura e o encerramento de localizações devem ocorrer em transação. A aplicação deve bloquear a linha do interno (`SELECT ... FOR UPDATE`) antes de alterar localização para impedir duas movimentações concorrentes.

### 1.5 Situação cadastral e localização atual

A exclusão lógica precisa ser consistente. Recomenda-se:
- `internos.status_cadastro`: ATIVO ou EXCLUIDO;
- ao excluir, exigir motivo e responsável, registrar evento/auditoria e encerrar a localização ativa na mesma transação;
- não apagar o interno, suas movimentações ou seu histórico;
- reativação, se autorizada, deve ser uma operação própria, auditada e com nova localização, sem reabrir silenciosamente a localização antiga.

O banco deve impedir uma localização ativa para interno excluído por validação transacional e, se viável, trigger de integridade.

## 2. Regras SQL e constraints recomendadas

A futura migration deverá incluir, no mínimo:

- PK UUID em todas as entidades principais.
- FKs com `ON DELETE RESTRICT` para dados históricos; nenhuma cascata destrutiva em cadastros/eventos.
- `NOT NULL` nos campos indispensáveis: nome do interno, área, início da localização, tipo/status de evento, responsável e timestamps essenciais.
- CHECK para valores de status e tipos controlados.
- CHECK para `fim_em IS NULL OR fim_em >= inicio_em`.
- UNIQUE (`area_id, codigo`) em celas.
- UNIQUE parcial para uma localização atual por interno.
- UNIQUE (`conferencia_id, interno_id`) nos itens de snapshot.
- UNIQUE para chave idempotente por operação/comando.
- Índices em FKs e colunas efetivamente usadas para filtrar listas por área, cela, status e período.
- Índices de data/hora para histórico e auditoria.
- Proibição de UPDATE/DELETE em eventos históricos e auditoria por permissões da role da aplicação; correções devem ser novos eventos compensatórios.

Não instalar extensão PostgreSQL sem necessidade comprovada. Para a primeira versão, pesquisa por nome pode começar com índice B-tree sobre coluna normalizada; busca aproximada pode ser avaliada depois, em migração própria.

## 3. Auditoria e histórico: separar propósitos

Manter duas trilhas:

- **Histórico de negócio:** eventos que aparecem na ficha do interno e nos relatórios do plantão.
- **Auditoria técnica:** quem executou qual ação, em qual entidade, quando, de qual sessão/dispositivo e com qual identificador de correlação.

Para operações sensíveis, ambas são gravadas na mesma transação da alteração de negócio. Se o evento de auditoria falhar, a operação sensível deve falhar junto. Usuários da aplicação não recebem permissão de apagar ou editar trilhas históricas.

Não guardar senha, token, cookie ou URL de conexão em `detalhes` JSONB, logs ou auditoria.

## 4. Importação PDF — fluxo transacional seguro

1. Receber o PDF e calcular SHA-256 no servidor.
2. Criar registro de importação com área, operador, nome, hash e estado.
3. Extrair linhas para staging sem alterar `internos`, `celas` ou `localizacoes`.
4. Validar se o documento aparenta ser completo ou parcial — esta regra ainda precisa de confirmação funcional.
5. Gerar comparação: novos, possíveis correspondentes, alterações de dados, mudanças de cela, ausentes e casos ambíguos.
6. Exigir decisão humana para associação duvidosa, homônimos e ausências.
7. Mostrar prévia final com contagens e alterações exatas.
8. Ao confirmar, bloquear o lote para evitar aplicação dupla e aplicar todas as decisões aprovadas em transação.
9. Registrar histórico/auditoria e marcar lote como aplicado na mesma transação.
10. Se falhar, rollback integral; staging permanece disponível para diagnóstico ou cancelamento.

Reimportar o mesmo arquivo (mesmo hash e área) deve alertar sobre duplicidade e não aplicar automaticamente. Uma reimportação intencional exige ação explícita e revisão.

## 5. Transferências entre áreas/contas

O aceite deve ser protegido por transação:
- bloquear transferência e cadastro/localização do interno;
- validar estado PENDENTE, origem ainda atual e autorização do usuário destino;
- verificar destino/área/cela ativos e coerentes;
- encerrar a localização de origem e abrir a de destino;
- registrar evento de saída/entrada, aprovação e auditoria;
- marcar ACEITA;
- confirmar tudo junto.

Uma segunda tentativa de aceite deve retornar o resultado já concluído sem duplicar localização. Recusa não altera localização. Se duas transferências concorrentes tentarem mover o mesmo interno, somente uma pode concluir; a outra deve ser recusada por conflito e auditada.

Movimentações abertas e histórico acompanham o mesmo `interno_id`; a transferência não encerra automaticamente ocorrências independentes.

## 6. Conferência física: snapshot imutável

Ao iniciar conferência, criar cabeçalho e copiar para `conferencia_itens` os internos e os dados de localização válidos naquele instante:
- `interno_id`;
- nome exibido no momento;
- área e cela do momento;
- data/hora do snapshot;
- resultado inicial PENDENTE.

A conferência não deve depender de JOIN com a localização atual para reconstruir a lista original. Mudanças posteriores não podem alterar o snapshot. Permitir marcar resultado e registrar quem/quando marcou, mas preservar os campos de fotografia.

Após finalização, bloquear alterações dos itens. Correção excepcional exige reabertura autorizada, justificativa e trilha de auditoria, ou emissão de retificação separada.

## 7. Operações offline e concorrência

Cada mutação offline deve incluir:
- `operation_id` UUID;
- `device_id` identificador não secreto;
- usuário autenticado;
- horário local declarado pelo dispositivo;
- tipo da operação e payload;
- versão/estado observado quando necessário.

O servidor mantém registro de operações processadas com UNIQUE (`operation_id`) e resultado da primeira execução. Reenvio idêntico retorna o resultado original. Reenvio com mesmo ID e payload diferente é rejeitado e auditado.

Não usar “última gravação vence” para localização, exclusão, aceite de transferência ou resultado final de conferência. Esses conflitos exigem resolução explícita. A fila local só marca operação como sincronizada após confirmação persistida do servidor.

## 8. Plantão e horário de Campo Grande

- Persistir instantes em `timestamptz`.
- Definir limites de plantão usando o fuso IANA `America/Campo_Grande`, nunca o fuso presumido do navegador.
- A rotina das 08h deve ser idempotente, com chave única para o fechamento do período.
- Se o serviço estiver indisponível às 08h, executar recuperação ao retornar, identificando o período correto; não criar dois fechamentos.
- Fechamento gera resumo e lista pendências; não encerra automaticamente ocorrências em aberto.
- Registrar horário de ocorrência informado offline e horário de recebimento pelo servidor separadamente.

## 9. Senhas diárias e sessões

- Armazenar somente hash forte da senha diária; nunca senha em texto.
- Validar no servidor `valid_from <= now() AND now() < valid_until`, considerando o instante absoluto correspondente às 08h de Campo Grande.
- Rotação deve ser persistida e independente de usuário estar conectado.
- Recomendação de segurança: exigir nova autenticação após expiração da senha diária; não basta impedir novas ações mantendo uma sessão antiga indefinidamente.
- Revogar sessões antigas na rotação, ou exigir reautenticação no próximo pedido. A política final precisa ser confirmada.
- Nunca enviar senha diária em URL, log, e-mail sem proteção ou resposta de API não autorizada.

## 10. Backup e restauração

Antes de cada migração importante:
1. criar ponto de restauração/backup verificável;
2. registrar versão da aplicação e migration;
3. executar migração apenas na branch de desenvolvimento;
4. validar constraints, contagens e fluxos de teste;
5. testar restauração em ambiente isolado;
6. só então avaliar próxima etapa.

Backup não é considerado válido até que a restauração tenha sido testada. PDFs originais e demais anexos precisam de política de armazenamento e retenção definida antes da implementação do upload definitivo.

## 11. Plano de testes antes da primeira migration

- Oito áreas e cinco contas: isolamento de leitura e escrita.
- Um usuário não consegue operar fora das áreas atribuídas, mesmo chamando API diretamente.
- Homônimos podem coexistir; nenhuma associação automática por nome.
- Uma cela não pode ser usada por outra área.
- Um interno não pode ter duas localizações atuais.
- Interno excluído não aparece na lista ativa, mas ficha e histórico continuam consultáveis por quem tem permissão.
- Duas movimentações simultâneas podem ser abertas e encerradas independentemente.
- Transferência pendente/recusada não muda localização; aceite faz mudança atômica.
- Repetir operação offline não duplica eventos.
- Snapshot de conferência permanece igual após transferência ou mudança de cela.
- Itens finalizados não são editáveis por usuário comum.
- Fechamento de plantão pode ser repetido sem duplicar resumo.
- Rotação de senha às 08h invalida a senha e sessões antigas conforme política.
- Falha no meio de transação não deixa dados parciais.

## 12. Pendências funcionais para fechar antes da migration

1. PDF diário: fotografia completa e obrigatória da área ou pode ser parcial?
2. Celas: o código de uma cela pode ser reutilizado em outro momento dentro da mesma área? Se sim, a identificação da cela precisa de vigência histórica.
3. Interno sem cela: permitir localização apenas na área, com cela nula?
4. Chefe e auxiliar: acesso a todas as oito áreas ou apenas às áreas atribuídas pelo administrador?
5. Expiração diária: confirmar que às 08h todos precisam entrar novamente com a nova senha.
6. Ocorrências: quais tipos adicionais além dos já listados?
7. Arquivos: onde guardar PDF original e por quanto tempo?
8. Exclusão/reativação: quem pode reativar cadastro excluído e sob quais condições?

**Limite desta etapa:** nenhuma tabela, extensão, role adicional ou migration foi criada/aplicada. Este documento é revisão técnica para aprovação antes de gerar SQL.
