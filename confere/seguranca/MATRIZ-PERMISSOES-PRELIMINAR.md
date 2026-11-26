# CONFERE DOS PAVILHÕES — Matriz preliminar de permissões

Status: proposta técnica para revisão. Não representa concessão de permissões no banco.

## Princípios confirmados

- Administrador, Chefe e Auxiliar podem consultar as oito áreas.
- Cada conta operacional de área fica limitada às áreas vinculadas àquela conta.
- As contas A, B, C, D e Virtual possuem escopos próprios.
- O acesso a uma área não concede automaticamente permissão para decidir transferências, excluir internos ou reativar cadastros.
- Toda mutação deve ser validada no servidor com o usuário autenticado; nunca confiar em perfil, usuário ou área enviados livremente pelo navegador.
- A senha diária vigente é uma condição adicional para mutações; não substitui autenticação nem autorização.

## Matriz preliminar

| Ação | Administrador | Chefe | Auxiliar | Responsável de área |
|---|---|---|---|---|
| Consultar as oito áreas | Sim | Sim | Sim | Somente áreas vinculadas |
| Consultar ficha e histórico | Sim | Sim | Sim | Somente áreas vinculadas |
| Gerenciar usuários e vínculos de área | Sim | Não definido | Não definido | Não |
| Gerenciar senhas diárias das contas | Sim | Não definido | Não definido | Não |
| Importar PDF da área | A definir | A definir | A definir | Somente área vinculada |
| Aprovar inclusão/alteração/exclusão em importação | A definir | A definir | A definir | A definir por área |
| Registrar movimentação | Sim, com auditoria | Sim, com auditoria | Sim, com auditoria | A definir por tipo e área |
| Solicitar transferência | Sim | Sim | Sim | Somente área vinculada |
| Aceitar transferência entre contas diferentes | Sim, com justificativa | Sim, se designado | Sim, se designado | Responsável autorizado no destino |
| Executar transferência entre áreas da mesma conta | Sim | Sim | Sim | Se autorizado nas duas áreas |
| Reativar interno excluído | Sim | Sim | Sim | Não confirmado |
| Iniciar e marcar conferência física | Sim | Sim | Sim | Área vinculada |
| Finalizar conferência | Sim | Sim | Sim | A definir |
| Consultar relatórios de plantão | Sim | Sim | Sim | Relatórios da área, se autorizados |
| Consultar auditoria geral | Sim | Sim, escopo a definir | Sim, escopo a definir | Não |
| Retificar conferência finalizada | A definir, sempre auditado | A definir | A definir | Não confirmado |

## Regras obrigatórias de autorização

1. O backend resolve o usuário a partir da sessão autenticada.
2. A permissão é verificada em cada endpoint/mutação, não apenas na interface.
3. Acesso a múltiplas áreas exige vínculo explícito por área ou privilégio global de Chefe/Auxiliar/Administrador.
4. Decisão de transferência entre contas exige vínculo e permissão de decisão na área de destino.
5. Transferência dentro da mesma conta exige autorização para as duas áreas, sem aprovação externa do destino, conforme regra funcional já definida.
6. Reativação exige motivo, responsável, data/hora e evento de auditoria.
7. Operações offline são revalidadas na sincronização; permissões e senha diária não são presumidas válidas pelo horário gravado no dispositivo.

## Pontos que precisam de definição funcional

- Quais ações exatas Chefe e Auxiliar podem executar em nome de qualquer área.
- Se Responsável de área pode incluir, excluir, reativar e aprovar importações, ou apenas registrar movimentações e conferências.
- Quem pode finalizar conferências e quem pode autorizar retificações.
- Se Administrador pode executar qualquer operação operacional ou apenas administrar e auditar.
- Se a importação PDF é exclusiva do Responsável da área ou também pode ser executada por Chefe/Auxiliar.

Até essa definição, os itens marcados como “A definir” não devem ser codificados como permissões liberadas.
