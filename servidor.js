'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const archiver = require('archiver');
const HTMLtoDOCX = require('html-to-docx');

const scryptAsync = promisify(crypto.scrypt);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const VERSAO = '2.12.0-relatorios';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'sa_session';
const SESSION_HORAS = 24;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /neon\.tech/i.test(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

let dbReady = false;
let dbErrorMessage = null;
const clientes = new Map();
const pendentes = new Map();
const recusasPendentes = new Map();
const recebidos = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  const metodosAlteracao = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const origem = req.headers.origin;
  if (metodosAlteracao.has(req.method) && origem) {
    try {
      if (new URL(origem).host !== req.get('host')) {
        return res.status(403).json({ ok: false, message: 'Origem da solicitaÃÂÃÂ§ÃÂÃÂ£o nÃÂÃÂ£o autorizada.' });
      }
    } catch {
      return res.status(403).json({ ok: false, message: 'Origem da solicitaÃÂÃÂ§ÃÂÃÂ£o invÃÂÃÂ¡lida.' });
    }
  }
  next();
});

function agoraISO() { return new Date().toISOString(); }
function criarId() { return crypto.randomUUID(); }
function normalizarUsuario(v) { return String(v || '').trim().toLocaleLowerCase('pt-BR'); }
function textoSeguro(v, max = 200) { return String(v ?? '').trim().slice(0, max); }
function normalizarRegistro(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
}
function extrairCookie(req, nome) {
  const cabecalho = req.headers.cookie || '';
  for (const item of cabecalho.split(';')) {
    const [chave, ...resto] = item.trim().split('=');
    if (chave === nome) return resto.join('=');
  }
  return null;
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function cookieSeguro(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
}
function definirCookie(res, token, req) {
  const opcoes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_HORAS * 60 * 60}`
  ];
  if (cookieSeguro(req)) opcoes.push('Secure');
  res.setHeader('Set-Cookie', opcoes.join('; '));
}
function limparCookie(res, req) {
  const opcoes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSeguro(req)) opcoes.push('Secure');
  res.setHeader('Set-Cookie', opcoes.join('; '));
}
function usuarioPublico(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    team: row.team || null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    deletedAt: row.deleted_at || null
  };
}
function perfilValido(role, canal) {
  if (role === 'admin') return canal === 'sender' || canal === 'receiver';
  if (role === 'guiche') return canal === 'sender';
  if (role === 'mesa') return canal === 'receiver';
  return false; // chefe/auxiliar acessam somente os relatÃÂ³rios, nÃÂ£o o WebSocket de atendimentos.
}
function enviar(ws, dados) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(dados)); return true; }
  catch (e) { console.error('Erro ao enviar WebSocket:', e.message); return false; }
}
function responderErro(ws, type, message, recordId) {
  const resposta = { type, ok: false, message };
  if (recordId) resposta.recordId = recordId;
  enviar(ws, resposta);
}
function transmitirParaCanal(role, dados, ignorarWs = null) {
  let enviados = 0;
  for (const cliente of clientes.values()) {
    if (cliente.canal === role && cliente.ws !== ignorarWs && cliente.ws.readyState === WebSocket.OPEN) {
      if (enviar(cliente.ws, dados)) enviados++;
    }
  }
  return enviados;
}
function transmitirParaUsuario(userId, dados, canal = 'sender') {
  let enviados = 0;
  for (const cliente of clientes.values()) {
    if (cliente.user && cliente.user.id === userId && cliente.canal === canal && cliente.ws.readyState === WebSocket.OPEN) {
      if (enviar(cliente.ws, dados)) enviados++;
    }
  }
  return enviados;
}
function enviarNovoAtendimento(pendente, wsEspecifico = null) {
  if (!pendente) return;
  const mensagem = {
    type: 'new_record', recordId: pendente.recordId, record: pendente.record,
    createdAt: pendente.createdAt, updatedAt: pendente.updatedAt,
    sentAt: pendente.createdAt, reenvio: Boolean(pendente.record && pendente.record.reenvio)
  };
  if (wsEspecifico) enviar(wsEspecifico, mensagem);
  else transmitirParaCanal('receiver', mensagem);
}
function enviarPendentesParaMesa(ws) {
  for (const item of pendentes.values()) enviarNovoAtendimento(item, ws);
}
function enviarRecusa(recusa, wsEspecifico = null) {
  if (!recusa || !recusa.ownerId) return false;
  const msg = {
    type: 'record_refused', recordId: recusa.recordId, record: recusa.record,
    reason: recusa.reason, refusedAt: recusa.refusedAt, ownerId: recusa.ownerId, status: 'recusado'
  };
  if (wsEspecifico) {
    const c = clientes.get(wsEspecifico);
    if (!c || c.canal !== 'sender' || !c.user || c.user.id !== recusa.ownerId) return false;
    return enviar(wsEspecifico, msg);
  }
  return transmitirParaUsuario(recusa.ownerId, msg, 'sender') > 0;
}
function enviarRecusasPendentesParaGuiche(ws, userId) {
  for (const recusa of recusasPendentes.values()) {
    if (recusa.ownerId === userId) enviarRecusa(recusa, ws);
  }
}

async function criarHashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const derivada = await scryptAsync(String(senha), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derivada).toString('base64url')}`;
}
async function verificarSenha(senha, armazenada) {
  try {
    const [algoritmo, saltTexto, hashTexto] = String(armazenada || '').split('$');
    if (algoritmo !== 'scrypt' || !saltTexto || !hashTexto) return false;
    const salt = Buffer.from(saltTexto, 'base64url');
    const esperado = Buffer.from(hashTexto, 'base64url');
    const atual = Buffer.from(await scryptAsync(String(senha), salt, esperado.length));
    return atual.length === esperado.length && crypto.timingSafeEqual(atual, esperado);
  } catch { return false; }
}
function exigirBanco(req, res, next) {
  if (!pool) return res.status(503).json({ ok: false, message: 'O banco Neon ainda nÃÂÃÂ£o estÃÂÃÂ¡ configurado no Render (variÃÂÃÂ¡vel DATABASE_URL).' });
  if (!dbReady) return res.status(503).json({ ok: false, message: dbErrorMessage || 'O banco de dados estÃÂÃÂ¡ inicializando. Tente novamente em instantes.' });
  next();
}
async function usuarioDaRequisicao(req) {
  if (!pool || !dbReady) return null;
  const token = extrairCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.team, u.is_active, u.created_at, u.updated_at, u.last_login_at, u.deleted_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE AND u.deleted_at IS NULL`,
    [hashToken(token)]
  );
  const user = result.rows[0] || null;
  if (user) {
    await pool.query(
      "UPDATE sessions SET expires_at = NOW() + ($2 * INTERVAL '1 hour') WHERE token_hash = $1",
      [hashToken(token), SESSION_HORAS]
    );
  }
  return user;
}
function exigirAutenticacao(req, res, next) {
  exigirBanco(req, res, () => {
    usuarioDaRequisicao(req).then(user => {
      if (!user) {
        limparCookie(res, req);
        return res.status(401).json({ ok: false, message: 'SessÃÂÃÂ£o encerrada. Entre novamente.' });
      }
      req.user = user;
      next();
    }).catch(err => {
      console.error('Falha na autenticaÃÂÃÂ§ÃÂÃÂ£o:', err.message);
      res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel validar a sessÃÂÃÂ£o.' });
    });
  });
}
function exigirAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, message: 'Acesso restrito ao administrador.' });
  next();
}
async function registrarAuditoria(actorId, acao, alvoId = null, detalhes = {}) {
  if (!pool || !dbReady) return;
  await pool.query(
    'INSERT INTO audit_log (actor_user_id, action, target_user_id, details) VALUES ($1, $2, $3, $4::jsonb)',
    [actorId || null, acao, alvoId, JSON.stringify(detalhes || {})]
  );
}
function encerrarConexoesUsuario(userId, motivo = 'SessÃÂÃÂ£o encerrada pelo administrador') {
  for (const [ws, cliente] of clientes.entries()) {
    if (cliente.user && cliente.user.id === userId) {
      try { ws.close(1008, motivo); } catch {}
      clientes.delete(ws);
    }
  }
}
function dadosAtendimento(row) {
  const record = normalizarRegistro(row.record);
  record.recordId = row.record_id;
  if (row.status) record.status = row.status;
  if (row.received_at) record.recebidoEm = row.received_at;
  if (row.refused_at) record.recusadoEm = row.refused_at;
  if (row.refusal_reason) record.motivoRecusa = row.refusal_reason;
  return {
    recordId: row.record_id, record, ownerId: row.owner_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    receivedAt: row.received_at, refusedAt: row.refused_at,
    refusalReason: row.refusal_reason, status: row.status,
    refusalConfirmedAt: row.refusal_confirmed_at || null,
    guicheArchivedAt: row.guiche_archived_at || null,
    mesaArchivedAt: row.mesa_archived_at || null
  };
}

// A data de referÃÂÃÂªncia do backup semanal ÃÂÃÂ© a data agendada no formulÃÂÃÂ¡rio,
// independente de quando o atendimento foi criado ou atualizado.
const DATA_AGENDADA_SQL = `CASE
  WHEN COALESCE(record->>'dataAtendimento', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN record->>'dataAtendimento'
  WHEN COALESCE(record->>'dataAtendimento', '') ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
    THEN substring(record->>'dataAtendimento' from 7 for 4) || '-' || substring(record->>'dataAtendimento' from 4 for 2) || '-' || substring(record->>'dataAtendimento' from 1 for 2)
  ELSE NULL
END`;

function lerPeriodoSemanal(req, res) {
  const inicio = typeof req.query.from === 'string' ? req.query.from : '';
  const fim = typeof req.query.to === 'string' ? req.query.to : '';
  const formatoISO = /^\d{4}-\d{2}-\d{2}$/;
  const dataValida = valor => {
    if (!formatoISO.test(valor)) return false;
    const d = new Date(`${valor}T00:00:00.000Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === valor;
  };
  if (!dataValida(inicio) || !dataValida(fim)) {
    res.status(400).json({ ok: false, message: 'Informe inÃÂÃÂ­cio e fim da semana no formato AAAA-MM-DD.' });
    return null;
  }
  const inicioMs = Date.parse(`${inicio}T00:00:00.000Z`);
  const fimMs = Date.parse(`${fim}T00:00:00.000Z`);
  const dias = (fimMs - inicioMs) / 86400000 + 1;
  if (dias !== 7 || new Date(inicioMs).getUTCDay() !== 1 || new Date(fimMs).getUTCDay() !== 0) {
    res.status(400).json({ ok: false, message: 'O backup semanal precisa cobrir uma semana completa, de segunda-feira a domingo.' });
    return null;
  }
  return { from: inicio, to: fim, basis: 'dataAtendimento', basisLabel: 'Data do Atendimento do formulÃÂÃÂ¡rio (data agendada)' };
}

