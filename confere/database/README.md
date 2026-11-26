# Banco de testes do CONFERE

Este módulo de conexão é isolado e não está integrado ao servidor principal.

## Variáveis obrigatórias

Configurar somente no futuro serviço de desenvolvimento/homologação do CONFERE:

- `CONFERE_DATABASE_URL`: URL do PostgreSQL exclusivo de desenvolvimento/teste.
- `CONFERE_DB_ENV`: deve ser `development` ou `test`.
- `CONFERE_DB_ALLOWED_HOST`: hostname exato autorizado para a conexão do CONFERE.

A variável `DATABASE_URL` existente pertence ao Sistema Atendimento e nunca será usada como fallback.

## Proteções implementadas

1. Recusa ausência de qualquer configuração obrigatória.
2. Recusa ambiente diferente de `development` ou `test`.
3. Compara o hostname da URL com a allowlist exata.
4. Recusa reutilizar a mesma URL de `DATABASE_URL`.
5. Aceita somente URLs PostgreSQL.
6. Não conecta automaticamente ao importar o módulo.
7. Não cria schema ou tabelas e não executa migrações.
8. O teste de conexão executa somente uma consulta `SELECT` de identificação.

## Uso futuro

```js
const {
  testarConexaoConfere,
  fecharPoolConfere
} = require('./database/pool');

try {
  const diagnostico = await testarConexaoConfere();
  // Exibir somente informações não sensíveis ao administrador.
} finally {
  await fecharPoolConfere();
}
```

Não imprimir `CONFERE_DATABASE_URL`, credenciais, tokens ou objetos de configuração nos logs.

## Antes de configurar

- Criar um banco/branch Neon exclusivo para desenvolvimento ou homologação.
- Confirmar o hostname diretamente no painel do Neon.
- Configurar as três variáveis somente no serviço Render exclusivo do CONFERE.
- Não copiar a URL de produção.
- Testar a conexão antes de criar qualquer schema.
- Executar migrações somente após revisão e autorização explícita.

Nenhuma conexão é realizada por este arquivo enquanto ele não for chamado pela aplicação.


## Documentos do fluxo de importação PDF

- `ESPECIFICACAO-VALIDACAO-PDF-COMPLETO-V1.md`: critérios para aceitar somente PDFs completos e impedir ausências em arquivos parciais.
- `FLUXO-IMPORTACAO-CONCILIACAO-PDF-V1.md`: etapas de upload, staging, conciliação, revisão humana e aplicação.
- `migrations/TESTES-COMPORTAMENTAIS-IMPORTACAO-RODADA-1.md`: resultados dos testes estruturais isolados em branch Neon temporária.
- `CONTRATO-TRANSACIONAL-APLICACAO-IMPORTACAO-V1.md`: bloqueios, validações, idempotência, fotografia-base, rollback e matriz de testes para a futura API.

Esses documentos são especificações e relatórios; não significam que o parser, os endpoints ou o serviço de aplicação já estejam implementados.


## Módulo inicial de regras de importação

Foi criado `../importacao/regras-aplicacao.js` com validações puras de pré-condições para a futura aplicação de lotes e `../importacao/regras-aplicacao.test.js` com testes usando o módulo nativo `node:test`.

Para executar localmente a partir da raiz do repositório:

```bash
node --test confere/importacao/regras-aplicacao.test.js
```

**Limite importante:** essas regras não fazem autenticação, consultas, bloqueios, transação, parser de PDF nem escrita no banco. A API deverá consultar os dados sob bloqueio no PostgreSQL e só então chamar a validação. Os testes foram adicionados ao repositório, mas ainda não foram executados em um ambiente Node nesta etapa.


### Reforços da pré-validação (rodada seguinte)

O módulo `confere/importacao/regras-aplicacao.js` também verifica:
- vínculo de cada linha com uma página física válida;
- reconciliação da quantidade de linhas por página;
- página marcada como vazia sem linhas extraídas;
- autoria das decisões pelo Responsável autenticado;
- presença de cadastro-alvo para ATUALIZAR, MOVER, EXCLUIR e VINCULAR.

Os testes correspondentes foram acrescentados em `confere/importacao/regras-aplicacao.test.js`. Ainda precisam ser executados em Node e, depois, repetidos como testes de integração com PostgreSQL. A função permanece uma pré-validação pura: não substitui transação, locks, autorização consultada no banco nem idempotência do comando.
