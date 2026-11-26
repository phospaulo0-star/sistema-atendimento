# CONFERE DOS PAVILHÕES — Especificação de validação de PDF completo (v1)

**Status:** especificação funcional/técnica para revisão; ainda não implementada.  
**Escopo:** receber um PDF diário por área, verificar integridade e completude, extrair dados para staging e impedir que arquivo parcial produza candidatos de exclusão.  
**Áreas:** Pavilhão A, Pavilhão B, Pavilhão C, Disciplinar Risco, Disciplinar, Pavilhão D, CP e Pavilhão Virtual.

## 1. Regra inegociável

Cada arquivo enviado representa a relação completa de uma única área. Um PDF inválido, incompleto, truncado, ilegível ou com extração parcial:
- não pode ser marcado como fotografia completa;
- não pode gerar candidatos de ausência/exclusão;
- não pode atualizar cadastros/localizações ativos como se fosse a relação oficial;
- deve permanecer em estado de falha/revisão, com diagnóstico preservado;
- não substitui a última importação completa e aprovada da área.

O sistema nunca exclui automaticamente um interno por ausência. Mesmo em lote validado como completo, a ausência é apenas divergência/candidato; a decisão exige revisão e aprovação do Responsável da área, com motivo obrigatório para exclusão.

## 2. Isolamento por área

1. O usuário seleciona exatamente uma das oito áreas antes do envio.
2. O lote guarda a área selecionada e o usuário autenticado no servidor.
3. Não inferir a área apenas pelo nome do arquivo.
4. Um PDF nunca pode alimentar duas áreas nem combinar áreas diferentes.
5. O Responsável só envia para sua área vinculada; Chefe e Auxiliar podem enviar para qualquer uma das oito áreas.
6. A autorização do upload é distinta da autorização para aprovar as divergências.
7. Permissão do Administrador para iniciar/envia PDF continua pendente; negar por padrão até decisão expressa.

## 3. Etapas de validação

### 3.1 Recepção e integridade do arquivo

- Aceitar somente PDF.
- Aplicar limite configurável de tamanho e tempo de processamento.
- Validar assinatura/magic bytes e estrutura do arquivo; não confiar apenas na extensão ou no Content-Type enviado pelo navegador.
- Calcular SHA-256 no servidor sobre os bytes recebidos.
- Verificar se o arquivo abre e se todas as páginas podem ser lidas.
- Registrar nome original sanitizado, tamanho, hash, instante, usuário, área e versão do validador/extrator.
- Mesmo hash para a mesma área deve alertar duplicidade e impedir reaplicação automática. Mesmo hash em áreas diferentes não deve ser tratado como o mesmo lote operacional: mostrar alerta para revisão, pois cada área tem seu PDF próprio.
- Arquivo criptografado/protegido por senha, corrompido ou com páginas ilegíveis: falhar e solicitar novo arquivo ou tratamento manual autorizado.

### 3.2 Extração de páginas

- Contar páginas reais do PDF.
- Extrair texto de todas as páginas, identificando número sequencial da página e ordem de cada registro.
- Registrar por página: sucesso/falha, quantidade de texto extraído, quantidade de registros identificados e avisos.
- Exigir processamento de todas as páginas; falha em uma página impede status de completo.
- Se o documento apresentar paginação impressa (ex.: “página X de Y”), verificar sequência, total declarado e ausência de lacunas/duplicações. Divergência impede classificação automática como completo.
- Se não houver paginação impressa confiável, o sistema não deve inventar um total esperado. Usar verificações estruturais e confirmação explícita do operador sobre a relação completa, mantendo o nível de confiança indicado.
- OCR pode ser usado como contingência se não houver texto selecionável, mas OCR de baixa confiança deve gerar revisão manual e nunca liberar exclusões automaticamente.

### 3.3 Validação estrutural da relação

Validar, conforme o leiaute vigente do PDF:
- existência de cabeçalho/título esperado para a área;
- identificação coerente da área com a área selecionada;
- identificação de celas e registros de internos;
- campos obrigatórios para cada linha (ao menos nome e cela);
- coerência de agrupamento por cela;
- ausência de páginas vazias inesperadas, páginas repetidas e blocos cortados;
- consistência da paginação, quando existente;
- ausência de falhas de extração ou linhas não interpretadas sem diagnóstico.