function dataAgendadaParaExcel(valor) {
  const texto = String(valor || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return null;
}
function dataHoraParaExcel(valor) {
  if (!valor) return '';
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) ? data : '';
}
function statusParaExcel(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'aguardando_mesa') return 'Aguardando Mesa';
  if (status === 'recebido') return 'Recebido';
  if (status === 'recusado') return 'Recusado';
  if (status === 'guardado') return 'Guardado';
  return status || 'NÃÂÃÂ£o informado';
}
function nomeArquivoSeguro(valor) {
  const seguro = String(valor || 'conta').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70);
  return seguro || 'conta';
}
async function consultarAtendimentosSemana(periodo, ownerId = null) {
  const parametros = [periodo.from, periodo.to];
  let filtroConta = '';
  if (ownerId) {
    parametros.push(ownerId);
    filtroConta = ' AND a.owner_id=$3';
  }
  const result = await pool.query(
    `SELECT a.*, u.username AS owner_username, u.full_name AS owner_full_name
       FROM attendances a LEFT JOIN users u ON u.id=a.owner_id
      WHERE ${DATA_AGENDADA_SQL} BETWEEN $1 AND $2${filtroConta}
      ORDER BY ${DATA_AGENDADA_SQL}, a.created_at`,
    parametros
  );
  return result.rows;
}
async function criarPlanilhaAtendimentos({ periodo, rows, titulo, escopo }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sistema Atendimento CPAIG';
  workbook.subject = 'Backup semanal de atendimentos';
  workbook.title = titulo;
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties = { date1904: false };

  const resumo = workbook.addWorksheet('Resumo');
  resumo.columns = [{ width: 34 }, { width: 70 }];
  resumo.addRow([titulo]);
  resumo.mergeCells('A1:B1');
  resumo.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  resumo.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF20252B' } };
  resumo.addRow(['PerÃÂÃÂ­odo pela Data do Atendimento', `${periodo.from} a ${periodo.to}`]);
  resumo.addRow(['CritÃÂÃÂ©rio', 'Data agendada no formulÃÂÃÂ¡rio; nÃÂÃÂ£o ÃÂÃÂ© a data de envio.']);
  resumo.addRow(['Escopo da cÃÂÃÂ³pia', escopo]);
  resumo.addRow(['Gerado em', new Date()]);
  resumo.getCell('B5').numFmt = 'dd/mm/yyyy hh:mm';
  resumo.addRow(['Total de atendimentos', rows.length]);
  resumo.addRow([]);
  resumo.addRow(['SituaÃÂÃÂ§ÃÂÃÂ£o', 'Quantidade']);
  resumo.getRow(8).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  resumo.getRow(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF46515C' } };
  const contagem = new Map();
  for (const row of rows) {
    const label = statusParaExcel(row);
    contagem.set(label, (contagem.get(label) || 0) + 1);
  }
  for (const [label, count] of [...contagem.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))) resumo.addRow([label, count]);
  resumo.views = [{ state: 'frozen', ySplit: 1 }];

  const sheet = workbook.addWorksheet('Atendimentos', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [
    'Data do Atendimento', 'Nome do Interno', 'RGI', 'PavilhÃÂÃÂ£o', 'Cela', 'Atendimento', 'Assunto',
    'SituaÃÂÃÂ§ÃÂÃÂ£o', 'Login de origem', 'Nome do GuichÃÂÃÂª', 'Enviado em', 'Recebido em', 'Recusado em',
    'Motivo da recusa', 'Guardado no GuichÃÂÃÂª', 'Guardado na Mesa', 'ID do registro'
  ];
  sheet.columns = [
    { width: 18 }, { width: 32 }, { width: 18 }, { width: 14 }, { width: 10 }, { width: 24 },
    { width: 46 }, { width: 19 }, { width: 22 }, { width: 30 }, { width: 22 }, { width: 22 },
    { width: 22 }, { width: 40 }, { width: 20 }, { width: 20 }, { width: 40 }
  ];
  sheet.addRow(headers);
  const cabecalho = sheet.getRow(1);
  cabecalho.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecalho.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF20252B' } };
  cabecalho.alignment = { vertical: 'middle', wrapText: true };
  cabecalho.height = 32;

  for (const row of rows) {
    const record = normalizarRegistro(row.record);
    sheet.addRow([
      dataAgendadaParaExcel(record.dataAtendimento) || '',
      String(record.nome || ''), String(record.rgi || record.identificacao || ''),
      String(record.pavilhao || ''), String(record.cela || ''), String(record.atendimento || ''),
      String(record.assunto || ''), statusParaExcel(row), String(row.owner_username || '(conta excluÃÂÃÂ­da)'),
      String(row.owner_full_name || ''), dataHoraParaExcel(row.created_at),
      dataHoraParaExcel(row.received_at), dataHoraParaExcel(row.refused_at),
      String(row.refusal_reason || record.motivoRecusa || ''), row.guiche_archived_at ? 'Sim' : 'NÃÂÃÂ£o',
      row.mesa_archived_at ? 'Sim' : 'NÃÂÃÂ£o', String(row.record_id || '')
    ]);
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  [1].forEach(n => { sheet.getColumn(n).numFmt = 'dd/mm/yyyy'; });
  [11, 12, 13].forEach(n => { sheet.getColumn(n).numFmt = 'dd/mm/yyyy hh:mm'; });
  for (let r = 2; r <= rows.length + 1; r++) {
    const row = sheet.getRow(r);
    row.alignment = { vertical: 'top', wrapText: true };
    if (r % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F5F8' } };
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
async function criarZipPlanilhas(entries) {
  return new Promise((resolve, reject) => {
    const zip = archiver('zip', { zlib: { level: 8 } });
    const partes = [];
    zip.on('data', parte => partes.push(parte));
    zip.on('warning', erro => { if (erro.code === 'ENOENT') return; reject(erro); });
    zip.on('error', reject);
    zip.on('end', () => resolve(Buffer.concat(partes)));
    for (const entry of entries) zip.append(entry.buffer, { name: entry.name });
    try { zip.finalize(); } catch (erro) { reject(erro); }
  });
}

async function inicializarBanco() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_normalized TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','guiche','mesa','pertences','chefe','auxiliar')),
      team TEXT CHECK (team IN ('A','B','C','D')),
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_single_active_mesa ON users(role) WHERE role = 'mesa' AND is_active = TRUE AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS users_role_active_idx ON users(role, is_active);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS attendances (
      record_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      record JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'aguardando_mesa',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      received_at TIMESTAMPTZ,
      refused_at TIMESTAMPTZ,
      refusal_reason TEXT,
      refusal_confirmed_at TIMESTAMPTZ,
      guiche_archived_at TIMESTAMPTZ,
      mesa_archived_at TIMESTAMPTZ
    );
    ALTER TABLE attendances ADD COLUMN IF NOT EXISTS refusal_confirmed_at TIMESTAMPTZ;
    ALTER TABLE attendances ADD COLUMN IF NOT EXISTS guiche_archived_at TIMESTAMPTZ;
    ALTER TABLE attendances ADD COLUMN IF NOT EXISTS mesa_archived_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS attendances_owner_created_idx ON attendances(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS attendances_status_idx ON attendances(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS internal_base (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      target_user_id TEXT REFERENCES users(id),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','guiche','mesa','pertences','chefe','auxiliar'));
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_check;
    ALTER TABLE users ADD CONSTRAINT users_team_check CHECK (team IS NULL OR team IN ('A','B','C','D'));
    CREATE INDEX IF NOT EXISTS users_team_role_idx ON users(team, role) WHERE is_active=TRUE AND deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_one_report_role_per_team_idx ON users(team, role) WHERE role IN ('chefe','auxiliar') AND is_active=TRUE AND deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS shift_reports (
      id TEXT PRIMARY KEY, team TEXT NOT NULL CHECK (team IN ('A','B','C','D')),
      report_date DATE NOT NULL, shift_name TEXT NOT NULL DEFAULT 'PlantÃÂ£o',
      title TEXT NOT NULL DEFAULT '', content JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','encerrado')),
      revision INTEGER NOT NULL DEFAULT 1, created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ, closed_by TEXT REFERENCES users(id),
      reopened_at TIMESTAMPTZ, reopened_by TEXT REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS shift_reports_team_date_shift_idx ON shift_reports(team, report_date, shift_name);
    CREATE INDEX IF NOT EXISTS shift_reports_date_idx ON shift_reports(report_date DESC, team);
    CREATE TABLE IF NOT EXISTS shift_report_history (
      id BIGSERIAL PRIMARY KEY, report_id TEXT NOT NULL REFERENCES shift_reports(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id), action TEXT NOT NULL, revision INTEGER NOT NULL,
      previous_content JSONB, new_content JSONB, details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS shift_report_history_report_idx ON shift_report_history(report_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
    
CREATE TABLE IF NOT EXISTS shift_he_names (
  id BIGSERIAL PRIMARY KEY,
  team TEXT NOT NULL CHECK (team IN ('A','B','C','D')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team, normalized_name)
);
  `);
  await inicializarPertencesVisitas(pool);
  await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  await garantirAdministradorInicial();
  await restaurarFilasDoBanco();
}
async function garantirAdministradorInicial() {
  const username = textoSeguro(process.env.BOOTSTRAP_ADMIN_USERNAME, 80);
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  if (!username || !password) {
    console.warn('BOOTSTRAP_ADMIN_USERNAME/BOOTSTRAP_ADMIN_PASSWORD nÃÂÃÂ£o configurados. Se nÃÂÃÂ£o houver administrador no banco, configure-os no Render.');
    return;
  }
  if (password.length < 10) {
    console.warn('A senha inicial do administrador precisa ter pelo menos 10 caracteres; conta inicial nÃÂÃÂ£o criada.');
    return;
  }
  const normalizado = normalizarUsuario(username);
  const atual = await pool.query('SELECT id FROM users WHERE username_normalized = $1', [normalizado]);
  if (atual.rowCount) return;
  const id = criarId();
  const hash = await criarHashSenha(password);
  await pool.query(
    `INSERT INTO users (id, username, username_normalized, full_name, role, password_hash)
     VALUES ($1, $2, $3, $4, 'admin', $5)`,
    [id, username, normalizado, textoSeguro(process.env.BOOTSTRAP_ADMIN_FULL_NAME || 'Administrador do Sistema', 120), hash]
  );
  console.log('Conta inicial de administrador criada a partir das variÃÂÃÂ¡veis de ambiente.');
}
async function restaurarFilasDoBanco() {
  const result = await pool.query('SELECT * FROM attendances');
  pendentes.clear();
  recusasPendentes.clear();
  recebidos.clear();
  for (const row of result.rows) {
    const item = dadosAtendimento(row);
    if (row.status === 'aguardando_mesa') {
      pendentes.set(row.record_id, {
        recordId: row.record_id, ownerId: row.owner_id,
        record: item.record, createdAt: row.created_at, updatedAt: row.updated_at
      });
    } else if (row.status === 'recusado' && !row.refusal_confirmed_at) {
      recusasPendentes.set(row.record_id, {
        recordId: row.record_id, ownerId: row.owner_id, record: item.record,
        reason: row.refusal_reason || item.record.motivoRecusa || 'Motivo nÃÂÃÂ£o informado',
        refusedAt: row.refused_at || row.updated_at
      });
    }
    if (row.received_at) receivedosSet(row.record_id, row.owner_id, row.received_at);
  }
}
function receivedosSet(recordId, ownerId, receivedAt) {
  recebidos.set(recordId, { recordId, ownerId, receivedAt });
}

async function redirecionarParaAreaDoUsuario(req, res) {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) return res.redirect('/login.html');
    if (user.role === 'admin') return res.redirect('/admin.html');
    if (user.role === 'mesa') return res.redirect('/mesa.html');
    if (user.role === 'pertences') return res.redirect('/pertences.html');
    if (['chefe','auxiliar'].includes(user.role)) return res.redirect('/relatorios.html');
    return res.redirect('/index.html');
  } catch {
    return res.redirect('/login.html');
  }
}
app.get('/', redirecionarParaAreaDoUsuario);
app.get('/login.html', async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (user) {
      if (user.role === 'admin') return res.redirect('/admin.html');
      if (user.role === 'mesa') return res.redirect('/mesa.html');
      if (user.role === 'pertences') return res.redirect('/pertences.html');
      if (['chefe','auxiliar'].includes(user.role)) return res.redirect('/relatorios.html');
      return res.redirect('/index.html');
    }
  } catch {}
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/index.html', async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) return res.redirect('/login.html');
    if (user.role === 'pertences') return res.redirect('/pertences.html');
    if (['chefe','auxiliar'].includes(user.role)) return res.redirect('/relatorios.html');
    if (!['guiche', 'admin'].includes(user.role)) return res.redirect('/mesa.html');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  } catch { return res.redirect('/login.html'); }
});
app.get('/mesa.html', async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) return res.redirect('/login.html');
    if (user.role === 'pertences') return res.redirect('/pertences.html');
    if (['chefe','auxiliar'].includes(user.role)) return res.redirect('/relatorios.html');
    if (!['mesa', 'admin'].includes(user.role)) return res.redirect('/index.html');
    return res.sendFile(path.join(PUBLIC_DIR, 'mesa.html'));
  } catch { return res.redirect('/login.html'); }
});
app.get('/admin.html', async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) return res.redirect('/login.html');
    if (user.role !== 'admin') return res.redirect(user.role === 'mesa' ? '/mesa.html' : user.role === 'pertences' ? '/pertences.html' : ['chefe','auxiliar'].includes(user.role) ? '/relatorios.html' : '/index.html');
    return res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  } catch { return res.redirect('/login.html'); }
});
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSAO, databaseConfigured: Boolean(pool), databaseReady: dbReady, clients: clientes.size, pendingRecords: pendentes.size, pendingRefusals: recusasPendentes.size, timestamp: agoraISO() }));
app.get('/status', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  const result = await pool.query(`SELECT u.username, u.role, u.is_active, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at > NOW() ORDER BY u.username`);
  res.json({ ok: true, version: VERSAO, connectedSessions: result.rows, pendentes: pendentes.size, recusasPendentes: recusasPendentes.size });
});

app.post('/api/auth/login', exigirBanco, async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const username = textoSeguro(req.body?.username, 80);
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ ok: false, message: 'Informe o usuÃÂÃÂ¡rio e a senha.' });
  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE username_normalized=$1 AND is_active=TRUE AND deleted_at IS NULL`,
      [normalizarUsuario(username)]
    );
    const user = result.rows[0];
    const valid = user && await verificarSenha(password, user.password_hash);
    if (!valid) {
      await registrarAuditoria(null, 'login_falha', null, {
        username: normalizarUsuario(username),
        ip,
        motivo: user ? 'senha_invalida' : 'usuario_inexistente'
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      return res.status(401).json({ ok: false, message: 'UsuÃÂÃÂ¡rio ou senha invÃÂÃÂ¡lidos.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_HORAS * 60 * 60 * 1000);
    await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [hashToken(token), user.id, expires]);
    await pool.query('UPDATE users SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1', [user.id]);
    await registrarAuditoria(user.id, 'login', user.id, {});
    definirCookie(res, token, req);
    res.json({ ok: true, user: usuarioPublico({ ...user, last_login_at: new Date().toISOString() }) });
  } catch (e) {
    console.error('Erro no login:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel entrar. Verifique a configuraÃÂÃÂ§ÃÂÃÂ£o do banco.' });
  }
});
app.get('/api/auth/me', exigirBanco, async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) { limparCookie(res, req); return res.status(401).json({ ok: false, message: 'SessÃÂÃÂ£o nÃÂÃÂ£o encontrada.' }); }
    res.json({ ok: true, user: usuarioPublico(user) });
  } catch (e) { res.status(500).json({ ok: false, message: 'Erro ao consultar a sessÃÂÃÂ£o.' }); }
});
app.post('/api/auth/logout', exigirBanco, async (req, res) => {
  const token = extrairCookie(req, SESSION_COOKIE);
  if (token) {
    try {
      const tokenHash = hashToken(token);
      const sessao = await pool.query('SELECT user_id FROM sessions WHERE token_hash=$1', [tokenHash]);
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
      for (const [ws, cliente] of clientes.entries()) {
        if (cliente.sessionHash === tokenHash) {
          try { ws.close(1000, 'SessÃÂÃÂ£o encerrada'); } catch {}
          clientes.delete(ws);
        }
      }
      if (sessao.rows[0]) await registrarAuditoria(sessao.rows[0].user_id, 'logout', sessao.rows[0].user_id, {});
    } catch (e) { console.error('Erro ao encerrar sessÃÂÃÂ£o:', e.message); }
  }
  limparCookie(res, req);
  res.json({ ok: true });
});

app.get('/api/internals/base', exigirBanco, exigirAutenticacao, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT b.items, b.updated_at, u.username AS updated_by FROM internal_base b LEFT JOIN users u ON u.id=b.updated_by WHERE b.singleton_id=1`);
    const row = result.rows[0];
    res.json({ ok: true, items: row?.items || [], updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar a base de internos.' }); }
});
app.put('/api/internals/base', exigirBanco, exigirAutenticacao, async (req, res) => {
  // Qualquer conta autenticada pode atualizar a base comum, conforme requisito do sistema.
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, message: 'A lista de internos nÃÂÃÂ£o tem formato vÃÂÃÂ¡lido.' });
  if (items.length > 100000) return res.status(413).json({ ok: false, message: 'A planilha ultrapassa o limite de 100.000 registros.' });
  const limpos = [];
  const vistos = new Set();
  for (const item of items) {
    const nome = textoSeguro(item?.nome, 200);
    if (!nome) continue;
    const rgi = textoSeguro(item?.rgi, 80);
    const chave = `${normalizarUsuario(nome)}|${rgi}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    limpos.push({ nome, rgi, pavilhao: textoSeguro(item?.pavilhao, 100), cela: textoSeguro(item?.cela, 30) });
  }
  try {
    const result = await pool.query(
      `INSERT INTO internal_base(singleton_id, items, updated_by, updated_at) VALUES (1,$1::jsonb,$2,NOW())
       ON CONFLICT(singleton_id) DO UPDATE SET items=EXCLUDED.items, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING updated_at`,
      [JSON.stringify(limpos), req.user.id]
    );
    await registrarAuditoria(req.user.id, 'base_internos_atualizada', null, { quantidade: limpos.length });
    transmitirBaseAtualizada({ updatedAt: result.rows[0].updated_at, updatedBy: req.user.username, count: limpos.length });
    res.json({ ok: true, items: limpos, count: limpos.length, updatedAt: result.rows[0].updated_at, updatedBy: req.user.username });
  } catch (e) {
    console.error('Erro salvando base:', e.message);
    res.status(500).json({ ok: false, message: 'Falha ao salvar a base compartilhada no Neon.' });
  }
});
function transmitirBaseAtualizada(info) {
  const msg = { type: 'base_internos_atualizada', ...info };
  for (const c of clientes.values()) if (c.user && c.ws.readyState === WebSocket.OPEN) enviar(c.ws, msg);
}

app.get('/api/me/attendances', exigirBanco, exigirAutenticacao, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attendances WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 5000', [req.user.id]);
    res.json({ ok: true, attendances: result.rows.map(row => ({
      ...dadosAtendimento(row),
      status: row.guiche_archived_at ? 'guardado' : row.status,
      record: normalizarRegistro(row.record), sentAt: row.created_at
    })) });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar o histÃÂÃÂ³rico desta conta.' }); }
});
app.get('/api/me/backup-data', exigirBanco, exigirAutenticacao, async (req, res) => {
  if (!['guiche', 'mesa', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: 'Esta conta nÃÂÃÂ£o pode gerar backup de atendimentos.' });
  }
  const periodo = lerPeriodoSemanal(req, res);
  if (!periodo) return;
  try {
    const params = [periodo.from, periodo.to];
    let filtro = `${DATA_AGENDADA_SQL} BETWEEN $1 AND $2`;
    if (req.user.role === 'guiche') {
      params.push(req.user.id);
      filtro += ` AND owner_id=$3`;
    } else if (req.user.role === 'mesa') {
      filtro += ` AND status <> 'recusado'`;
    }
    const result = await pool.query(
      `SELECT * FROM attendances WHERE ${filtro} ORDER BY ${DATA_AGENDADA_SQL}, created_at`,
      params
    );
    const attendances = result.rows.map(row => {
      const item = dadosAtendimento(row);
      if (req.user.role === 'guiche' && row.guiche_archived_at) item.status = 'guardado';
      if (req.user.role === 'mesa' && row.mesa_archived_at) item.status = 'guardado';
      return item;
    });
    res.json({
      ok: true,
      format: 'sistema-atendimento-backup-conta',
      version: VERSAO,
      generatedAt: agoraISO(),
      account: { username: req.user.username, fullName: req.user.full_name, role: req.user.role },
      scope: req.user.role === 'guiche'
        ? 'Somente atendimentos pertencentes a esta conta do GuichÃÂÃÂª.'
        : req.user.role === 'mesa'
          ? 'Atendimentos nÃÂÃÂ£o recusados visÃÂÃÂ­veis ÃÂ  Mesa.'
          : 'Atendimentos de todas as contas, conforme acesso administrativo.',
      period: periodo,
      count: attendances.length,
      attendances
    });
  } catch (e) {
    console.error('Erro gerando backup da conta:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o backup semanal desta conta.' });
  }
});

app.post('/api/me/import-legacy', exigirBanco, exigirAutenticacao, async (req, res) => {
  if (!['guiche', 'admin'].includes(req.user.role)) return res.status(403).json({ ok: false, message: 'Somente contas do GuichÃÂÃÂª podem importar o histÃÂÃÂ³rico local.' });
  const lista = req.body?.attendances;
  if (!Array.isArray(lista)) return res.status(400).json({ ok: false, message: 'Formato do histÃÂÃÂ³rico local invÃÂÃÂ¡lido.' });
  if (lista.length > 10000) return res.status(413).json({ ok: false, message: 'O histÃÂÃÂ³rico local ultrapassa 10.000 registros; faÃÂÃÂ§a a migraÃÂÃÂ§ÃÂÃÂ£o em partes.' });
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM attendances WHERE owner_id=$1', [req.user.id]);
    if (count.rows[0].total > 0) return res.json({ ok: true, skipped: true, imported: 0, message: 'Esta conta jÃÂÃÂ¡ tem histÃÂÃÂ³rico no servidor; a importaÃÂÃÂ§ÃÂÃÂ£o local foi ignorada para evitar misturar contas.' });
    const client = await pool.connect();
    let imported = 0;
    try {
      await client.query('BEGIN');
      for (const raw of lista) {
        const item = normalizarRegistro(raw);
        const id = textoSeguro(item.recordId || item.id, 180);
        if (!id) continue;
        const registro = normalizarRegistro(item.registro || item.record || item);
        const statusSolicitado = textoSeguro(item.status || registro.status || 'aguardando_mesa', 40);
        const received = item.recebidoEm || item.receivedAt || registro.recebidoEm || null;
        const refused = item.recusadoEm || item.refusedAt || registro.recusadoEm || null;
        const reason = textoSeguro(item.motivoRecusa || item.reason || registro.motivoRecusa || '', 2000) || null;
        let status = ['aguardando_mesa', 'recebido', 'recusado', 'guardado'].includes(statusSolicitado) ? statusSolicitado : 'aguardando_mesa';
        const arquivado = status === 'guardado';
        if (arquivado) status = (reason || refused) ? 'recusado' : (received ? 'recebido' : 'aguardando_mesa');
        const enviado = item.enviadoEm || item.createdAt || registro.enviadoEm || agoraISO();
        if (status === 'recusado') { registro.status = 'recusado'; if (reason) registro.motivoRecusa = reason; if (refused) registro.recusadoEm = refused; }
        else { registro.status = status; }
        if (arquivado && !registro.guardadoEm) registro.guardadoEm = item.guardadoEm || agoraISO();
        const inserted = await client.query(
          `INSERT INTO attendances (record_id,owner_id,record,status,created_at,updated_at,received_at,refused_at,refusal_reason,refusal_confirmed_at,guiche_archived_at,mesa_archived_at)
           VALUES ($1,$2,$3::jsonb,$4,COALESCE($5::timestamptz,NOW()),NOW(),$6,$7,$8,CASE WHEN $4='recusado' THEN NOW() ELSE NULL END,CASE WHEN $9::boolean THEN COALESCE($10::timestamptz,NOW()) ELSE NULL END,NULL)
           ON CONFLICT(record_id) DO NOTHING`,
          [id, req.user.id, JSON.stringify(registro), status, enviado, received, refused, reason, arquivado, item.guardadoEm || null]
        );
        imported += inserted.rowCount;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    if (imported) await registrarAuditoria(req.user.id, 'historico_local_importado', req.user.id, { quantidade: imported });
    await restaurarFilasDoBanco();
    res.json({ ok: true, imported, message: `${imported} registro(s) local(is) importado(s).` });
  } catch (e) {
    console.error('Erro importando histÃÂÃÂ³rico local:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel migrar o histÃÂÃÂ³rico local para o Neon.' });
  }
});

app.get('/api/mesa/attendances', exigirBanco, exigirAutenticacao, async (req, res) => {
  if (!['mesa', 'admin'].includes(req.user.role)) return res.status(403).json({ ok: false, message: 'Acesso restrito ÃÂ  Mesa.' });
  try {
    const result = await pool.query("SELECT * FROM attendances WHERE status <> 'recusado' ORDER BY created_at DESC LIMIT 10000");
    res.json({ ok: true, attendances: result.rows.map(row => ({
      ...normalizarRegistro(row.record),
      recordId: row.record_id,
      status: row.mesa_archived_at ? 'guardado' : row.status,
      enviadoEm: row.created_at,
      recebidoEm: row.received_at,
      motivoRecusa: row.refusal_reason,
      recusadoEm: row.refused_at,
      guardadoEm: normalizarRegistro(row.record).guardadoEm || null,
      ownerId: row.owner_id
    })) });
  } catch (e) { console.error('Erro carregando histÃÂÃÂ³rico da Mesa:', e.message); res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar os atendimentos da Mesa.' }); }
});

app.get('/api/admin/overview', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  try {
    const [users, records, base] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active=TRUE AND deleted_at IS NULL)::int AS active FROM users`),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='aguardando_mesa')::int AS pending, COUNT(*) FILTER (WHERE status='recebido')::int AS received, COUNT(*) FILTER (WHERE status='recusado')::int AS refused FROM attendances`),
      pool.query('SELECT jsonb_array_length(items) AS count, updated_at FROM internal_base WHERE singleton_id=1')
    ]);
    res.json({ ok: true, users: users.rows[0], attendances: records.rows[0], base: base.rows[0] || { count: 0, updated_at: null }, version: VERSAO });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar o resumo administrativo.' }); }
});
app.get('/api/admin/users', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY CASE role WHEN \'admin\' THEN 1 WHEN \'chefe\' THEN 2 WHEN \'auxiliar\' THEN 3 WHEN \'mesa\' THEN 4 ELSE 5 END, username_normalized');
    res.json({ ok: true, users: result.rows.map(usuarioPublico) });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel listar as contas.' }); }
});
app.post('/api/admin/users', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const username = textoSeguro(req.body?.username, 80);
  const fullName = textoSeguro(req.body?.fullName, 120);
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'guiche');
  const team = ['chefe','auxiliar'].includes(role) ? String(req.body?.team || '').toUpperCase() : null;
  const normalized = normalizarUsuario(username);
  if (!/^[\p{L}\p{N}._-]{3,80}$/u.test(username)) return res.status(400).json({ ok: false, message: 'O login deve ter de 3 a 80 caracteres, usando letras, nÃÂÃÂºmeros, ponto, hÃÂÃÂ­fen ou sublinhado.' });
  if (!fullName) return res.status(400).json({ ok: false, message: 'Informe o nome do usuÃÂÃÂ¡rio.' });
  if (password.length < 8) return res.status(400).json({ ok: false, message: 'A senha deve ter pelo menos 8 caracteres.' });
  if (!['guiche', 'mesa', 'admin', 'pertences', 'chefe', 'auxiliar'].includes(role)) return res.status(400).json({ ok: false, message: 'Tipo de conta invÃÂÃÂ¡lido.' });
  if (['chefe','auxiliar'].includes(role) && !['A','B','C','D'].includes(team)) return res.status(400).json({ ok: false, message: 'Selecione a equipe A, B, C ou D.' });
  try {
    const id = criarId();
    const passwordHash = await criarHashSenha(password);
    await pool.query(`INSERT INTO users (id,username,username_normalized,full_name,role,team,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, username, normalized, fullName, role, team, passwordHash]);
    await registrarAuditoria(req.user.id, 'conta_criada', id, { username, role, team });
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    res.status(201).json({ ok: true, user: usuarioPublico(user) });
  } catch (e) {
    if (e.code === '23505' && String(e.constraint || '').includes('users_one_report_role_per_team_idx')) return res.status(409).json({ ok: false, message: 'JÃÂ¡ existe uma conta ativa desse perfil nesta equipe. Cada equipe pode ter um chefe e um auxiliar ativos.' });
    if (e.code === '23505' && String(e.constraint || '').includes('pertences')) return res.status(409).json({ ok: false, message: 'JÃÂÃÂ¡ existe um login ativo de Pertences e Visitas. Desative a conta existente antes de criar outra.' });
    if (e.code === '23505' && String(e.constraint || '').includes('mesa')) return res.status(409).json({ ok: false, message: 'JÃÂÃÂ¡ existe um login ativo da Mesa. Edite ou desative a conta existente antes de criar outra.' });
    if (e.code === '23505') return res.status(409).json({ ok: false, message: 'Este nome de usuÃÂÃÂ¡rio jÃÂÃÂ¡ existe.' });
    console.error('Erro criando conta:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel criar a conta.' });
  }
});
app.patch('/api/admin/users/:id', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const id = textoSeguro(req.params.id, 100);
  const fullName = req.body?.fullName == null ? null : textoSeguro(req.body.fullName, 120);
  const username = req.body?.username == null ? null : textoSeguro(req.body.username, 80);
  const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : null;
  const team = req.body?.team == null ? null : String(req.body.team).toUpperCase();
  if (fullName !== null && !fullName) return res.status(400).json({ ok: false, message: 'O nome nÃÂÃÂ£o pode ficar vazio.' });
  if (username !== null && !/^[\p{L}\p{N}._-]{3,80}$/u.test(username)) return res.status(400).json({ ok: false, message: 'Nome de usuÃÂÃÂ¡rio invÃÂÃÂ¡lido.' });
  if (isActive === false && id === req.user.id) return res.status(400).json({ ok: false, message: 'NÃÂÃÂ£o ÃÂÃÂ© possÃÂÃÂ­vel bloquear a prÃÂÃÂ³pria conta administrativa.' });
  try {
    const before = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    if (!before.rowCount) return res.status(404).json({ ok: false, message: 'Conta nÃÂÃÂ£o encontrada.' });
    const old = before.rows[0];
    if (isActive === false && old.role === 'admin' && old.is_active) {
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=TRUE AND deleted_at IS NULL`);
      if (count.rows[0].n <= 1) return res.status(400).json({ ok: false, message: 'NÃÂÃÂ£o ÃÂÃÂ© possÃÂÃÂ­vel bloquear o ÃÂÃÂºltimo administrador ativo.' });
    }
    const updated = await pool.query(
      `UPDATE users SET full_name=COALESCE($2,full_name), username=COALESCE($3,username), username_normalized=COALESCE($4,username_normalized), is_active=COALESCE($5,is_active), team=CASE WHEN $6::text IS NULL THEN team ELSE $6 END, updated_at=NOW(), deleted_at=CASE WHEN $5=FALSE THEN COALESCE(deleted_at,NOW()) WHEN $5=TRUE THEN NULL ELSE deleted_at END WHERE id=$1 RETURNING *`,
      [id, fullName, username, username === null ? null : normalizarUsuario(username), isActive, team]
    );
    if (isActive === false) { await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]); encerrarConexoesUsuario(id, 'Conta desativada'); }
    await registrarAuditoria(req.user.id, 'conta_atualizada', id, { username: updated.rows[0].username, isActive });
    res.json({ ok: true, user: usuarioPublico(updated.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ ok: false, message: 'Este nome de usuÃÂÃÂ¡rio jÃÂÃÂ¡ existe.' });
    console.error('Erro atualizando conta:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel atualizar a conta.' });
  }
});
app.post('/api/admin/users/:id/reset-password', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const id = textoSeguro(req.params.id, 100);
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ ok: false, message: 'A nova senha deve ter pelo menos 8 caracteres.' });
  try {
    const user = await pool.query('SELECT id, username FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!user.rowCount) return res.status(404).json({ ok: false, message: 'Conta nÃÂÃÂ£o encontrada.' });
    const hash = await criarHashSenha(password);
    await pool.query('UPDATE users SET password_hash=$2, updated_at=NOW() WHERE id=$1', [id, hash]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    encerrarConexoesUsuario(id, 'Senha redefinida pelo administrador');
    await registrarAuditoria(req.user.id, 'senha_redefinida', id, { username: user.rows[0].username });
    res.json({ ok: true, message: 'Senha redefinida. O usuÃÂÃÂ¡rio deverÃÂÃÂ¡ entrar novamente.' });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel redefinir a senha.' }); }
});
app.delete('/api/admin/users/:id', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const id = textoSeguro(req.params.id, 100);
  if (id === req.user.id) return res.status(400).json({ ok: false, message: 'NÃÂÃÂ£o ÃÂÃÂ© possÃÂÃÂ­vel excluir a prÃÂÃÂ³pria conta.' });
  try {
    const result = await pool.query('SELECT id, username, role, is_active FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, message: 'Conta nÃÂÃÂ£o encontrada.' });
    const user = result.rows[0];
    if (user.role === 'admin' && user.is_active) {
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=TRUE AND deleted_at IS NULL`);
      if (count.rows[0].n <= 1) return res.status(400).json({ ok: false, message: 'NÃÂÃÂ£o ÃÂÃÂ© possÃÂÃÂ­vel excluir o ÃÂÃÂºltimo administrador ativo.' });
    }
    await pool.query('UPDATE users SET is_active=FALSE, deleted_at=NOW(), updated_at=NOW() WHERE id=$1', [id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    encerrarConexoesUsuario(id, 'Conta excluÃÂÃÂ­da pelo administrador');
    await registrarAuditoria(req.user.id, 'conta_excluida', id, { username: user.username, role: user.role });
    res.json({ ok: true, message: 'Conta desativada e mantida no histÃÂÃÂ³rico para preservar os atendimentos anteriores.' });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel excluir a conta.' }); }
});
app.get('/api/admin/attendances', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.username AS owner_username, u.full_name AS owner_full_name
         FROM attendances a LEFT JOIN users u ON u.id=a.owner_id
        ORDER BY a.created_at DESC LIMIT 5000`
    );
    res.json({ ok: true, attendances: result.rows.map(row => ({
      ...dadosAtendimento(row), ownerUsername: row.owner_username || '(conta excluÃÂÃÂ­da)', ownerFullName: row.owner_full_name || ''
    })) });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar os atendimentos.' }); }
});

function exigirPerfilRelatorio(req, res, next) {
  if (!req.user || !['chefe','auxiliar','admin'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: 'Acesso restrito ÃÂ s contas de relatÃÂ³rio.' });
  }
  if (req.user.role !== 'admin' && !['A','B','C','D'].includes(req.user.team)) {
    return res.status(403).json({ ok: false, message: 'Esta conta nÃÂ£o possui equipe A, B, C ou D configurada.' });
  }
  next();
}
function estadoPlantaoRelatorio(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Campo_Grande', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(agora);
  const p = Object.fromEntries(partes.map(x => [x.type, x.value]));
  let ano = Number(p.year), mes = Number(p.month), dia = Number(p.day);
  const hora = Number(p.hour);
  if (hora < 8) {
    const anterior = new Date(Date.UTC(ano, mes - 1, dia) - 86400000);
    ano = anterior.getUTCFullYear(); mes = anterior.getUTCMonth() + 1; dia = anterior.getUTCDate();
  }
  const dataBase = Date.UTC(2026, 9, 16); // 16/10/2026 ÃÂ s 08h: equipe C
  const dataPlantao = Date.UTC(ano, mes - 1, dia);
  const dias = Math.floor((dataPlantao - dataBase) / 86400000);
  const ciclo = ((dias % 4) + 4) % 4;
  const equipes = ['C', 'D', 'A', 'B'];
  return {
    onDutyTeam: equipes[ciclo],
    shiftDate: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
  };
}

function exigirEquipeDePlantao(req, res) {
  const escala = estadoPlantaoRelatorio();
  if (req.user?.team === escala.onDutyTeam) return true;
  res.status(403).json({
    ok: false, code: 'FORA_DO_PLANTAO',
    message: `Abertura bloqueada. A equipe de plantÃÂ£o neste momento ÃÂ© a Equipe ${escala.onDutyTeam}. VocÃÂª pode consultar relatÃÂ³rios antigos, mas nÃÂ£o criar nem alterar relatÃÂ³rios fora do seu plantÃÂ£o.`,
    onDutyTeam: escala.onDutyTeam, shiftDate: escala.shiftDate
  });
  return false;
}

function relatorioPublico(row) {
  return { id: row.id, team: row.team, reportDate: row.report_date, shiftName: row.shift_name,
    title: row.title, content: row.content || {}, status: row.status, revision: row.revision,
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at,
    updatedAt: row.updated_at, closedAt: row.closed_at, closedBy: row.closed_by,
    reopenedAt: row.reopened_at, reopenedBy: row.reopened_by };
}
app.get('/relatorios.html', async (req, res) => {
  try {
    const user = await usuarioDaRequisicao(req);
    if (!user) return res.redirect('/login.html');
    if (!['chefe','auxiliar','admin'].includes(user.role)) return res.redirect(user.role === 'mesa' ? '/mesa.html' : user.role === 'pertences' ? '/pertences.html' : ['chefe','auxiliar'].includes(user.role) ? '/relatorios.html' : '/index.html');
    return res.sendFile(path.join(PUBLIC_DIR, 'relatorios.html'));
  } catch { return res.redirect('/login.html'); }
});

/* LISTA COMPARTILHADA DE NOMES Ã¢ÂÂ PLANTÃÂO EXTRAORDINÃÂRIO (HE) */

app.get('/api/relatorios/he-nomes',
  exigirBanco, exigirAutenticacao, exigirPerfilRelatorio,
  async (req, res) => {
    try {
      const team = req.user.role === 'admin' ? String(req.query.team || '') : req.user.team;

      if (team && !['A', 'B', 'C', 'D'].includes(team)) {
        return res.status(400).json({
          ok: false,
          message: 'Informe uma equipe vÃÂ¡lida.'
        });
      }

      const result = await pool.query(
        `SELECT MIN(id) AS id, name, MIN(normalized_name) AS normalized_name
         FROM shift_he_names
         GROUP BY normalized_name, name
         ORDER BY name ASC`,
        []
      );

      return res.json({ ok: true, names: result.rows });
    } catch (e) {
      console.error('Erro ao consultar nomes de HE:', e.message);
      return res.status(500).json({
        ok: false,
        message: 'NÃÂ£o foi possÃÂ­vel carregar os nomes de HE.'
      });
    }
  }
);

app.post('/api/relatorios/he-nomes',
  exigirBanco, exigirAutenticacao, exigirPerfilRelatorio,
  async (req, res) => {
    if (!['chefe', 'auxiliar'].includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        message: 'Somente chefe ou auxiliar podem alterar a lista.'
      });
    }

    const name = textoSeguro(req.body?.name, 120).trim();
    if (!name) {
      return res.status(400).json({
        ok: false,
        message: 'Informe o nome.'
      });
    }

    const normalizedName = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR');

    try {
      const result = await pool.query(
        `INSERT INTO shift_he_names (team, name, normalized_name, created_by, updated_by)
         SELECT equipes.team, $1, $2, $3, $3
         FROM (VALUES ('A'),('B'),('C'),('D')) AS equipes(team)
         ON CONFLICT (team, normalized_name) DO UPDATE SET name=EXCLUDED.name, updated_by=EXCLUDED.updated_by, updated_at=NOW()
         RETURNING id, name`,
        [name, normalizedName, req.user.id]
      );

      if (!result.rowCount) {
        return res.status(409).json({
          ok: false,
          message: 'Esse nome jÃÂ¡ existe na lista da equipe.'
        });
      }

      return res.status(201).json({
        ok: true,
        name: result.rows[0]
      });
    } catch (e) {
      console.error('Erro ao adicionar nome de HE:', e.message);
      return res.status(500).json({
        ok: false,
        message: 'NÃÂ£o foi possÃÂ­vel adicionar o nome.'
      });
    }
  }
);

