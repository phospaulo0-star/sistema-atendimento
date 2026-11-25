'use strict';

/**
 * Conexão isolada do CONFERE DOS PAVILHÕES.
 *
 * Segurança por padrão:
 * - Não utiliza DATABASE_URL como fallback.
 * - Exige ambiente explicitamente marcado como development ou test.
 * - Exige allowlist exata do hostname do banco.
 * - Recusa a mesma URL configurada para o banco principal (DATABASE_URL).
 * - Não cria schema, tabelas, extensões ou executa migrações.
 * - Não abre conexão ao importar este arquivo.
 */

const { Pool } = require('pg');

let poolInstance = null;

function obterConfiguracao() {
  const connectionString = String(process.env.CONFERE_DATABASE_URL || '').trim();
  const ambiente = String(process.env.CONFERE_DB_ENV || '').trim().toLowerCase();
  const hostPermitido = String(process.env.CONFERE_DB_ALLOWED_HOST || '').trim().toLowerCase();
  const databasePrincipal = String(process.env.DATABASE_URL || '').trim();

  if (!connectionString) {
    throw new Error('CONFERE_DATABASE_URL não foi configurada.');
  }

  if (!['development', 'test'].includes(ambiente)) {
    throw new Error('CONFERE_DB_ENV deve ser exatamente development ou test.');
  }

  if (!hostPermitido) {
    throw new Error('CONFERE_DB_ALLOWED_HOST deve informar o hostname autorizado do banco de testes.');
  }

  if (databasePrincipal && connectionString === databasePrincipal) {
    throw new Error('A conexão do CONFERE não pode reutilizar DATABASE_URL do sistema principal.');
  }

  let principalParsed = null;
  if (databasePrincipal) {
    try {
      principalParsed = new URL(databasePrincipal);
    } catch {
      throw new Error('DATABASE_URL principal não pôde ser validada; conexão do CONFERE bloqueada por segurança.');
    }
  }

  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('CONFERE_DATABASE_URL não contém uma URL PostgreSQL válida.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('A conexão do CONFERE deve utilizar o protocolo PostgreSQL.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== hostPermitido) {
    throw new Error('O hostname do banco não corresponde a CONFERE_DB_ALLOWED_HOST. Conexão bloqueada.');
  }

  if (principalParsed && hostname === principalParsed.hostname.toLowerCase()) {
    throw new Error('O banco do CONFERE não pode compartilhar o mesmo servidor/hostname do banco principal.');
  }

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    // Conexões locais são permitidas apenas em ambiente de desenvolvimento/teste,
    // já validado acima e nunca por fallback para o banco principal.
  }

  return { connectionString, hostname };
}

function getConferePool() {
  if (poolInstance) return poolInstance;

  const config = obterConfiguracao();
  const isNeon = config.hostname.endsWith('.neon.tech');

  poolInstance = new Pool({
    connectionString: config.connectionString,
    ssl: isNeon ? { rejectUnauthorized: false } : undefined,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    application_name: 'sistema-atendimento-confere'
  });

  poolInstance.on('error', (error) => {
    // Não registrar URL, usuário, senha ou conteúdo de consultas.
    console.error('[CONFERE][DB] Erro inesperado em conexão ociosa:', error.message);
  });

  return poolInstance;
}

async function testarConexaoConfere() {
  const pool = getConferePool();
  const result = await pool.query(
    'SELECT current_database() AS database_name, current_user AS database_user, current_schema() AS current_schema, version() AS server_version'
  );

  return {
    conectado: true,
    database: result.rows[0].database_name,
    schemaAtual: result.rows[0].current_schema,
    usuarioBanco: result.rows[0].database_user,
    versaoServidor: result.rows[0].server_version
  };
}

async function fecharPoolConfere() {
  if (!poolInstance) return;
  const atual = poolInstance;
  poolInstance = null;
  await atual.end();
}

module.exports = {
  getConferePool,
  testarConexaoConfere,
  fecharPoolConfere
};