Linha sem nome ou sem cela válida não deve ser descartada silenciosamente. Deve ficar como inválida/divergente no staging e bloquear a conclusão automática de completude até revisão/correção.

### 3.4 Verificações comparativas e alertas

Comparar com a última importação completa e aprovada da mesma área:
- total de páginas;
- total de registros;
- quantidade de celas;
- distribuição de registros por cela;
- variação percentual e absoluta por cela e no total;
- campos que ficaram vazios em relação ao padrão anterior.

Diferenças não provam, por si só, que o PDF está incompleto. São alertas de plausibilidade para revisão. Mudanças legítimas de população podem ocorrer. Limites de alerta devem ser configuráveis e não podem transformar uma comparação estatística em aprovação automática.

### 3.5 Confirmação da completude

Antes de criar candidatos de ausência:
- todas as páginas devem ter sido lidas;
- não pode haver falha estrutural não resolvida;
- paginação impressa, quando presente, deve fechar corretamente;
- linhas inválidas ou não interpretadas devem estar resolvidas;
- área do lote deve estar definida e consistente;
- operador deve confirmar que enviou o PDF diário completo daquela área;
- o sistema deve mostrar um resumo de validação e alertas para revisão.

A confirmação do operador não pode sobrepor falha técnica crítica. Se houver dúvida, manter o lote como incompleto/aguardando correção e não calcular ausências.

## 4. Estados recomendados do lote

- RECEBIDA: arquivo armazenado temporariamente e identificado.
- VALIDANDO: integridade e páginas em processamento.
- EXTRAINDO: texto/linhas sendo extraídos.
- INCOMPLETA: falha de integridade, paginação, extração ou estrutura; sem candidatos de ausência.
- AGUARDANDO_CONFIRMACAO_COMPLETUDE: validações técnicas passaram, falta confirmação do operador e revisão dos alertas.
- AGUARDANDO_REVISAO: fotografia completa confirmada; divergências disponíveis para revisão do Responsável.
- APLICANDO: decisões aprovadas sendo aplicadas em transação.
- APLICADA: decisões aprovadas aplicadas com sucesso.
- CANCELADA: operador cancelou antes da aplicação.
- FALHA: erro técnico; sem gravação parcial dos cadastros ativos.

O status `AGUARDANDO_REVISAO` só pode ser alcançado se a validação de completude tiver passado. `INCOMPLETA` e `FALHA` nunca geram candidatos de ausência/exclusão.

## 5. Staging e decisões por linha

A extração é armazenada em staging sem alterar a relação ativa. Cada linha pode ser classificada como:
- inclusão proposta;
- correspondência;
- alteração cadastral;
- mudança de cela;
- possível homônimo/ambiguidade;
- possível ausência;
- divergência/linha inválida.

O sistema deve exibir dados extraídos, sugestão de correspondência e dados atuais lado a lado. Não vincular somente pelo nome quando houver ambiguidade. A decisão de cada linha registra:
- decisão tomada;
- usuário autenticado;
- data/hora do servidor;
- motivo, quando exigido;
- valores anteriores e novos;
- referência ao lote e à linha;
- evento de histórico e auditoria.

O Responsável da área aprova decisões somente na área vinculada. Exclusão confirmada exige motivo. A aplicação das decisões aprovadas deve ser atômica; se uma operação obrigatória falhar, não deixar parte do lote aplicada silenciosamente.

## 6. Proteção da última fotografia válida

- A última fotografia válida da área só muda depois de o lote completo ser aprovado e aplicado com sucesso.
- Lote incompleto, cancelado ou com falha não substitui a fotografia anterior.
- Lotes concorrentes da mesma área devem ser serializados ou bloqueados por controle de versão; não permitir que um lote antigo seja aplicado depois de um mais novo sem revisão explícita.
- O sistema deve guardar referência ao lote que originou cada atualização e ao lote usado como comparação.
- A fotografia anterior e suas decisões permanecem consultáveis.