app.patch('/api/relatorios/he-nomes/:id',
  exigirBanco, exigirAutenticacao, exigirPerfilRelatorio,
  async (req, res) => {
    if (!['chefe', 'auxiliar'].includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        message: 'Somente chefe ou auxiliar podem alterar a lista.'
      });
    }

    const id = Number(req.params.id);
    const name = textoSeguro(req.body?.name, 120).trim();

    if (!Number.isSafeInteger(id) || id < 1 || !name) {
      return res.status(400).json({
        ok: false,
        message: 'Informe um nome vÃÂ¡lido.'
      });
    }

    const normalizedName = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR');

    try {
      const result = await pool.query(
        `UPDATE shift_he_names
         SET name = $2, normalized_name = $3, updated_by = $4, updated_at = NOW()
         WHERE normalized_name = (SELECT normalized_name FROM shift_he_names WHERE id=$1)
         RETURNING id, name`,
        [id, name, normalizedName, req.user.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          ok: false,
          message: 'Nome nÃÂ£o encontrado nesta equipe.'
        });
      }

      return res.json({ ok: true, name: result.rows[0] });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'Esse nome jÃÂ¡ existe na lista da equipe.'
        });
      }

      console.error('Erro ao editar nome de HE:', e.message);
      return res.status(500).json({
        ok: false,
        message: 'NÃÂ£o foi possÃÂ­vel editar o nome.'
      });
    }
  }
);

