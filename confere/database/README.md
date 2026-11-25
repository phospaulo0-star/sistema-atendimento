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