## 7. Casos de teste obrigatórios

| ID | Cenário | Resultado esperado |
|---|---|---|
| PDF-C01 | PDF íntegro, todas as páginas extraídas, paginação fecha e operador confirma completude | Pode avançar para revisão de divergências |
| PDF-C02 | Arquivo corrompido ou não é PDF válido | Falha; nenhum candidato de ausência |
| PDF-C03 | PDF tem menos páginas que o total impresso | Incompleto; sem candidatos de ausência |
| PDF-C04 | Uma página falha na extração | Incompleto; staging preservado para diagnóstico |
| PDF-C05 | Página duplicada ou sequência de páginas com lacuna | Bloquear completude e exigir revisão |
| PDF-C06 | Página sem texto/sem registros inesperadamente | Alerta/bloqueio até revisão |
| PDF-C07 | OCR com confiança baixa ou linha não interpretada | Não liberar ausência automática; exigir revisão |
| PDF-C08 | Linha sem nome ou cela válida | Divergência; não aplicar localização; impedir conclusão até resolver |
| PDF-C09 | Queda grande de registros versus último PDF completo | Alerta de plausibilidade; operador revisa; nunca aprovar automaticamente |
| PDF-C10 | Arquivo incompleto tenta gerar ausências | Sistema não cria candidatos de ausência/exclusão |
| PDF-C11 | Arquivo completo contém interno ausente da relação anterior | Mostrar candidato; não excluir até aprovação individual/decisão explícita |
| PDF-C12 | Responsável tenta aprovar lote de outra área | Negar no servidor |
| PDF-C13 | Chefe/Auxiliar envia PDF para uma área permitida | Permitir iniciar lote, sem conceder aprovação das divergências |
| PDF-C14 | Mesmo hash reenviado para mesma área | Alertar duplicidade e impedir reaplicação automática |
| PDF-C15 | Falha no meio da aplicação das decisões | Rollback integral dos dados ativos; registrar falha |
| PDF-C16 | Dois lotes da mesma área tentam aplicar simultaneamente | Serializar/bloquear; impedir aplicação fora de ordem |
| PDF-C17 | Lote cancelado antes da aplicação | Não alterar cadastro/localização/fotografia válida |
| PDF-C18 | Arquivo de área diferente da selecionada | Exigir correção da seleção; nunca misturar áreas |

## 8. Campos técnicos que provavelmente precisarão ser adicionados ao modelo

A migration 001 atualmente registra hash, área, remetente, status, datas e resumo JSONB, mas não possui colunas explícitas para todos os resultados de validação. Antes de escrever migration adicional, avaliar campos equivalentes a:
- `quantidade_paginas_pdf`;
- `quantidade_paginas_processadas`;
- `paginas_com_falha` ou detalhe por página;
- `total_registros_extraidos`;
- `total_linhas_invalidas`;
- `total_celas_identificadas`;
- `paginacao_declarada` e `paginacao_validada`;
- `validacao_completa` e `validado_em`;
- `confirmado_como_completo_por` e `confirmado_como_completo_em`;
- `lote_comparado_id`;
- `versao_validador` / `versao_extrator`;
- diagnóstico e alertas estruturados.

A lista é conceitual. Não criar colunas redundantes sem definir a fonte única de verdade. Um registro filho por página pode ser mais adequado que guardar todos os detalhes no JSONB.

## 9. Pendências fora desta especificação

- Local de armazenamento permanente dos PDFs e prazo de retenção.
- Leiaute oficial atualizado dos oito tipos de PDF, inclusive variações de cabeçalho/rodapé.
- Limites operacionais de tamanho e tempo de processamento.
- Política de uso de OCR e limites de confiança.
- Permissão do Administrador para enviar/iniciar lote (continua não definida).

## 10. Limite desta etapa

Este documento define comportamento esperado e casos de teste. Não implementa parser PDF, upload, OCR, serviço de conciliação, endpoints, tabelas adicionais ou migrações. Nenhum banco foi alterado.