app.delete('/api/relatorios/he-nomes/:id',
  exigirBanco, exigirAutenticacao, exigirPerfilRelatorio,
  async (req, res) => {
    if (!['chefe', 'auxiliar'].includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        message: 'Somente chefe ou auxiliar podem alterar a lista.'
      });
    }

    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        ok: false,
        message: 'Identificador invÃÂ¡lido.'
      });
    }

    try {
      const result = await pool.query(
        `DELETE FROM shift_he_names
         WHERE normalized_name = (SELECT normalized_name FROM shift_he_names WHERE id=$1)
         RETURNING id`,
        [id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          ok: false,
          message: 'Nome nÃÂ£o encontrado nesta equipe.'
        });
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('Erro ao excluir nome de HE:', e.message);
      return res.status(500).json({
        ok: false,
        message: 'NÃÂ£o foi possÃÂ­vel excluir o nome.'
      });
    }
  }
);

/* FIM DA LISTA COMPARTILHADA DE HE */

// Remove regras CSS iniciadas por @ antes da conversÃÂ£o para DOCX. Alguns conversores
// tentam interpretar regras como @page/@media como nomes XML e falham com "Invalid XML name: @w".
function limparRegrasAtCss(css) {
  let resultado = '';
  let posicao = 0;
  while (posicao < css.length) {
    const at = css.indexOf('@', posicao);
    if (at === -1) { resultado += css.slice(posicao); break; }
    resultado += css.slice(posicao, at);
    let abre = css.indexOf('{', at);
    const pontoVirgula = css.indexOf(';', at);
    if (pontoVirgula !== -1 && (abre === -1 || pontoVirgula < abre)) {
      posicao = pontoVirgula + 1;
      continue;
    }
    if (abre === -1) { break; }
    let profundidade = 1;
    let fim = abre + 1;
    while (fim < css.length && profundidade > 0) {
      if (css[fim] === '{') profundidade++;
      else if (css[fim] === '}') profundidade--;
      fim++;
    }
    posicao = fim;
  }
  return resultado;
}

function prepararHtmlParaDocx(html) {
  return html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (tag, atributos, css) =>
    '<style' + atributos + '>' + limparRegrasAtCss(css) + '</style>'
  );
}

// ExportaÃÂ§ÃÂ£o de Word gerada no servidor.
app.post('/api/relatorios/export-docx', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async (req, res) => {
  const html = req.body?.html;
  if (typeof html !== 'string' || !html.trim() || html.length > 12000000) {
    return res.status(400).json({ ok: false, message: 'O conteÃÂºdo do relatÃÂ³rio ÃÂ© invÃÂ¡lido ou muito grande.' });
  }
  try {
    const htmlSeguro = prepararHtmlParaDocx(html);
    const docx = await HTMLtoDOCX(htmlSeguro, null, {
      orientation: 'portrait',
      font: 'Times New Roman',
      fontSize: 22,
      margins: { top: 850, right: 900, bottom: 850, left: 900 },
      table: { row: { cantSplit: true } }
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="Relatorio_CPAIG.docx"');
    res.send(Buffer.from(docx));
  } catch (e) {
    console.error('Erro ao gerar DOCX do relatÃÂ³rio:', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, message: 'NÃÂ£o foi possÃÂ­vel gerar o arquivo Word no servidor.' });
  }
});

app.get('/api/relatorios', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async (req, res) => {
  try {
    const params = []; let where = '';
    if (req.user.role !== 'admin') { params.push(req.user.team); where = 'WHERE r.team=$1'; }
    const q = await pool.query(`SELECT r.*, c.username AS created_username, u.username AS updated_username, cl.username AS closed_username FROM shift_reports r LEFT JOIN users c ON c.id=r.created_by LEFT JOIN users u ON u.id=r.updated_by LEFT JOIN users cl ON cl.id=r.closed_by ${where} ORDER BY r.report_date DESC, r.team, r.shift_name`, params);
    const escala = estadoPlantaoRelatorio();
    res.json({ ok: true, reports: q.rows.map(r => ({ ...relatorioPublico(r), createdUsername:r.created_username, updatedUsername:r.updated_username, closedUsername:r.closed_username })), readOnly: req.user.role === 'admin', team: req.user.team || null, onDutyTeam: escala.onDutyTeam, shiftDate: escala.shiftDate, canWork: req.user.role === 'admin' || req.user.team === escala.onDutyTeam });
  } catch (e) { console.error('Falha ao listar relatÃÂ³rios:', e.message); res.status(500).json({ ok:false, message:'NÃÂ£o foi possÃÂ­vel carregar os relatÃÂ³rios.' }); }
});
app.get('/api/relatorios/dados-herdados', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ok:false,message:'Rota destinada ao preenchimento de relatórios das equipes.'});
  try {
    const escala = estadoPlantaoRelatorio();
    const q = await pool.query(
      `SELECT team, report_date, shift_name, title, content, revision
       FROM shift_reports
       WHERE report_date < $1::date
       ORDER BY report_date DESC, revision DESC, team
       LIMIT 1`,
      [escala.shiftDate]
    );
    // Dados da mesma equipe: o plantão anterior ocorre exatamente quatro dias antes.
    // Não selecionar relatórios intermediários abertos fora da sequência oficial.
    const sameTeam = await pool.query(
      `SELECT team, report_date, shift_name, title, content, revision
       FROM shift_reports
       WHERE team = $1 AND report_date = ($2::date - INTERVAL '4 days')::date
       ORDER BY revision DESC
       LIMIT 1`,
      [req.user.team, escala.shiftDate]
    );
    const equipeAnteriorMaterial = ({A:'D',B:'A',C:'B',D:'C'})[String(req.user.team||'').toUpperCase()];
    const materialAnterior = equipeAnteriorMaterial ? await pool.query(
      `SELECT team, report_date, shift_name, title, content, revision
       FROM shift_reports
       WHERE team = $1 AND report_date < $2::date
       ORDER BY report_date DESC, revision DESC
       LIMIT 1`,
      [equipeAnteriorMaterial, escala.shiftDate]
    ) : {rows:[]};
    const allowed = [
      '01 – RECEBIMENTO','31 – ENTRADA DE CUSTODIADOS','32 – SAÍDA DE CUSTODIADOS','02 – EQUIPE DE PLANTÃO (24x72h)',
      '07 – FÉRIAS','10 – ESCALA DIURNA','11 – ESCALA NOTURNA (MONITORAMENTO)',
      '12 – EXPEDIENTE','38 – MATERIAL / DOCUMENTO REPASSADO PARA O CHEFE DE EQUIPE',
      '39 – INFORMAÇÕES','40 – ENCERRAMENTO',
      '16 – MATERIAL CARGA','17 – VIATURAS','25 – HOSPITALIZADO',
      '25.1 – HOSPITALIZADO A CONFIRMAR','27 – ÓBITO','28 – LICENÇA JUDICIAL',
      '29 – LICENÇA JUDICIAL 7 DIAS (SAÍDA TEMPORÁRIA)',
      '29.1 – RETORNO DE LICENÇA JUDICIAL 7 DIAS (SAÍDA TEMPORÁRIA)',
      'ITEM 40 – QUEM ENCERRA O PLANTÃO','ITEM 40 – QUEM RECEBE O PLANTÃO',
      'ITEM 40 – SUBSTITUIÇÃO','ITEM 40 – POLICIAL SUBSTITUÍDO',
      'ASSINATURA – NOME COMPLETO DO POLICIAL','ASSINATURA – FUNÇÃO',
      'ASSINATURA – UNIDADE PENAL','ASSINATURA – MATRÍCULA',
      'ASSINATURA CHEFE DE EQUIPE — PASSA — NOME',
      'ASSINATURA CHEFE DE EQUIPE — PASSA — MATRÍCULA',
      'ASSINATURA CHEFE DE EQUIPE — RECEBE — NOME',
      'ASSINATURA CHEFE DE EQUIPE — RECEBE — MATRÍCULA'
    ];
    const safeReport = row => {
      if (!row) return null;
      const original = row.content && typeof row.content === 'object' ? row.content : {};
      const content = {};
      for (const key of allowed) if (Object.prototype.hasOwnProperty.call(original, key)) content[key] = original[key];
      return {team:row.team,reportDate:String(row.report_date).slice(0,10),shiftName:row.shift_name,title:row.title,content,revision:row.revision};
    };
    const materialRow=materialAnterior.rows[0]||null;const previousTeamSafe=safeReport(materialRow);const materialSafe=materialRow?{team:materialRow.team,reportDate:String(materialRow.report_date).slice(0,10),shiftName:materialRow.shift_name,title:materialRow.title,revision:materialRow.revision,content:Object.prototype.hasOwnProperty.call(materialRow.content||{},'16 – MATERIAL CARGA')?{'16 – MATERIAL CARGA':materialRow.content['16 – MATERIAL CARGA']}:{}}:null;return res.json({ok:true,report:safeReport(q.rows[0]||null),sameTeamReport:safeReport(sameTeam.rows[0]||null),previousTeamReport:previousTeamSafe,materialTeamReport:materialSafe});
  } catch (e) {
    console.error('Falha ao buscar dados herdados do plantão anterior:', e.message);
    return res.status(500).json({ok:false,message:'Não foi possível recuperar os dados necessários do plantão anterior.'});
  }
});

