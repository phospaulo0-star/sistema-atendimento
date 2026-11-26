'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RegraAplicacaoError,
  validarPreCondicoesAplicacao
} = require('./regras-aplicacao');

function contexto(overrides = {}) {
  const usuario = { id: 'u1', ativo: true, perfil: 'RESPONSAVEL_AREA', areas: ['a1'] };
  const area = { id: 'a1', ativa: true };
  const lote = {
    id: 'l1', area_id: 'a1', status: 'AGUARDANDO_REVISAO',
    arquivo_hash_sha256: 'a'.repeat(64), fotografia_base_id: 'f1'
  };
  const fotografiaVigente = { id: 'f1' };
  const paginas = [
    { numero_pagina: 1, status_extracao: 'PROCESSADA', processada_em: '2026-11-26T00:00:00Z' },
    { numero_pagina: 2, status_extracao: 'VAZIA_VALIDADA', processada_em: '2026-11-26T00:00:00Z' }
  ];
  const linhas = [{
    id: 'line1', status_linha: 'APROVADA', decisao: 'INCLUIR',
    decidido_por: 'u1', decidido_em: '2026-11-26T00:00:00Z',
    aplicacao_status: 'NAO_APLICADA'
  }];
  const confirmacaoCompletude = {
    confirmada: true, usuario_id: 'u1', quantidade_paginas: 2
  };
  return {
    usuario, area, lote, fotografiaVigente, paginas, linhas, confirmacaoCompletude,
    ...overrides
  };
}

function erroCodigo(fn, codigo) {
  assert.throws(fn, err => err instanceof RegraAplicacaoError && err.codigo === codigo);
}

test('aceita lote completo, revisado e comparado com fotografia vigente', () => {
  const r = validarPreCondicoesAplicacao(contexto());
  assert.equal(r.valido, true);
  assert.equal(r.quantidadePaginas, 2);
  assert.equal(r.quantidadeLinhas, 1);
});

test('nega usuário sem vínculo com a área', () => {
  const c = contexto({ usuario: { id: 'u1', ativo: true, perfil: 'RESPONSAVEL_AREA', areas: [] } });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'USUARIO_SEM_VINCULO_AREA');
});

test('nega perfil diferente de Responsável da área', () => {
  const c = contexto({ usuario: { id: 'u1', ativo: true, perfil: 'CHEFE', areas: ['a1'] } });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'PERFIL_SEM_PERMISSAO');
});

test('nega PDF sem confirmação de completude', () => {
  const c = contexto({ confirmacaoCompletude: { confirmada: false, usuario_id: 'u1', quantidade_paginas: 2 } });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'COMPLETUDE_NAO_CONFIRMADA');
});

test('nega página faltante', () => {
  const c = contexto({ paginas: [contexto().paginas[0]] });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'CONTAGEM_PAGINAS_DIVERGENTE');
});

test('nega lacuna na sequência de páginas', () => {
  const c = contexto({ paginas: [
    { numero_pagina: 1, status_extracao: 'PROCESSADA', processada_em: 'x' },
    { numero_pagina: 3, status_extracao: 'PROCESSADA', processada_em: 'x' }
  ]});
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'NUMERACAO_PAGINA_INVALIDA');
});

test('nega página com falha', () => {
  const c = contexto({ paginas: [
    { numero_pagina: 1, status_extracao: 'PROCESSADA', processada_em: 'x' },
    { numero_pagina: 2, status_extracao: 'FALHA', processada_em: null }
  ]});
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'PAGINA_NAO_PROCESSADA');
});

test('nega fotografia-base obsoleta', () => {
  const c = contexto({ fotografiaVigente: { id: 'f2' } });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'FOTOGRAFIA_BASE_OBSOLETA');
});

test('nega linha pendente', () => {
  const c = contexto({ linhas: [{ status_linha: 'POSSIVEL_HOMONIMO', decisao: null }] });
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'LINHA_PENDENTE');
});

test('nega exclusão sem justificativa', () => {
  const c = contexto({ linhas: [{
    status_linha: 'APROVADA', decisao: 'EXCLUIR', decidido_por: 'u1',
    decidido_em: '2026-11-26T00:00:00Z', motivo_decisao: '  ',
    aplicacao_status: 'NAO_APLICADA'
  }]});
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'EXCLUSAO_SEM_MOTIVO');
});

test('nega linha já aplicada', () => {
  const c = contexto({ linhas: [{
    status_linha: 'APROVADA', decisao: 'IGNORAR', decidido_por: 'u1',
    decidido_em: '2026-11-26T00:00:00Z', aplicacao_status: 'APLICADA'
  }]});
  erroCodigo(() => validarPreCondicoesAplicacao(c), 'LINHA_JA_APLICADA');
});
