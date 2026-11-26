'use strict';

/**
 * Autorização de domínio do CONFERE.
 *
 * Entrada: usuário já autenticado e carregado do banco pela camada de sessão.
 * Nunca passar req.body como usuário. A camada HTTP deve chamar este módulo
 * usando req.auth.user, preenchido exclusivamente no servidor.
 *
 * Este módulo não autentica, não consulta o banco e não substitui a revalidação
 * de vínculos/estado dentro da transação PostgreSQL.
 */

const PERFIS = Object.freeze({
  ADMINISTRADOR: 'ADMINISTRADOR',
  CHEFE: 'CHEFE',
  AUXILIAR: 'AUXILIAR',
  RESPONSAVEL_AREA: 'RESPONSAVEL_AREA'
});

class AutorizacaoError extends Error {
  constructor(codigo, mensagem, statusHttp = 403) {
    super(mensagem);
    this.name = 'AutorizacaoError';
    this.codigo = codigo;
    this.statusHttp = statusHttp;
  }
}

function negar(codigo, mensagem) {
  throw new AutorizacaoError(codigo, mensagem);
}

function usuarioValido(usuario) {
  return Boolean(usuario && usuario.ativo === true && typeof usuario.id === 'string'
    && Object.values(PERFIS).includes(usuario.perfil));
}

function idsAreasDoUsuario(usuario) {
  if (!Array.isArray(usuario?.areas)) return new Set();
  return new Set(usuario.areas.filter((id) => typeof id === 'string' && id.length > 0));
}

function podeConsultarTodasAreas(usuario) {
  return usuarioValido(usuario)
    && [PERFIS.ADMINISTRADOR, PERFIS.CHEFE, PERFIS.AUXILIAR].includes(usuario.perfil);
}

function podeAcessarArea(usuario, areaId) {
  if (!usuarioValido(usuario) || typeof areaId !== 'string' || !areaId) return false;
  if (podeConsultarTodasAreas(usuario)) return true;
  return usuario.perfil === PERFIS.RESPONSAVEL_AREA && idsAreasDoUsuario(usuario).has(areaId);
}

function exigirArea(usuario, areaId) {
  if (!usuarioValido(usuario)) negar('USUARIO_INVALIDO_OU_INATIVO', 'Sessão inválida ou usuário inativo.');
  if (!podeAcessarArea(usuario, areaId)) {
    negar('SEM_ACESSO_A_AREA', 'Usuário não possui acesso à área solicitada.');
  }
  return true;
}

function podeIniciarImportacao(usuario, areaId) {
  if (!usuarioValido(usuario)) return false;
  if ([PERFIS.CHEFE, PERFIS.AUXILIAR].includes(usuario.perfil)) return true;
  return usuario.perfil === PERFIS.RESPONSAVEL_AREA
    && idsAreasDoUsuario(usuario).has(areaId);
  // Administrador permanece sem permissão de iniciar importação por padrão.
}

function exigirInicioImportacao(usuario, areaId) {
  if (!podeIniciarImportacao(usuario, areaId)) {
    negar('SEM_PERMISSAO_INICIAR_IMPORTACAO', 'Usuário não pode iniciar importação para esta área.');
  }
  return true;
}

function podeAprovarImportacao(usuario, areaId) {
  return usuarioValido(usuario)
    && usuario.perfil === PERFIS.RESPONSAVEL_AREA
    && idsAreasDoUsuario(usuario).has(areaId);
}

function exigirAprovacaoImportacao(usuario, areaId) {
  if (!podeAprovarImportacao(usuario, areaId)) {
    negar('SEM_PERMISSAO_APROVAR_IMPORTACAO', 'Somente o Responsável vinculado à área pode aprovar divergências.');
  }
  return true;
}

function podeFinalizarConferencia(usuario, areaId) {
  return usuarioValido(usuario)
    && usuario.perfil === PERFIS.RESPONSAVEL_AREA
    && idsAreasDoUsuario(usuario).has(areaId);
}

function exigirFinalizacaoConferencia(usuario, areaId) {
  if (!podeFinalizarConferencia(usuario, areaId)) {
    negar('SEM_PERMISSAO_FINALIZAR_CONFERENCIA', 'Somente o Responsável vinculado à área pode finalizar a conferência.');
  }
  return true;
}

/**
 * A decisão final também deve ser validada pela função SQL e dentro da
 * transação. Esta checagem de domínio serve como barreira anterior.
 */
function podeDecidirTransferencia(usuario, { areaOrigemId, areaDestinoId, contaOrigem, contaDestino }) {
  if (!usuarioValido(usuario) || usuario.perfil !== PERFIS.RESPONSAVEL_AREA) return false;
  if (![areaOrigemId, areaDestinoId, contaOrigem, contaDestino].every((v) => typeof v === 'string' && v)) {
    return false;
  }
  const areas = idsAreasDoUsuario(usuario);
  if (contaOrigem === contaDestino) return areas.has(areaOrigemId);
  return areas.has(areaDestinoId);
}

function exigirDecisaoTransferencia(usuario, contexto) {
  if (!podeDecidirTransferencia(usuario, contexto)) {
    negar('SEM_PERMISSAO_DECIDIR_TRANSFERENCIA',
      'Transferência exige Responsável da origem na mesma conta ou Responsável do destino entre contas.');
  }
  return true;
}

/**
 * Middleware de autenticação é injetado pela aplicação depois que a estratégia
 * de sessão for definida. Este helper não tenta ler identidade do corpo/query.
 */
function obterUsuarioDaSessao(req) {
  const usuario = req && req.auth && req.auth.user;
  if (!usuarioValido(usuario)) {
    throw new AutorizacaoError('SESSAO_NAO_AUTENTICADA', 'É necessário autenticar novamente.', 401);
  }
  return usuario;
}

module.exports = {
  PERFIS,
  AutorizacaoError,
  usuarioValido,
  podeConsultarTodasAreas,
  podeAcessarArea,
  exigirArea,
  podeIniciarImportacao,
  exigirInicioImportacao,
  podeAprovarImportacao,
  exigirAprovacaoImportacao,
  podeFinalizarConferencia,
  exigirFinalizacaoConferencia,
  podeDecidirTransferencia,
  exigirDecisaoTransferencia,
  obterUsuarioDaSessao
};