app.post('/api/relatorios', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ok:false,message:'O administrador possui acesso somente para consulta.'});
  if (!exigirEquipeDePlantao(req, res)) return;
  const reportDate = String(req.body?.reportDate || '').slice(0,10);
  const shiftName = textoSeguro(req.body?.shiftName || 'PlantÃÂ£o', 80);
  const title = textoSeguro(req.body?.title || '', 180);
  const content = req.body?.content && typeof req.body.content === 'object' && !Array.isArray(req.body.content) ? req.body.content : {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return res.status(400).json({ok:false,message:'Informe uma data vÃÂ¡lida para o relatÃÂ³rio.'});
  const escalaAtual = estadoPlantaoRelatorio();
  if (reportDate !== escalaAtual.shiftDate) return res.status(400).json({ok:false,code:'DATA_FORA_DO_PLANTAO',message:`A data do relatÃÂ³rio ÃÂ© definida pelo inÃÂ­cio do plantÃÂ£o vigente (${escalaAtual.shiftDate}). NÃÂ£o ÃÂ© permitido alterar a data para abrir outro plantÃÂ£o.`});
  const id = criarId();
  try {
    const q = await pool.query(`INSERT INTO shift_reports(id,team,report_date,shift_name,title,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7) RETURNING *`, [id, req.user.team, reportDate, shiftName, title, JSON.stringify(content), req.user.id]);
    await pool.query(`INSERT INTO shift_report_history(report_id,actor_user_id,action,revision,new_content,details) VALUES($1,$2,'criado',1,$3::jsonb,$4::jsonb)`, [id,req.user.id,JSON.stringify(content),JSON.stringify({title,reportDate,shiftName,team:req.user.team})]);
    // A auditoria usa target_user_id, que referencia users.id. O ID do relatório
    // não pode ser passado nesse campo; registre-o em details e não bloqueie
    // a resposta se a auditoria falhar depois da gravação principal.
    try {
      await registrarAuditoria(req.user.id,'relatorio_criado',null,{reportId:id,team:req.user.team,reportDate,shiftName});
    } catch (auditError) {
      console.error('Falha ao registrar auditoria de criação de relatório:', auditError && auditError.stack ? auditError.stack : auditError);
    }
    res.status(201).json({ok:true,report:relatorioPublico(q.rows[0])});
  } catch(e) { if(e.code==='23505') return res.status(409).json({ok:false,message:'JÃÂ¡ existe um relatÃÂ³rio dessa equipe para essa data e turno.'}); console.error('Falha ao criar relatÃÂ³rio:',e.message); res.status(500).json({ok:false,message:'NÃÂ£o foi possÃÂ­vel criar o relatÃÂ³rio.'}); }
});
app.patch('/api/relatorios/:id', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async (req,res) => {
  if(req.user.role==='admin') return res.status(403).json({ok:false,message:'O administrador possui acesso somente para consulta.'});
  const id=textoSeguro(req.params.id,100); const expected=Number(req.body?.revision);
  const title=textoSeguro(req.body?.title ?? '',180);
  const reportDate=String(req.body?.reportDate || '').slice(0,10);
  const shiftName=textoSeguro(req.body?.shiftName || 'PlantÃÂ£o',80);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return res.status(400).json({ok:false,message:'Informe uma data vÃÂ¡lida para o relatÃÂ³rio.'});
  const content=req.body?.content && typeof req.body.content==='object' && !Array.isArray(req.body.content)?req.body.content:{};
  const action=String(req.body?.action||'salvar');
  if(!Number.isInteger(expected)||expected<1) return res.status(400).json({ok:false,message:'VersÃÂ£o do relatÃÂ³rio ausente. Atualize a lista antes de salvar.'});
  if(!['salvar','encerrar','reabrir'].includes(action)) return res.status(400).json({ok:false,message:'AÃÂ§ÃÂ£o invÃÂ¡lida.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const current=await client.query('SELECT * FROM shift_reports WHERE id=$1 FOR UPDATE',[id]);
    if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,message:'RelatÃÂ³rio nÃÂ£o encontrado.'});}
    const old=current.rows[0];
    if(old.team!==req.user.team){await client.query('ROLLBACK');return res.status(403).json({ok:false,message:'Este relatÃÂ³rio pertence a outra equipe.'});}
    const escalaAtual = estadoPlantaoRelatorio();
    const equipeReabrindoRelatorioAnterior = action==='reabrir' && ['chefe','auxiliar'].includes(req.user.role) && String(old.report_date).slice(0,10)<String(escalaAtual.shiftDate).slice(0,10);
    const correcaoDeRelatorioReaberto = old.status==='aberto' && Boolean(old.reopened_at) && Boolean(old.reopened_by);
    if(req.user.team!==escalaAtual.onDutyTeam && !equipeReabrindoRelatorioAnterior && !correcaoDeRelatorioReaberto){
      await client.query('ROLLBACK');
      return res.status(403).json({ok:false,code:'FORA_DO_PLANTAO',message:`A equipe de plantÃ£o neste momento Ã© a Equipe ${escalaAtual.onDutyTeam}. Somente o chefe pode reabrir um relatÃ³rio antigo para correÃ§Ã£o; relatÃ³rios reabertos podem ser corrigidos pela equipe proprietÃ¡ria.`,onDutyTeam:escalaAtual.onDutyTeam,shiftDate:escalaAtual.shiftDate});
    }
    if(old.revision!==expected){await client.query('ROLLBACK');return res.status(409).json({ok:false,conflict:true, message:'Este relatÃÂ³rio foi alterado por outra pessoa. Os dados do servidor foram preservados; atualize e compare antes de continuar.', report:relatorioPublico(old)});}
    if(old.status==='encerrado' && action!=='reabrir'){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'O relatÃÂ³rio estÃÂ¡ encerrado. Reabra-o para fazer alteraÃÂ§ÃÂµes.'});}
    if(action==='reabrir' && !['chefe','auxiliar'].includes(req.user.role)){await client.query('ROLLBACK');return res.status(403).json({ok:false,message:'Somente chefe ou auxiliar da equipe podem reabrir um relatÃÂ³rio encerrado após a passagem do plantão.'});} if(action==='reabrir' && String(old.report_date).slice(0,10)>=String(escalaAtual.shiftDate).slice(0,10)){await client.query('ROLLBACK');return res.status(403).json({ok:false,message:'A reabertura por chefe ou auxiliar só é permitida após o início do novo plantão, às 08h.'});}
    const status=action==='encerrar'?'encerrado':action==='reabrir'?'aberto':old.status;
    const revision=old.revision+1;
    const updated=await client.query(`UPDATE shift_reports SET report_date=$2,shift_name=$3,title=$4,content=$5::jsonb,status=$6,revision=$7,updated_by=$8,updated_at=NOW(),closed_at=CASE WHEN $6='encerrado' THEN NOW() WHEN $6='aberto' THEN NULL ELSE closed_at END,closed_by=CASE WHEN $6='encerrado' THEN $8 WHEN $6='aberto' THEN NULL ELSE closed_by END,reopened_at=CASE WHEN $9 THEN NOW() ELSE reopened_at END,reopened_by=CASE WHEN $9 THEN $8 ELSE reopened_by END WHERE id=$1 RETURNING *`,[id,reportDate,shiftName,title,JSON.stringify(content),status,revision,req.user.id,action==='reabrir']);
    await client.query(`INSERT INTO shift_report_history(report_id,actor_user_id,action,revision,previous_content,new_content,details) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,[id,req.user.id,action,revision,JSON.stringify(old.content||{}),JSON.stringify(content),JSON.stringify({previousTitle:old.title,title,previousDate:old.report_date,reportDate,previousShiftName:old.shift_name,shiftName,previousStatus:old.status,status,team:old.team})]);
    await client.query('COMMIT');
    // target_user_id referencia users.id, não shift_reports.id. O ID do
    // relatório fica em details. Falha na auditoria não deve transformar um
    // salvamento já confirmado pelo COMMIT em uma resposta de erro ao navegador.
    try {
      await registrarAuditoria(req.user.id,'relatorio_'+action,null,{reportId:id,team:old.team,revision,previousStatus:old.status,status});
    } catch (auditError) {
      console.error('Falha ao registrar auditoria de salvamento de relatório:', auditError && auditError.stack ? auditError.stack : auditError);
    }
    res.json({ok:true,report:relatorioPublico(updated.rows[0])});
  } catch(e){
    try{await client.query('ROLLBACK')}catch{}
    console.error('Falha ao salvar relatório:', e && e.stack ? e.stack : e);
    res.status(500).json({ok:false,message:'Não foi possível salvar o relatório.'});
  } finally{client.release();}
});
app.get('/api/relatorios/:id/historico', exigirBanco, exigirAutenticacao, exigirPerfilRelatorio, async(req,res)=>{
  try{
    const id=textoSeguro(req.params.id,100); const report=await pool.query('SELECT id,team FROM shift_reports WHERE id=$1',[id]);
    if(!report.rowCount)return res.status(404).json({ok:false,message:'RelatÃÂ³rio nÃÂ£o encontrado.'});
    if(req.user.role!=='admin'&&report.rows[0].team!==req.user.team)return res.status(403).json({ok:false,message:'Acesso restrito ÃÂ  equipe do relatÃÂ³rio.'});
    const q=await pool.query(`SELECT h.id,h.action,h.revision,h.previous_content,h.new_content,h.details,h.created_at,u.username,u.full_name FROM shift_report_history h LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.report_id=$1 ORDER BY h.created_at DESC LIMIT 300`,[id]);
    res.json({ok:true,history:q.rows,readOnly:true});
  }catch(e){console.error('Falha no histÃÂ³rico de relatÃÂ³rio:',e.message);res.status(500).json({ok:false,message:'NÃÂ£o foi possÃÂ­vel carregar o histÃÂ³rico.'});}
});
app.get('/api/admin/shift-reports', exigirBanco, exigirAutenticacao, exigirAdmin, async(_req,res)=>{
  try{const q=await pool.query(`SELECT r.*,u.username AS updated_username,u.full_name AS updated_full_name FROM shift_reports r LEFT JOIN users u ON u.id=r.updated_by ORDER BY r.report_date DESC,r.team,r.shift_name`);res.json({ok:true,reports:q.rows.map(r=>({...relatorioPublico(r),updatedUsername:r.updated_username,updatedFullName:r.updated_full_name}))});}
  catch(e){console.error('Falha no painel de relatÃÂ³rios:',e.message);res.status(500).json({ok:false,message:'NÃÂ£o foi possÃÂ­vel consultar os relatÃÂ³rios de plantÃÂ£o.'});}
});
app.get('/api/admin/shift-reports/:id/history', exigirBanco, exigirAutenticacao, exigirAdmin, async(req,res)=>{
  try{const q=await pool.query(`SELECT h.id,h.action,h.revision,h.previous_content,h.new_content,h.details,h.created_at,u.username,u.full_name FROM shift_report_history h LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.report_id=$1 ORDER BY h.created_at DESC LIMIT 500`,[textoSeguro(req.params.id,100)]);res.json({ok:true,history:q.rows});}
  catch(e){res.status(500).json({ok:false,message:'NÃÂ£o foi possÃÂ­vel carregar o histÃÂ³rico do relatÃÂ³rio.'});}
});

app.get('/api/admin/events', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id,a.action,a.details,a.created_at,u.username AS actor_username,t.username AS target_username
         FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN users t ON t.id=a.target_user_id
        ORDER BY a.created_at DESC LIMIT 300`
    );
    res.json({ ok: true, events: result.rows });
  } catch (e) { res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar o registro administrativo.' }); }
});
app.get('/api/me/backup-weekly.xlsx', exigirBanco, exigirAutenticacao, async (req, res) => {
  if (!['guiche', 'mesa'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: 'Use o backup do painel administrativo para exportar a cÃÂÃÂ³pia geral.' });
  }
  const periodo = lerPeriodoSemanal(req, res);
  if (!periodo) return;
  try {
    const rows = await consultarAtendimentosSemana(periodo, req.user.role === 'guiche' ? req.user.id : null);
    const escopo = req.user.role === 'guiche'
      ? `Somente os atendimentos da conta ${req.user.username}.`
      : 'Todos os atendimentos do sistema no perÃÂÃÂ­odo, de todos os GuichÃÂÃÂªs e todas as situaÃÂÃÂ§ÃÂÃÂµes, inclusive recusados.';
    const buffer = await criarPlanilhaAtendimentos({ periodo, rows, titulo: req.user.role === 'guiche' ? `Backup semanal ÃÂ¢ÃÂÃÂ ${req.user.username}` : 'Backup semanal total ÃÂ¢ÃÂÃÂ Mesa', escopo });
    await registrarAuditoria(req.user.id, 'backup_excel_semanal_gerado', null, { from: periodo.from, to: periodo.to, count: rows.length, role: req.user.role });
    const login = nomeArquivoSeguro(req.user.username);
    const nome = req.user.role === 'guiche'
      ? `Backup_Guiche_${login}_${periodo.from}_a_${periodo.to}.xlsx`
      : `Backup_Mesa_Total_${periodo.from}_a_${periodo.to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('X-Backup-Count', String(rows.length));
    res.setHeader('X-Backup-From', periodo.from);
    res.setHeader('X-Backup-To', periodo.to);
    res.send(buffer);
  } catch (e) {
    console.error('Erro gerando Excel semanal da conta:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o Excel semanal.' });
  }
});

app.get('/api/admin/backup-weekly.xlsx', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const periodo = lerPeriodoSemanal(req, res);
  if (!periodo) return;
  try {
    const rows = await consultarAtendimentosSemana(periodo);
    const buffer = await criarPlanilhaAtendimentos({
      periodo, rows, titulo: 'Backup semanal total ÃÂ¢ÃÂÃÂ Administrador',
      escopo: 'Todos os atendimentos do sistema no perÃÂÃÂ­odo, de todos os GuichÃÂÃÂªs e todas as situaÃÂÃÂ§ÃÂÃÂµes, inclusive recusados.'
    });
    await registrarAuditoria(req.user.id, 'backup_excel_semanal_geral_gerado', null, { from: periodo.from, to: periodo.to, count: rows.length });
    const nome = `Backup_Administrador_Total_${periodo.from}_a_${periodo.to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('X-Backup-Count', String(rows.length));
    res.send(buffer);
  } catch (e) {
    console.error('Erro gerando Excel semanal total:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o Excel semanal total.' });
  }
});

// Para a tarefa semanal automÃÂÃÂ¡tica: um arquivo Excel por conta GuichÃÂÃÂª e cÃÂÃÂ³pias gerais
// para a Mesa e para o administrador. O ZIP ÃÂÃÂ© gerado sob demanda, sem gravar arquivos
// sensÃÂÃÂ­veis no disco efÃÂÃÂªmero do serviÃÂÃÂ§o Render.
app.get('/api/admin/backup-weekly-bundle.zip', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const periodo = lerPeriodoSemanal(req, res);
  if (!periodo) return;
  try {
    const [usersResult, rows] = await Promise.all([
      pool.query("SELECT id, username, full_name FROM users WHERE role='guiche' ORDER BY username_normalized"),
      consultarAtendimentosSemana(periodo)
    ]);
    const entries = [];
    for (const user of usersResult.rows) {
      const propios = rows.filter(row => row.owner_id === user.id);
      const buffer = await criarPlanilhaAtendimentos({
        periodo, rows: propios, titulo: `Backup semanal ÃÂ¢ÃÂÃÂ ${user.username}`,
        escopo: `Somente os atendimentos da conta GuichÃÂÃÂª ${user.username}.`
      });
      entries.push({
        name: `Guiches/Backup_Guiche_${nomeArquivoSeguro(user.username)}_${periodo.from}_a_${periodo.to}.xlsx`,
        buffer
      });
    }
    const totalMesa = await criarPlanilhaAtendimentos({
      periodo, rows, titulo: 'Backup semanal total ÃÂ¢ÃÂÃÂ Mesa',
      escopo: 'Todos os atendimentos do sistema no perÃÂÃÂ­odo, de todos os GuichÃÂÃÂªs e todas as situaÃÂÃÂ§ÃÂÃÂµes, inclusive recusados.'
    });
    entries.push({ name: `Mesa/Backup_Mesa_Total_${periodo.from}_a_${periodo.to}.xlsx`, buffer: totalMesa });
    const totalAdmin = await criarPlanilhaAtendimentos({
      periodo, rows, titulo: 'Backup semanal total ÃÂ¢ÃÂÃÂ Administrador',
      escopo: 'Todos os atendimentos do sistema no perÃÂÃÂ­odo, de todos os GuichÃÂÃÂªs e todas as situaÃÂÃÂ§ÃÂÃÂµes, inclusive recusados.'
    });
    entries.push({ name: `Administrador/Backup_Administrador_Total_${periodo.from}_a_${periodo.to}.xlsx`, buffer: totalAdmin });
    await registrarAuditoria(req.user.id, 'backup_excel_semanal_automatico_gerado', null, { from: periodo.from, to: periodo.to, count: rows.length, workbooks: entries.length });
    const zipBuffer = await criarZipPlanilhas(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Backups_Semanais_${periodo.from}_a_${periodo.to}.zip"`);
    res.setHeader('X-Backup-Count', String(rows.length));
    res.send(zipBuffer);
  } catch (e) {
    console.error('Erro montando pacote automÃÂÃÂ¡tico de backups Excel:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel preparar o pacote automÃÂÃÂ¡tico de backups Excel.' });
  }
});

