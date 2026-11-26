'use strict';

/**
 * Regras puras de pré-validação da aplicação de lote do CONFERE.
 *
 * Este módulo não acessa banco, não autentica sessão e não substitui
 * bloqueios/constraints/transação PostgreSQL. A API deve carregar os dados
 * sob lock e passar snapshots confiáveis do banco para esta função.
 */

const ESTADOS_PAGINA_VALIDOS = new Set(['PROCESSADA', 'VAZIA_VALIDADA']);
const DECISOES_FINAIS = new Set(['INCLUIR', 'ATUALIZAR', 'MOVER', 'EXCLUIR', 'IGNORAR', 'VINCULAR']);

class RegraAplicacaoError extends Error {
  constructor(codigo, mensagem, statusHttp = 409) {
    super(mensagem);
    this.name = 'RegraAplicacaoError';
    this.codigo = codigo;
    this.statusHttp = statusHttp;
  }
}

function falhar(codigo, mensagem, statusHttp) {
  throw new RegraAplicacaoError(codigo, mensagem, statusHttp);
}

function exigir(condicao, codigo, mensagem, statusHttp) {
  if (!condicao) falhar(codigo, mensagem, statusHttp);
}

/**
 * Recebe exclusivamente dados já consultados no servidor, dentro da
 * transação e depois dos locks. Não passar diretamente req.body.
 */
function validarPreCondicoesAplicacao({
  usuario,
  area,
  lote,
  fotografiaVigente,
  paginas,
  linhas,
  confirmacaoCompletude
}) {
  exigir(usuario && usuario.ativo === true, 'USUARIO_INATIVO', 'Usuário inexistente ou inativo.', 403);
  exigir(usuario.perfil === 'RESPONSAVEL_AREA', 'PERFIL_SEM_PERMISSAO', 'Somente o Responsável da área pode aplicar este lote.', 403);
  exigir(area && area.ativa === true, 'AREA_INATIVA', 'Área inexistente ou inativa.', 409);
  exigir(Array.isArray(usuario.areas) && usuario.areas.includes(area.id),
    'USUARIO_SEM_VINCULO_AREA', 'Usuário não está vinculado à área deste lote.', 403);

  exigir(lote && lote.area_id === area.id, 'LOTE_AREA_DIVERGENTE', 'O lote não pertence à área informada.', 409);
  exigir(lote.status === 'AGUARDANDO_REVISAO', 'ESTADO_LOTE_INVALIDO', 'O lote não está aguardando revisão.', 409);
  exigir(typeof lote.arquivo_hash_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(lote.arquivo_hash_sha256),
    'HASH_LOTE_INVALIDO', 'O hash do arquivo do lote está ausente ou inválido.', 409);

  exigir(confirmacaoCompletude && confirmacaoCompletude.confirmada === true,
    'COMPLETUDE_NAO_CONFIRMADA', 'A completude do PDF ainda não foi confirmada.', 409);
  exigir(confirmacaoCompletude.usuario_id === usuario.id,
    'ATOR_CONFIRMACAO_DIVERGENTE', 'A confirmação de completude não corresponde ao usuário autenticado.', 409);
  exigir(Number.isInteger(confirmacaoCompletude.quantidade_paginas) && confirmacaoCompletude.quantidade_paginas > 0,
    'TOTAL_PAGINAS_INVALIDO', 'A quantidade total de páginas não foi validada.', 409);

  exigir(Array.isArray(paginas), 'PAGINAS_AUSENTES', 'Não foi possível validar as páginas do PDF.', 409);
  const total = confirmacaoCompletude.quantidade_paginas;
  exigir(paginas.length === total, 'CONTAGEM_PAGINAS_DIVERGENTE', 'A quantidade de páginas processadas não corresponde ao total validado.', 409);

  const numeros = new Set();
  for (const pagina of paginas) {
    exigir(Number.isInteger(pagina.numero_pagina) && pagina.numero_pagina >= 1 && pagina.numero_pagina <= total,
      'NUMERACAO_PAGINA_INVALIDA', 'Há página com numeração inválida.', 409);
    exigir(!numeros.has(pagina.numero_pagina), 'PAGINA_DUPLICADA', 'Há página duplicada no lote.', 409);
    numeros.add(pagina.numero_pagina);
    exigir(ESTADOS_PAGINA_VALIDOS.has(pagina.status_extracao),
      'PAGINA_NAO_PROCESSADA', 'Todas as páginas precisam estar processadas ou validadas como vazias.', 409);
    exigir(pagina.processada_em, 'PAGINA_SEM_DATA_PROCESSAMENTO', 'Há página sem confirmação de processamento.', 409);
  }
  for (let n = 1; n <= total; n++) {
    exigir(numeros.has(n), 'LACUNA_PAGINACAO', 'A sequência de páginas contém lacuna.', 409);
  }

  const fotoIdAtual = fotografiaVigente ? fotografiaVigente.id : null;
  const fotoIdBase = lote.fotografia_base_id || null;
  exigir(fotoIdAtual === fotoIdBase, 'FOTOGRAFIA_BASE_OBSOLETA',
    'A relação da área foi atualizada desde a conciliação. É necessário conciliar o lote novamente.', 409);

  exigir(Array.isArray(linhas) && linhas.length > 0, 'LINHAS_AUSENTES', 'O lote não possui linhas para revisão.', 409);
  for (const linha of linhas) {
    exigir(linha.status_linha === 'APROVADA' && DECISOES_FINAIS.has(linha.decisao),
      'LINHA_PENDENTE', 'Há linha sem decisão final aprovada.', 409);
    exigir(linha.decidido_por && linha.decidido_em,
      'DECISAO_SEM_RESPONSAVEL', 'Há decisão sem responsável ou data de registro.', 409);
    if (linha.decisao === 'EXCLUIR') {
      exigir(typeof linha.motivo_decisao === 'string' && linha.motivo_decisao.trim().length > 0,
        'EXCLUSAO_SEM_MOTIVO', 'Toda exclusão lógica exige justificativa.', 409);
    }
    exigir(linha.aplicacao_status !== 'APLICADA',
      'LINHA_JA_APLICADA', 'O lote contém linha já aplicada; verificar idempotência antes de continuar.', 409);
  }

  return {
    valido: true,
    areaId: area.id,
    loteId: lote.id,
    quantidadePaginas: total,
    quantidadeLinhas: linhas.length,
    fotografiaBaseId: fotoIdBase
  };
}

module.exports = {
  RegraAplicacaoError,
  validarPreCondicoesAplicacao
};
