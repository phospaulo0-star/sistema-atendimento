'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./autorizacao');

const areaA = 'area-a';
const areaC = 'area-c';
const areaRisco = 'area-risco';
const areaD = 'area-d';

const usuario = (perfil, areas = [], ativo = true) => ({
  id: 'usuario-teste',
  perfil,
  areas,
  ativo
});

test('Chefe e Auxiliar consultam todas as áreas', () => {
  for (const perfil of [auth.PERFIS.CHEFE, auth.PERFIS.AUXILIAR]) {
    assert.equal(auth.podeAcessarArea(usuario(perfil), areaA), true);
    assert.equal(auth.podeAcessarArea(usuario(perfil), areaD), true);
  }
});

test('Administrador consulta todas as áreas, mas não inicia importação por padrão', () => {
  const admin = usuario(auth.PERFIS.ADMINISTRADOR);
  assert.equal(auth.podeAcessarArea(admin, areaA), true);
  assert.equal(auth.podeIniciarImportacao(admin, areaA), false);
  assert.equal(auth.podeAprovarImportacao(admin, areaA), false);
});

test('Responsável acessa somente as áreas vinculadas', () => {
  const responsavel = usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaC, areaRisco]);
  assert.equal(auth.podeAcessarArea(responsavel, areaC), true);
  assert.equal(auth.podeAcessarArea(responsavel, areaRisco), true);
  assert.equal(auth.podeAcessarArea(responsavel, areaD), false);
});

test('Chefe/Auxiliar podem iniciar importação em qualquer área', () => {
  for (const perfil of [auth.PERFIS.CHEFE, auth.PERFIS.AUXILIAR]) {
    assert.equal(auth.podeIniciarImportacao(usuario(perfil), areaD), true);
  }
});

test('Responsável só inicia e aprova importação na própria área', () => {
  const responsavel = usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaC]);
  assert.equal(auth.podeIniciarImportacao(responsavel, areaC), true);
  assert.equal(auth.podeIniciarImportacao(responsavel, areaD), false);
  assert.equal(auth.podeAprovarImportacao(responsavel, areaC), true);
  assert.equal(auth.podeAprovarImportacao(responsavel, areaD), false);
});

test('Somente Responsável da área finaliza conferência', () => {
  const responsavel = usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaC]);
  assert.equal(auth.podeFinalizarConferencia(responsavel, areaC), true);
  assert.equal(auth.podeFinalizarConferencia(usuario(auth.PERFIS.CHEFE), areaC), false);
});

test('Transferência na mesma conta é decidida pela área de origem', () => {
  const responsavelOrigem = usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaC]);
  const contexto = {
    areaOrigemId: areaC,
    areaDestinoId: areaRisco,
    contaOrigem: 'C',
    contaDestino: 'C'
  };
  assert.equal(auth.podeDecidirTransferencia(responsavelOrigem, contexto), true);
  assert.equal(auth.podeDecidirTransferencia(
    usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaRisco]), contexto
  ), false);
});

test('Transferência entre contas exige Responsável da área de destino', () => {
  const contexto = {
    areaOrigemId: areaC,
    areaDestinoId: areaD,
    contaOrigem: 'C',
    contaDestino: 'D'
  };
  assert.equal(auth.podeDecidirTransferencia(
    usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaC]), contexto
  ), false);
  assert.equal(auth.podeDecidirTransferencia(
    usuario(auth.PERFIS.RESPONSAVEL_AREA, [areaD]), contexto
  ), true);
});

test('Usuário inativo ou sem perfil reconhecido nunca é autorizado', () => {
  assert.equal(auth.podeAcessarArea(usuario(auth.PERFIS.CHEFE, [], false), areaA), false);
  assert.equal(auth.podeAcessarArea(usuario('ROOT'), areaA), false);
});

test('Identidade vem exclusivamente de req.auth.user', () => {
  assert.throws(
    () => auth.obterUsuarioDaSessao({ body: { usuario_id: 'forjado' }, query: { usuario_id: 'forjado' } }),
    (error) => error.codigo === 'SESSAO_NAO_AUTENTICADA' && error.statusHttp === 401
  );
  assert.equal(
    auth.obterUsuarioDaSessao({ auth: { user: usuario(auth.PERFIS.CHEFE) } }).perfil,
    auth.PERFIS.CHEFE
  );
});