app.get('/api/admin/backup-weekly', exigirBanco, exigirAutenticacao, exigirAdmin, async (req, res) => {
  const periodo = lerPeriodoSemanal(req, res);
  if (!periodo) return;
  try {
    const [users, attendance, base] = await Promise.all([
      pool.query('SELECT id,username,full_name,role,is_active,created_at,updated_at,last_login_at,deleted_at FROM users ORDER BY created_at'),
      pool.query(
        `SELECT * FROM attendances WHERE ${DATA_AGENDADA_SQL} BETWEEN $1 AND $2 ORDER BY ${DATA_AGENDADA_SQL}, created_at`,
        [periodo.from, periodo.to]
      ),
      pool.query('SELECT items,updated_at,updated_by FROM internal_base WHERE singleton_id=1')
    ]);
    await registrarAuditoria(req.user.id, 'backup_semanal_gerado', null, {
      from: periodo.from, to: periodo.to, count: attendance.rows.length, basis: 'dataAtendimento'
    });
    const events = await pool.query('SELECT id,actor_user_id,action,target_user_id,details,created_at FROM audit_log ORDER BY id');
    res.json({
      format: 'sistema-atendimento-backup', version: VERSAO, generatedAt: agoraISO(),
      backupType: 'semanal', period: periodo, count: attendance.rows.length,
      notice: 'Backup semanal: a seleÃÂÃÂ§ÃÂÃÂ£o dos atendimentos considera a Data do Atendimento (data agendada), nÃÂÃÂ£o a data de envio. ContÃÂÃÂ©m dados operacionais sensÃÂÃÂ­veis.',
      users: users.rows, attendances: attendance.rows,
      internalBase: base.rows[0] || { items: [], updated_at: null, updated_by: null },
      auditLog: events.rows
    });
  } catch (e) {
    console.error('Erro no backup semanal:', e.message);
    res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o backup semanal.' });
  }
});

app.get('/api/admin/backup-data', exigirBanco, exigirAutenticacao, exigirAdmin, async (_req, res) => {
  try {
    const [users, attendance, base, events] = await Promise.all([
      pool.query('SELECT id,username,full_name,role,is_active,created_at,updated_at,last_login_at,deleted_at FROM users ORDER BY created_at'),
      pool.query('SELECT * FROM attendances ORDER BY created_at'),
      pool.query('SELECT items,updated_at,updated_by FROM internal_base WHERE singleton_id=1'),
      pool.query('SELECT id,actor_user_id,action,target_user_id,details,created_at FROM audit_log ORDER BY id')
    ]);
    res.json({
      format: 'sistema-atendimento-backup', version: VERSAO, generatedAt: agoraISO(),
      notice: 'CÃÂÃÂ³pia de dados sem hashes de senha e sem sessÃÂÃÂµes ativas. Depois de uma restauraÃÂÃÂ§ÃÂÃÂ£o, redefina as senhas dos usuÃÂÃÂ¡rios.',
      users: users.rows, attendances: attendance.rows,
      internalBase: base.rows[0] || { items: [], updated_at: null, updated_by: null }, auditLog: events.rows
    });
  } catch (e) { console.error('Erro no backup:', e.message); res.status(500).json({ ok: false, message: 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o backup.' }); }
});

async function registrarCliente(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || !cliente.user) return;
  const canal = dados.role === 'receiver' ? 'receiver' : dados.role === 'sender' ? 'sender' : null;
  if (!canal || !perfilValido(cliente.user.role, canal)) {
    responderErro(ws, 'error', 'Esta conta nÃÂÃÂ£o tem permissÃÂÃÂ£o para acessar esta ÃÂÃÂ¡rea.');
    ws.close(1008, 'Perfil nÃÂÃÂ£o autorizado');
    return;
  }
  cliente.canal = canal;
  cliente.userId = cliente.user.id;
  enviar(ws, { type: 'registered', role: canal, clientId: cliente.user.id, username: cliente.user.username, accountRole: cliente.user.role, version: VERSAO });
  if (canal === 'receiver') enviarPendentesParaMesa(ws);
  if (canal === 'sender') enviarRecusasPendentesParaGuiche(ws, cliente.user.id);
}
async function receberNovoAtendimento(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || cliente.canal !== 'sender') return responderErro(ws, 'send_result', 'Somente um login autorizado do GUICHÃÂÃÂ pode enviar atendimentos.', dados.recordId);
  const recordId = textoSeguro(dados.recordId, 180);
  if (!recordId) return responderErro(ws, 'send_result', 'recordId nÃÂÃÂ£o informado.');
  const result = await pool.query('SELECT * FROM attendances WHERE record_id=$1', [recordId]);
  const row = result.rows[0] || null;
  const refusal = recusasPendentes.get(recordId);
  if (row && row.status !== 'recusado' && row.received_at) {
    if (row.owner_id !== cliente.user.id) return responderErro(ws, 'send_result', 'Este atendimento pertence a outro login.', recordId);
    enviar(ws, { type: 'record_received', recordId, receivedAt: row.received_at });
    enviar(ws, { type: 'send_result', ok: true, recordId, alreadyReceived: true });
    return;
  }
  const ownerId = row?.owner_id || refusal?.ownerId || cliente.user.id;
  if (ownerId !== cliente.user.id) return responderErro(ws, 'send_result', 'Este atendimento pertence a outro login.', recordId);
  const entrada = normalizarRegistro(dados.record);
  const registro = { ...(row?.record || refusal?.record || {}), ...entrada, recordId };
  const ehReenvio = Boolean(registro.reenvio === true || row?.status === 'recusado' || refusal);
  if (ehReenvio) {
    registro.reenvio = true;
    registro.reenviadoEm = registro.reenviadoEm || agoraISO();
  } else {
    registro.reenvio = false;
  }
  registro.status = 'aguardando_mesa';
  delete registro.motivoRecusa;
  delete registro.recusadoEm;
  const createdAt = row?.created_at || registro.createdAt || agoraISO();
  const now = agoraISO();
  await pool.query(
    `INSERT INTO attendances (record_id,owner_id,record,status,created_at,updated_at,received_at,refused_at,refusal_reason,refusal_confirmed_at)
     VALUES ($1,$2,$3::jsonb,'aguardando_mesa',$4,$5,NULL,NULL,NULL,NULL)
     ON CONFLICT(record_id) DO UPDATE SET record=EXCLUDED.record,status='aguardando_mesa',updated_at=NOW(),received_at=NULL,refused_at=NULL,refusal_reason=NULL,refusal_confirmed_at=NULL,guiche_archived_at=NULL,mesa_archived_at=NULL`,
    [recordId, ownerId, JSON.stringify(registro), createdAt, now]
  );
  recusasPendentes.delete(recordId);
  recebidos.delete(recordId);
  const pendente = { recordId, record: registro, ownerId, createdAt, updatedAt: now };
  pendentes.set(recordId, pendente);
  await registrarAuditoria(ownerId, ehReenvio ? 'atendimento_reenviado' : 'atendimento_enviado', null, { recordId });
  enviarNovoAtendimento(pendente);
  enviar(ws, { type: 'send_result', ok: true, recordId, reenvio: ehReenvio });
}
async function confirmarRecebimento(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || cliente.canal !== 'receiver') return responderErro(ws, 'confirm_result', 'Somente a MESA pode confirmar recebimentos.', dados.recordId);
  const recordId = textoSeguro(dados.recordId, 180);
  if (!recordId) return responderErro(ws, 'confirm_result', 'recordId nÃÂÃÂ£o informado.');
  const pending = pendentes.get(recordId);
  if (!pending) {
    const row = await pool.query('SELECT owner_id,status,received_at FROM attendances WHERE record_id=$1', [recordId]);
    const existing = row.rows[0];
    if (existing && existing.received_at) {
      enviar(ws, { type: 'confirm_result', ok: true, recordId, alreadyConfirmed: true, receivedAt: existing.received_at });
      return;
    }
    return responderErro(ws, 'confirm_result', 'Atendimento nÃÂÃÂ£o estÃÂÃÂ¡ mais pendente.', recordId);
  }
  const receivedAt = dados.receivedAt || agoraISO();
  const registro = { ...pending.record, status: 'recebido', recebidoEm: receivedAt };
  await pool.query('UPDATE attendances SET status=$2,record=$3::jsonb,received_at=$4,updated_at=NOW() WHERE record_id=$1', [recordId, 'recebido', JSON.stringify(registro), receivedAt]);
  await registrarAuditoria(cliente.user.id, 'atendimento_recebido', pending.ownerId, { recordId });
  const confirmacao = { type: 'record_received', recordId, receivedAt };
  transmitirParaUsuario(pending.ownerId, confirmacao, 'sender');
  transmitirParaCanal('receiver', confirmacao);
  recebidos.set(recordId, { recordId, ownerId: pending.ownerId, receivedAt });
  pendentes.delete(recordId);
  enviar(ws, { type: 'confirm_result', ok: true, recordId });
}
async function recusarAtendimento(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || cliente.canal !== 'receiver') return responderErro(ws, 'refuse_result', 'Somente a MESA pode recusar atendimentos.', dados.recordId);
  const recordId = textoSeguro(dados.recordId, 180);
  if (!recordId) return responderErro(ws, 'refuse_result', 'recordId da recusa nÃÂÃÂ£o informado.');
  const pending = pendentes.get(recordId);
  if (!pending) {
    const old = recusasPendentes.get(recordId);
    if (old) {
      const delivered = enviarRecusa(old);
      enviar(ws, { type: 'refuse_result', ok: true, recordId, refusedAt: old.refusedAt, deliveredToGuiche: delivered });
      return;
    }
    return responderErro(ws, 'refuse_result', 'Atendimento nÃÂÃÂ£o estÃÂÃÂ¡ mais pendente.', recordId);
  }
  const registro = { ...pending.record, ...normalizarRegistro(dados.record), recordId };
  const reason = textoSeguro(dados.reason ?? dados.motivoRecusa ?? registro.motivoRecusa, 2000);
  if (!reason) return responderErro(ws, 'refuse_result', 'Informe o motivo da recusa.', recordId);
  const refusedAt = dados.refusedAt || agoraISO();
  registro.status = 'recusado'; registro.motivoRecusa = reason; registro.recusadoEm = refusedAt;
  const refusal = { recordId, record: registro, ownerId: pending.ownerId, reason, refusedAt };
  await pool.query('UPDATE attendances SET status=$2,record=$3::jsonb,refused_at=$4,refusal_reason=$5,refusal_confirmed_at=NULL,guiche_archived_at=NULL,mesa_archived_at=NULL,updated_at=NOW() WHERE record_id=$1', [recordId, 'recusado', JSON.stringify(registro), refusedAt, reason]);
  await registrarAuditoria(cliente.user.id, 'atendimento_recusado', pending.ownerId, { recordId, reason });
  recusasPendentes.set(recordId, refusal);
  pendentes.delete(recordId);
  const delivered = enviarRecusa(refusal);
  transmitirParaCanal('receiver', { type: 'record_removed', recordId, reason: 'Atendimento recusado.' }, ws);
  enviar(ws, { type: 'refuse_result', ok: true, recordId, refusedAt, deliveredToGuiche: delivered });
}
async function confirmarRecebimentoRecusa(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || cliente.canal !== 'sender') return responderErro(ws, 'confirm_refusal_result', 'Somente o GUICHÃÂÃÂ pode confirmar o recebimento da recusa.', dados.recordId);
  const recordId = textoSeguro(dados.recordId, 180);
  const refusal = recusasPendentes.get(recordId);
  if (!refusal) {
    enviar(ws, { type: 'confirm_refusal_result', ok: true, recordId, alreadyConfirmed: true });
    return;
  }
  if (refusal.ownerId !== cliente.user.id) return responderErro(ws, 'confirm_refusal_result', 'Este atendimento pertence a outro login.', recordId);
  await pool.query('UPDATE attendances SET refusal_confirmed_at=NOW(),updated_at=NOW() WHERE record_id=$1', [recordId]);
  await registrarAuditoria(cliente.user.id, 'recusa_recebida_pelo_guiche', null, { recordId });
  recusasPendentes.delete(recordId);
  enviar(ws, { type: 'confirm_refusal_result', ok: true, recordId });
}
async function atualizarStatusRegistro(ws, dados) {
  const cliente = clientes.get(ws);
  if (!cliente || !cliente.user) return;
  const recordId = textoSeguro(dados.recordId, 180);
  const status = textoSeguro(dados.status, 60);
  if (!recordId || status !== 'guardado') return;
  const result = await pool.query('SELECT * FROM attendances WHERE record_id=$1', [recordId]);
  const row = result.rows[0];
  if (!row) return;
  const registro = { ...normalizarRegistro(row.record), ...normalizarRegistro(dados.record) };
  const guardadoEm = textoSeguro(registro.guardadoEm, 60) || agoraISO();
  if (cliente.canal === 'sender') {
    if (row.owner_id !== cliente.user.id) return;
    registro.guicheGuardadoEm = guardadoEm;
    await pool.query('UPDATE attendances SET guiche_archived_at=COALESCE(guiche_archived_at,$2::timestamptz),record=$3::jsonb,updated_at=NOW() WHERE record_id=$1', [recordId, guardadoEm, JSON.stringify(registro)]);
  } else if (cliente.canal === 'receiver') {
    if (!['recebido', 'guardado'].includes(row.status)) return;
    registro.mesaGuardadoEm = guardadoEm;
    await pool.query('UPDATE attendances SET mesa_archived_at=COALESCE(mesa_archived_at,$2::timestamptz),record=$3::jsonb,updated_at=NOW() WHERE record_id=$1', [recordId, guardadoEm, JSON.stringify(registro)]);
    transmitirParaCanal('receiver', { type: 'record_status_updated', recordId, status: 'guardado' });
  } else {
    return;
  }
  await registrarAuditoria(cliente.user.id, 'status_atendimento_atualizado', row.owner_id, { recordId, status: 'guardado', canal: cliente.canal });
}

async function tratarMensagem(ws, raw) {
  let dados;
  try { dados = JSON.parse(raw.toString()); }
  catch { return responderErro(ws, 'error', 'Mensagem invÃÂÃÂ¡lida. Envie um JSON vÃÂÃÂ¡lido.'); }
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return responderErro(ws, 'error', 'Formato de mensagem invÃÂÃÂ¡lido.');
  const cliente = clientes.get(ws);
  if (!cliente) return;
  if (dados.type === 'ping') return enviar(ws, { type: 'pong', time: agoraISO() });
  if (dados.type === 'pong') return;
  if (!cliente.user) return responderErro(ws, 'error', 'SessÃÂÃÂ£o WebSocket nÃÂÃÂ£o autenticada.');
  try {
    switch (dados.type) {
      case 'register': return await registrarCliente(ws, dados);
      case 'send_record': return await receberNovoAtendimento(ws, dados);
      case 'confirm_received': return await confirmarRecebimento(ws, dados);
      case 'refuse_record': return await recusarAtendimento(ws, dados);
      case 'confirm_refusal_received': return await confirmarRecebimentoRecusa(ws, dados);
      case 'record_status': return await atualizarStatusRegistro(ws, dados);
      default: return responderErro(ws, 'error', 'Tipo de mensagem nÃÂÃÂ£o reconhecido.');
    }
  } catch (e) {
    console.error('Erro processando WebSocket:', e.message);
    responderErro(ws, `${dados.type || 'message'}_result`, 'Erro interno ao processar a mensagem.', dados.recordId);
  }
}
wss.on('connection', (ws, req) => {
  const origem = req.headers.origin;
  if (origem) {
    try {
      if (new URL(origem).host !== req.headers.host) {
        ws.close(1008, 'Origem nÃÂÃÂ£o autorizada');
        return;
      }
    } catch {
      ws.close(1008, 'Origem invÃÂÃÂ¡lida');
      return;
    }
  }
  const cliente = { ws, canal: null, user: null, userId: null, sessionHash: null, authExpiryTimer: null, authPromise: null };
  clientes.set(ws, cliente);
  cliente.authPromise = (async () => {
    try {
      const token = extrairCookie(req, SESSION_COOKIE);
      if (!token || !pool || !dbReady) throw new Error('SessÃÂÃÂ£o nÃÂÃÂ£o disponÃÂÃÂ­vel');
      const result = await pool.query(
        `SELECT u.id,u.username,u.full_name,u.role,u.is_active,u.deleted_at,s.expires_at AS session_expires_at
           FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.is_active=TRUE AND u.deleted_at IS NULL`,
        [hashToken(token)]
      );
      if (!result.rowCount || ws.readyState !== WebSocket.OPEN) throw new Error('SessÃÂÃÂ£o invÃÂÃÂ¡lida');
      cliente.user = result.rows[0];
      cliente.userId = cliente.user.id;
      cliente.sessionHash = hashToken(token);
      const restante = new Date(cliente.user.session_expires_at).getTime() - Date.now();
      cliente.authExpiryTimer = setTimeout(() => {
        try { ws.close(1008, 'SessÃÂÃÂ£o expirada; entre novamente'); } catch {}
      }, Math.max(1, restante));
      enviar(ws, { type: 'connected', version: VERSAO });
    } catch {
      if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'AutenticaÃÂÃÂ§ÃÂÃÂ£o necessÃÂÃÂ¡ria');
    }
  })();
  ws.on('message', async raw => {
    try { await cliente.authPromise; await tratarMensagem(ws, raw); }
    catch (e) { console.error('Erro no canal WebSocket:', e.message); }
  });
  ws.on('close', () => { clearTimeout(cliente.authExpiryTimer); clientes.delete(ws); });
  ws.on('error', e => console.error('Erro WebSocket:', e.message));
});

function texto(valor, limite) {
  return String(valor == null ? '' : valor).trim().slice(0, limite);
}
function hojeCampoGrande() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Campo_Grande', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((obj, p) => { obj[p.type] = p.value; return obj; }, {});
  return partes.year + '-' + partes.month + '-' + partes.day;
}
function acessoModulo(req, res, next) {
  if (!req.user || !['admin', 'pertences'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: 'Acesso restrito ÃÂ  ÃÂÃÂ¡rea Pertences e Visitas.' });
  }
  next();
}
function acessoListasMesa(req, res, next) {
  if (!req.user || !['admin', 'pertences', 'mesa'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, message: 'Acesso restrito ÃÂ s listas de visitas.' });
  }
  next();
}
function formatarErro(res, e, mensagem) {
  console.error(mensagem, e && e.message ? e.message : e);
  if (!res.headersSent) res.status(500).json({ ok: false, message: mensagem });
}

async function inicializarPertencesVisitas(pool) {
  if (!pool) return;
  await pool.query([
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;",
    "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','guiche','mesa','pertences','chefe','auxiliar'));",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT;",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_check;",
    "ALTER TABLE users ADD CONSTRAINT users_team_check CHECK (team IS NULL OR team IN ('A','B','C','D'));",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_one_report_role_per_team_idx ON users(team, role) WHERE role IN ('chefe','auxiliar') AND is_active=TRUE AND deleted_at IS NULL;",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_single_active_pertences ON users(role) WHERE role='pertences' AND is_active=TRUE AND deleted_at IS NULL;",
    "CREATE TABLE IF NOT EXISTS pv_belongings (",
    "  record_id TEXT PRIMARY KEY, internal_name TEXT NOT NULL, rgi TEXT NOT NULL DEFAULT '',",
    "  pavilion TEXT NOT NULL DEFAULT '', cell TEXT NOT NULL DEFAULT '',",
    "  deliverer_name TEXT NOT NULL, relationship TEXT NOT NULL,",
    "  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by TEXT REFERENCES users(id)",
    ");",
    "CREATE INDEX IF NOT EXISTS pv_belongings_received_idx ON pv_belongings(received_at DESC);",
    "CREATE INDEX IF NOT EXISTS pv_belongings_rgi_received_idx ON pv_belongings(rgi, received_at DESC);",
    "CREATE TABLE IF NOT EXISTS pv_visit_lists (",
    "  list_number BIGSERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),",
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ, created_by TEXT REFERENCES users(id)",
    ");",
    "ALTER TABLE pv_visit_lists ADD COLUMN IF NOT EXISTS visit_day DATE;",
    "UPDATE pv_visit_lists SET visit_day=(created_at AT TIME ZONE 'America/Campo_Grande')::date WHERE visit_day IS NULL;",
    "ALTER TABLE pv_visit_lists ADD COLUMN IF NOT EXISTS day_list_number INTEGER;",
    "WITH numbered AS (SELECT list_number, ROW_NUMBER() OVER (PARTITION BY visit_day ORDER BY created_at,list_number)::integer AS n FROM pv_visit_lists) UPDATE pv_visit_lists l SET day_list_number=numbered.n FROM numbered WHERE l.list_number=numbered.list_number;",
    "ALTER TABLE pv_visit_lists ALTER COLUMN visit_day SET DEFAULT ((NOW() AT TIME ZONE 'America/Campo_Grande')::date);",
    "ALTER TABLE pv_visit_lists ALTER COLUMN visit_day SET NOT NULL;",
    "ALTER TABLE pv_visit_lists ALTER COLUMN day_list_number SET DEFAULT 1;",
    "ALTER TABLE pv_visit_lists ALTER COLUMN day_list_number SET NOT NULL;",
    "CREATE TABLE IF NOT EXISTS pv_visit_days (visit_day DATE PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), closed_at TIMESTAMPTZ, closed_by TEXT REFERENCES users(id), reopened_at TIMESTAMPTZ, reopened_by TEXT REFERENCES users(id));",
    "INSERT INTO pv_visit_days(visit_day,status,closed_at) SELECT visit_day,CASE WHEN BOOL_AND(status='closed') THEN 'closed' ELSE 'open' END,MAX(closed_at) FROM pv_visit_lists GROUP BY visit_day ON CONFLICT (visit_day) DO NOTHING;",
    "DROP INDEX IF EXISTS pv_visit_one_open_list;",
    "CREATE INDEX IF NOT EXISTS pv_visit_lists_day_idx ON pv_visit_lists(visit_day,day_list_number);",
    "CREATE TABLE IF NOT EXISTS pv_visit_entries (",
    "  entry_id TEXT PRIMARY KEY, list_number BIGINT NOT NULL REFERENCES pv_visit_lists(list_number),",
    "  internal_name TEXT NOT NULL, rgi TEXT NOT NULL DEFAULT '', pavilion TEXT NOT NULL DEFAULT '', cell TEXT NOT NULL DEFAULT '',",
    "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by TEXT REFERENCES users(id)",
    ");",
    "CREATE INDEX IF NOT EXISTS pv_visit_entries_list_idx ON pv_visit_entries(list_number, created_at);",
    "INSERT INTO pv_visit_days(visit_day,status) VALUES ((NOW() AT TIME ZONE 'America/Campo_Grande')::date,'open') ON CONFLICT (visit_day) DO NOTHING;",
    "INSERT INTO pv_visit_lists(visit_day,day_list_number,status) SELECT (NOW() AT TIME ZONE 'America/Campo_Grande')::date,COALESCE(MAX(day_list_number),0)+1,'open' FROM pv_visit_lists WHERE visit_day=(NOW() AT TIME ZONE 'America/Campo_Grande')::date AND NOT EXISTS (SELECT 1 FROM pv_visit_lists WHERE visit_day=(NOW() AT TIME ZONE 'America/Campo_Grande')::date AND status='open') AND EXISTS (SELECT 1 FROM pv_visit_days WHERE visit_day=(NOW() AT TIME ZONE 'America/Campo_Grande')::date AND status='open');"
  ].join('\n'));

  // Executa a limpeza e a criação do índice em comandos separados.
  // Assim, uma duplicidade não desfaz a criação das tabelas acima.
  await pool.query("DROP INDEX IF EXISTS pv_visit_one_open_list_per_day");
  await pool.query(`WITH ranked_open AS (
    SELECT list_number,
           ROW_NUMBER() OVER (
             PARTITION BY visit_day
             ORDER BY day_list_number DESC, created_at DESC, list_number DESC
           ) AS rn
    FROM pv_visit_lists
    WHERE status='open'
  )
  UPDATE pv_visit_lists l
     SET status='closed', closed_at=COALESCE(l.closed_at,NOW())
    FROM ranked_open r
   WHERE l.list_number=r.list_number AND r.rn>1`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS pv_visit_one_open_list_per_day ON pv_visit_lists(visit_day) WHERE status='open'");
}

function montarRotasPertencesVisitas(config) {
  const app = config.app;
  const pool = config.pool;
  const exigirBanco = config.exigirBanco;
  const exigirAutenticacao = config.exigirAutenticacao;
  const registrarAuditoria = config.registrarAuditoria;
  const PUBLIC_DIR = config.PUBLIC_DIR;

  app.get('/pertences.html', exigirBanco, exigirAutenticacao, (req, res) => {
    if (!['admin', 'pertences'].includes(req.user.role)) {
      return res.redirect(req.user.role === 'mesa' ? '/mesa.html' : '/index.html');
    }
    res.sendFile(path.join(PUBLIC_DIR, 'pertences.html'));
  });

  app.get('/api/pertences-visitas/belongings/check', exigirBanco, exigirAutenticacao, acessoModulo, async (req, res) => {
    const rgi = texto(req.query.rgi, 80);
    const nome = texto(req.query.nome, 200);
    if (!rgi && !nome) return res.status(400).json({ ok: false, message: 'Selecione um interno para verificar o histÃÂÃÂ³rico.' });
    try {
      const result = await pool.query(
        "SELECT record_id AS id, internal_name AS \"internalName\", rgi, pavilion, cell, deliverer_name AS \"delivererName\", relationship, received_at AS \"receivedAt\" " +
        "FROM pv_belongings " +
        "WHERE ((NULLIF($1,'') IS NOT NULL AND rgi=$1) OR (NULLIF($1,'') IS NULL AND LOWER(internal_name)=LOWER($2))) " +
        "AND received_at >= ((date_trunc('month', NOW() AT TIME ZONE 'America/Campo_Grande')) AT TIME ZONE 'America/Campo_Grande') " +
        "AND received_at < (((date_trunc('month', NOW() AT TIME ZONE 'America/Campo_Grande') + INTERVAL '1 month')) AT TIME ZONE 'America/Campo_Grande') " +
        "ORDER BY received_at DESC LIMIT 1", [rgi, nome]
      );
      res.json({ ok: true, previous: result.rows[0] || null });
    } catch (e) { formatarErro(res, e, 'NÃÂÃÂ£o foi possÃÂÃÂ­vel consultar os recebimentos de pertences deste mÃÂÃÂªs.'); }
  });

  app.get('/api/pertences-visitas/belongings', exigirBanco, exigirAutenticacao, acessoModulo, async (req, res) => {
    const day = texto(req.query.day || hojeCampoGrande(), 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ ok: false, message: 'Data invÃÂÃÂ¡lida.' });
    try {
      const result = await pool.query(
        "SELECT record_id AS id, internal_name AS \"internalName\", rgi, pavilion, cell, deliverer_name AS \"delivererName\", relationship, received_at AS \"receivedAt\" " +
        "FROM pv_belongings WHERE received_at >= (($1::date)::timestamp AT TIME ZONE 'America/Campo_Grande') " +
        "AND received_at < ((($1::date + 1)::timestamp) AT TIME ZONE 'America/Campo_Grande') ORDER BY received_at, internal_name", [day]
      );
      res.json({ ok: true, day, records: result.rows });
    } catch (e) { formatarErro(res, e, 'NÃÂÃÂ£o foi possÃÂÃÂ­vel carregar a lista de pertences.'); }
  });

  app.post('/api/pertences-visitas/belongings', exigirBanco, exigirAutenticacao, acessoModulo, async (req, res) => {
    const internalName = texto(req.body && req.body.internalName, 200);
    const rgi = texto(req.body && req.body.rgi, 80);
    const pavilion = texto(req.body && req.body.pavilion, 100);
    const cell = texto(req.body && req.body.cell, 30);
    const delivererName = texto(req.body && req.body.delivererName, 200);
    const relationship = texto(req.body && req.body.relationship, 100);
    if (!internalName || !delivererName || !relationship) return res.status(400).json({ ok: false, message: 'Informe o interno, quem entrega e o parentesco.' });
    const id = crypto.randomUUID();
    try {
      const result = await pool.query(
        'INSERT INTO pv_belongings (record_id,internal_name,rgi,pavilion,cell,deliverer_name,relationship,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING record_id AS id, internal_name AS "internalName", rgi, pavilion, cell, deliverer_name AS "delivererName", relationship, received_at AS "receivedAt"',
        [id, internalName, rgi, pavilion, cell, delivererName, relationship, req.user.id]
      );
      try { await registrarAuditoria(req.user.id, 'pertences_registrado', null, { recordId: id, internalName, rgi, delivererName }); } catch (e) { console.error('Falha ao registrar auditoria de pertences:', e.message); }
      res.status(201).json({ ok: true, record: result.rows[0] });
    } catch (e) { formatarErro(res, e, 'NÃÂÃÂ£o foi possÃÂÃÂ­vel salvar o recebimento de pertences.'); }
  });

  let timerFechamentoVisitasAtivo = false;
  function iniciarAgendamentoFechamentoVisitas() {
    if (timerFechamentoVisitasAtivo) return;
    timerFechamentoVisitasAtivo = true;
    const verificar = async () => {
      const hora = new Intl.DateTimeFormat('en-GB',{timeZone:'America/Campo_Grande',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
      if (hora < '12:00') return;
      let client;
      try {
        client=await pool.connect();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]);
        await atualizarFechamentoAutomaticoVisitas(client);
        await client.query('COMMIT');
      } catch(e) {
        if(client)try{await client.query('ROLLBACK')}catch{}
        console.error('Falha no fechamento automático das visitas:',e.message);
      } finally { if(client)client.release(); }
    };
    setInterval(verificar,30000);
    verificar();
  }

  async function atualizarFechamentoAutomaticoVisitas(client) {
    const hoje = hojeCampoGrande();
    const hora = new Intl.DateTimeFormat('en-GB',{timeZone:'America/Campo_Grande',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    await client.query("INSERT INTO pv_visit_days(visit_day,status) VALUES ($1,'open') ON CONFLICT (visit_day) DO NOTHING",[hoje]);
    if (hora >= '12:00') {
      await client.query("UPDATE pv_visit_lists SET status='closed',closed_at=COALESCE(closed_at,NOW()) WHERE visit_day=$1 AND status='open' AND EXISTS (SELECT 1 FROM pv_visit_days d WHERE d.visit_day=$1 AND d.status='open' AND d.reopened_at IS NULL)",[hoje]);
      await client.query("UPDATE pv_visit_days SET status='closed',closed_at=COALESCE(closed_at,NOW()) WHERE visit_day=$1 AND status='open' AND reopened_at IS NULL",[hoje]);
    }
    const day = await client.query("SELECT status,reopened_at FROM pv_visit_days WHERE visit_day=$1",[hoje]);
    if (day.rows[0] && day.rows[0].status==='open') {
      await client.query("INSERT INTO pv_visit_lists(visit_day,day_list_number,status) SELECT $1,COALESCE(MAX(day_list_number),0)+1,'open' FROM pv_visit_lists WHERE visit_day=$1 AND NOT EXISTS (SELECT 1 FROM pv_visit_lists WHERE visit_day=$1 AND status='open')",[hoje]);
    }
  }

  // Read-only endpoint used by the Mesa and by the Visitas panel.
  app.get('/api/pertences-visitas/visits', exigirBanco, exigirAutenticacao, acessoListasMesa, async (_req, res) => {
    try {
      const client=await pool.connect();
      try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]); await atualizarFechamentoAutomaticoVisitas(client); await client.query('COMMIT'); }
      catch(e){try{await client.query('ROLLBACK')}catch{} throw e} finally{client.release()}
      const lists = await pool.query('SELECT list_number AS "listNumber",day_list_number AS "dayListNumber",visit_day AS "visitDay",status,created_at AS "createdAt",closed_at AS "closedAt" FROM pv_visit_lists ORDER BY visit_day DESC,day_list_number');
      const entries = await pool.query('SELECT e.entry_id AS id,e.list_number AS "listNumber",l.day_list_number AS "dayListNumber",l.visit_day AS "visitDay",e.internal_name AS "internalName",e.rgi,e.pavilion,e.cell,e.created_at AS "createdAt" FROM pv_visit_entries e JOIN pv_visit_lists l USING(list_number) ORDER BY l.visit_day DESC,l.day_list_number,e.created_at,e.internal_name');
      const days = await pool.query(`SELECT d.visit_day AS "visitDay",d.status,d.closed_at AS "closedAt",d.reopened_at AS "reopenedAt",COUNT(DISTINCT COALESCE(NULLIF(e.rgi,''),LOWER(e.internal_name)))::integer AS "totalInmates" FROM pv_visit_days d LEFT JOIN pv_visit_lists l ON l.visit_day=d.visit_day LEFT JOIN pv_visit_entries e ON e.list_number=l.list_number GROUP BY d.visit_day,d.status,d.closed_at,d.reopened_at ORDER BY d.visit_day DESC`);
      const summary = await pool.query(`SELECT DISTINCT ON (l.visit_day,COALESCE(NULLIF(e.rgi,''),LOWER(e.internal_name))) l.visit_day AS "visitDay",e.internal_name AS "internalName",e.rgi,e.pavilion,e.cell FROM pv_visit_entries e JOIN pv_visit_lists l USING(list_number) ORDER BY l.visit_day,COALESCE(NULLIF(e.rgi,''),LOWER(e.internal_name)),e.created_at`);
      res.json({ok:true,lists:lists.rows,entries:entries.rows,days:days.rows,summary:summary.rows,serverTime:new Date().toISOString()});
    } catch(e){formatarErro(res,e,'Não foi possível carregar as listas de visitas.')}
  });

  app.post('/api/pertences-visitas/visits/entries', exigirBanco, exigirAutenticacao, acessoModulo, async (req,res)=>{
    const internalName=texto(req.body&&req.body.internalName,200),rgi=texto(req.body&&req.body.rgi,80),pavilion=texto(req.body&&req.body.pavilion,100),cell=texto(req.body&&req.body.cell,30);
    if(!internalName)return res.status(400).json({ok:false,message:'Selecione o nome do interno.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]);await atualizarFechamentoAutomaticoVisitas(client);
      const hoje=hojeCampoGrande();const day=await client.query("SELECT status FROM pv_visit_days WHERE visit_day=$1 FOR UPDATE",[hoje]);
      if(!day.rowCount||day.rows[0].status!=='open')throw new Error('As visitas deste dia estão encerradas. Reabra o dia para continuar os registros.');
      let current=await client.query("SELECT list_number,day_list_number FROM pv_visit_lists WHERE visit_day=$1 AND status='open' ORDER BY day_list_number DESC LIMIT 1 FOR UPDATE",[hoje]);
      if(!current.rowCount){const next=await client.query("INSERT INTO pv_visit_lists(visit_day,day_list_number,status,created_by) SELECT $1,COALESCE(MAX(day_list_number),0)+1,'open',$2 FROM pv_visit_lists WHERE visit_day=$1 RETURNING list_number,day_list_number",[hoje,req.user.id]);current=next;}
      const number=current.rows[0].list_number;
      const result=await client.query('INSERT INTO pv_visit_entries(entry_id,list_number,internal_name,rgi,pavilion,cell,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING entry_id AS id,list_number AS "listNumber",internal_name AS "internalName",rgi,pavilion,cell,created_at AS "createdAt"',[crypto.randomUUID(),number,internalName,rgi,pavilion,cell,req.user.id]);
      await client.query('COMMIT');
      try{await registrarAuditoria(req.user.id,'visita_incluida_lista',null,{listNumber:number,dayListNumber:current.rows[0].day_list_number,visitDay:hoje,internalName,rgi})}catch(e){console.error('Falha ao registrar auditoria de visitas:',e.message)}
      res.status(201).json({ok:true,entry:{...result.rows[0],dayListNumber:current.rows[0].day_list_number,visitDay:hoje}});
    }catch(e){try{await client.query('ROLLBACK')}catch{};if(e.message&&e.message.includes('visitas deste dia'))return res.status(409).json({ok:false,message:e.message});formatarErro(res,e,'Não foi possível incluir o interno na lista de visitas.')}
    finally{client.release()}
  });

  app.post('/api/pertences-visitas/visits/close',exigirBanco,exigirAutenticacao,acessoModulo,async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]);await atualizarFechamentoAutomaticoVisitas(client);
      const hoje=hojeCampoGrande();const current=await client.query("SELECT list_number,day_list_number FROM pv_visit_lists WHERE visit_day=$1 AND status='open' ORDER BY day_list_number DESC LIMIT 1 FOR UPDATE",[hoje]);
      if(!current.rowCount){const day=await client.query("SELECT status FROM pv_visit_days WHERE visit_day=$1",[hoje]);if(!day.rowCount||day.rows[0].status!=='open')throw new Error('O dia de visitas está encerrado. Reabra o dia para continuar.');}
      let closedNumber=null;
      if(current.rowCount){closedNumber=current.rows[0].day_list_number;await client.query("UPDATE pv_visit_lists SET status='closed',closed_at=NOW() WHERE list_number=$1",[current.rows[0].list_number]);}
      const next=await client.query("INSERT INTO pv_visit_lists(visit_day,day_list_number,status,created_by) SELECT $1,COALESCE(MAX(day_list_number),0)+1,'open',$2 FROM pv_visit_lists WHERE visit_day=$1 RETURNING day_list_number",[hoje,req.user.id]);
      await client.query('COMMIT');try{await registrarAuditoria(req.user.id,'visita_lista_fechada',null,{visitDay:hoje,closedListNumber:closedNumber,nextListNumber:next.rows[0].day_list_number})}catch(e){}
      res.json({ok:true,closedListNumber:closedNumber,nextListNumber:next.rows[0].day_list_number});
    }catch(e){try{await client.query('ROLLBACK')}catch{};if(e.message&&e.message.includes('dia de visitas'))return res.status(409).json({ok:false,message:e.message});formatarErro(res,e,'Não foi possível fechar a lista e abrir a próxima.')}
    finally{client.release()}
  });

  app.post('/api/pertences-visitas/visits/day/close',exigirBanco,exigirAutenticacao,acessoModulo,async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]);const hoje=hojeCampoGrande();
      await client.query("INSERT INTO pv_visit_days(visit_day,status) VALUES($1,'open') ON CONFLICT(visit_day) DO NOTHING",[hoje]);
      await client.query("UPDATE pv_visit_lists SET status='closed',closed_at=COALESCE(closed_at,NOW()) WHERE visit_day=$1 AND status='open'",[hoje]);
      await client.query("UPDATE pv_visit_days SET status='closed',closed_at=NOW(),closed_by=$2,reopened_at=NULL,reopened_by=NULL WHERE visit_day=$1",[hoje,req.user.id]);
      const total=await client.query("SELECT COUNT(DISTINCT COALESCE(NULLIF(rgi,''),LOWER(internal_name)))::integer AS total FROM pv_visit_entries e JOIN pv_visit_lists l USING(list_number) WHERE l.visit_day=$1",[hoje]);
      const rows=await client.query(`SELECT DISTINCT ON(COALESCE(NULLIF(e.rgi,''),LOWER(e.internal_name))) e.internal_name AS "internalName",e.pavilion,e.cell,e.rgi FROM pv_visit_entries e JOIN pv_visit_lists l USING(list_number) WHERE l.visit_day=$1 ORDER BY COALESCE(NULLIF(e.rgi,''),LOWER(e.internal_name)),e.created_at`,[hoje]);
      await client.query('COMMIT');try{await registrarAuditoria(req.user.id,'visitas_dia_fechado',null,{visitDay:hoje,total:total.rows[0].total})}catch(e){}
      res.json({ok:true,visitDay:hoje,totalInmates:total.rows[0].total,inmates:rows.rows});
    }catch(e){try{await client.query('ROLLBACK')}catch{};formatarErro(res,e,'Não foi possível fechar as visitas do dia.')}finally{client.release()}
  });

  app.post('/api/pertences-visitas/visits/day/reopen',exigirBanco,exigirAutenticacao,acessoModulo,async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[26261015]);const hoje=hojeCampoGrande();
      await client.query("INSERT INTO pv_visit_days(visit_day,status) VALUES($1,'open') ON CONFLICT(visit_day) DO UPDATE SET status='open',reopened_at=NOW(),reopened_by=$2",[hoje,req.user.id]);
      let open=await client.query("SELECT list_number,day_list_number FROM pv_visit_lists WHERE visit_day=$1 AND status='open' LIMIT 1 FOR UPDATE",[hoje]);
      if(!open.rowCount)open=await client.query("INSERT INTO pv_visit_lists(visit_day,day_list_number,status,created_by) SELECT $1,COALESCE(MAX(day_list_number),0)+1,'open',$2 FROM pv_visit_lists WHERE visit_day=$1 RETURNING list_number,day_list_number",[hoje,req.user.id]);
      await client.query('COMMIT');try{await registrarAuditoria(req.user.id,'visitas_dia_reaberto',null,{visitDay:hoje,nextListNumber:open.rows[0].day_list_number})}catch(e){}
      res.json({ok:true,visitDay:hoje,nextListNumber:open.rows[0].day_list_number});
    }catch(e){try{await client.query('ROLLBACK')}catch{};formatarErro(res,e,'Não foi possível reabrir as visitas do dia.')}finally{client.release()}
  });

  iniciarAgendamentoFechamentoVisitas();

  app.get('/api/pertences-visitas/attendances.xlsx', exigirBanco, exigirAutenticacao, acessoModulo, async (_req, res) => {
    try {
      const data = await pool.query("SELECT a.record_id, a.created_at, a.received_at, a.status, a.refusal_reason, a.record, u.username AS owner_username FROM attendances a LEFT JOIN users u ON u.id=a.owner_id ORDER BY a.created_at DESC");
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Sistema Atendimento CPAIG'; workbook.subject = 'ExportaÃÂÃÂ§ÃÂÃÂ£o geral de atendimentos'; workbook.title = 'Atendimentos CPAIG';
      const sheet = workbook.addWorksheet('Atendimentos');
      sheet.columns = [
        { header: 'Enviado em', key: 'createdAt', width: 22 }, { header: 'Nome do interno', key: 'nome', width: 30 },
        { header: 'RGI', key: 'rgi', width: 18 }, { header: 'PavilhÃÂÃÂ£o', key: 'pavilhao', width: 16 },
        { header: 'Cela', key: 'cela', width: 12 }, { header: 'Atendimento', key: 'atendimento', width: 24 },
        { header: 'Assunto', key: 'assunto', width: 40 }, { header: 'Status', key: 'status', width: 20 },
        { header: 'Conta de origem', key: 'owner', width: 22 }, { header: 'Recebido em', key: 'receivedAt', width: 22 },
        { header: 'Motivo da recusa', key: 'reason', width: 32 }, { header: 'Identificador', key: 'id', width: 38 }
      ];
      data.rows.forEach(row => {
        const r = row.record && typeof row.record === 'object' ? row.record : {};
        sheet.addRow({ createdAt: row.created_at || '', nome: r.nome || '', rgi: r.rgi || r.identificacao || '', pavilhao: r.pavilhao || '', cela: r.cela || '', atendimento: r.atendimento || '', assunto: r.assunto || '', status: row.status || '', owner: row.owner_username || '', receivedAt: row.received_at || '', reason: row.refusal_reason || r.motivoRecusa || '', id: row.record_id });
      });
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123D2C' } };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Atendimentos_CPAIG.xlsx"');
      res.setHeader('X-Export-Count', String(data.rowCount)); res.send(buffer);
    } catch (e) { formatarErro(res, e, 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o Excel dos atendimentos.'); }
  });

  app.get('/api/pertences-visitas/backup', exigirBanco, exigirAutenticacao, acessoModulo, async (_req, res) => {
    try {
      const results = await Promise.all([
        pool.query('SELECT record_id AS id, internal_name AS "internalName", rgi, pavilion, cell, deliverer_name AS "delivererName", relationship, received_at AS "receivedAt", created_by AS "createdBy" FROM pv_belongings ORDER BY received_at'),
        pool.query('SELECT list_number AS "listNumber",day_list_number AS "dayListNumber",visit_day AS "visitDay",status,created_at AS "createdAt",closed_at AS "closedAt",created_by AS "createdBy" FROM pv_visit_lists ORDER BY visit_day,day_list_number'),
        pool.query('SELECT entry_id AS id,list_number AS "listNumber",internal_name AS "internalName",rgi,pavilion,cell,created_at AS "createdAt",created_by AS "createdBy" FROM pv_visit_entries ORDER BY list_number,created_at'),
        pool.query('SELECT visit_day AS "visitDay",status,closed_at AS "closedAt",closed_by AS "closedBy",reopened_at AS "reopenedAt",reopened_by AS "reopenedBy" FROM pv_visit_days ORDER BY visit_day'),
        pool.query('SELECT items, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM internal_base WHERE singleton_id=1')
      ]);
      const payload = { exportedAt: new Date().toISOString(), note: 'Backup de Pertences e Visitas e cÃÂÃÂ³pia de referÃÂÃÂªncia da base compartilhada. Os atendimentos sÃÂÃÂ£o baixados separadamente pelo botÃÂÃÂ£o Excel.', belongings: results[0].rows, visitLists: results[1].rows, visitEntries: results[2].rows, visitDays: results[3].rows, internalBase: results[4].rows[0] || { items: [], updatedAt: null, updatedBy: null } };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Backup_Pertences_Visitas_' + hojeCampoGrande() + '.json"');
      res.send(JSON.stringify(payload, null, 2));
    } catch (e) { formatarErro(res, e, 'NÃÂÃÂ£o foi possÃÂÃÂ­vel gerar o backup de Pertences e Visitas.'); }
  });
}

montarRotasPertencesVisitas({ app, pool, exigirBanco, exigirAutenticacao, registrarAuditoria, PUBLIC_DIR });

app.use(express.static(PUBLIC_DIR, { etag: true, lastModified: true }));
app.use((err, _req, res, _next) => {
  console.error('Erro HTTP:', err.message);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, message: 'Erro interno do servidor.' });
});

async function iniciar() {
  if (!pool) {
    dbErrorMessage = 'O banco Neon ainda nÃÂÃÂ£o estÃÂÃÂ¡ configurado no Render (variÃÂÃÂ¡vel DATABASE_URL).';
    console.warn(dbErrorMessage);
  } else {
    try {
      await inicializarBanco();
      dbReady = true;
      dbErrorMessage = null;
      console.log('Banco Neon conectado; tabelas verificadas e filas restauradas.');
    } catch (e) {
      dbErrorMessage = 'Não foi possível inicializar o banco de dados. Consulte os logs do servidor para identificar a causa.';
      console.error('Falha ao inicializar o banco Neon:', e);
    }
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`Sistema Atendimento V${VERSAO} iniciado na porta ${PORT}`));
}
iniciar();

async function encerrarServidor(sinal) {
  console.log(`Sinal ${sinal} recebido. Encerrando servidor...`);
  for (const cliente of clientes.values()) {
    try { cliente.ws.close(1001, 'Servidor encerrando'); } catch {}
  }
  try { if (pool) await pool.end(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => encerrarServidor('SIGTERM'));
process.on('SIGINT', () => encerrarServidor('SIGINT'));
