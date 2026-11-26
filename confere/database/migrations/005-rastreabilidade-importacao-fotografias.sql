-- CONFERE DOS PAVILHÕES
-- Migration 005 — rastreabilidade de páginas, fotografias e aplicação por linha.
-- Depende das migrations 001 e 002.
-- Arquivo versionado para revisão; não aplicar automaticamente em confere-dev.
-- Regras de completude e autorização continuam sendo garantidas pela API.

-- Uma importação passa a ter chave composta para impedir vínculos entre áreas.
ALTER TABLE confere.importacoes
 ADD CONSTRAINT uq_importacoes_id_area UNIQUE (id, area_id);

-- Registro técnico de cada página física processada.
CREATE TABLE confere.importacao_paginas (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 importacao_id UUID NOT NULL REFERENCES confere.importacoes(id) ON DELETE RESTRICT,
 numero_pagina INTEGER NOT NULL CHECK (numero_pagina > 0),
 numero_pagina_impresso INTEGER CHECK (numero_pagina_impresso IS NULL OR numero_pagina_impresso > 0),
 status_extracao TEXT NOT NULL CHECK (status_extracao IN ('PENDENTE','PROCESSADA','VAZIA_VALIDADA','FALHA')),
 quantidade_linhas INTEGER NOT NULL DEFAULT 0 CHECK (quantidade_linhas >= 0),
 hash_conteudo CHAR(64) CHECK (hash_conteudo IS NULL OR hash_conteudo ~ '^[0-9a-fA-F]{64}$'),
 alerta TEXT,
 erro_codigo TEXT,
 processada_em TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT uq_importacao_pagina UNIQUE (importacao_id, numero_pagina),
 CHECK ((status_extracao IN ('PROCESSADA','VAZIA_VALIDADA') AND processada_em IS NOT NULL)
     OR (status_extracao IN ('PENDENTE','FALHA') AND processada_em IS NULL))
);

CREATE INDEX ix_importacao_paginas_lote_status
 ON confere.importacao_paginas(importacao_id, status_extracao, numero_pagina);

-- Uma fotografia representa o conjunto completo extraído de um único lote/área.
-- A fotografia anterior permanece preservada; apenas a vigente é substituída.
CREATE TABLE confere.fotografias_area (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 importacao_id UUID NOT NULL,
 criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 quantidade_paginas INTEGER NOT NULL CHECK (quantidade_paginas > 0),
 quantidade_linhas INTEGER NOT NULL CHECK (quantidade_linhas >= 0),
 quantidade_celas INTEGER NOT NULL CHECK (quantidade_celas >= 0),
 quantidade_internos INTEGER NOT NULL CHECK (quantidade_internos >= 0),
 hash_conjunto CHAR(64) NOT NULL CHECK (hash_conjunto ~ '^[0-9a-fA-F]{64}$'),
 versao_validador TEXT NOT NULL,
 vigente BOOLEAN NOT NULL DEFAULT TRUE,
 CONSTRAINT uq_fotografia_importacao UNIQUE (importacao_id),
 CONSTRAINT uq_fotografia_id_area UNIQUE (id, area_id),
 CONSTRAINT fk_fotografia_lote_area
  FOREIGN KEY (importacao_id, area_id)
  REFERENCES confere.importacoes(id, area_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_fotografia_vigente_por_area
 ON confere.fotografias_area(area_id) WHERE vigente = TRUE;

CREATE INDEX ix_fotografias_area_historico
 ON confere.fotografias_area(area_id, criada_em DESC);

-- A fotografia-base registra exatamente contra qual relação o lote foi conciliado.
ALTER TABLE confere.importacoes
 ADD COLUMN fotografia_base_id UUID;

ALTER TABLE confere.importacoes
 ADD CONSTRAINT fk_importacao_fotografia_base_area
 FOREIGN KEY (fotografia_base_id, area_id)
 REFERENCES confere.fotografias_area(id, area_id) ON DELETE RESTRICT;

-- Estado explícito e idempotência da aplicação de cada decisão.
ALTER TABLE confere.importacao_linhas
 ADD COLUMN aplicacao_status TEXT NOT NULL DEFAULT 'NAO_APLICADA'
 CHECK (aplicacao_status IN ('NAO_APLICADA','APLICADA'));

ALTER TABLE confere.importacao_linhas
 ADD COLUMN aplicada_em TIMESTAMPTZ;

ALTER TABLE confere.importacao_linhas
 ADD COLUMN operation_id UUID;

ALTER TABLE confere.importacao_linhas
 ADD CONSTRAINT uq_importacao_linha_operation UNIQUE (operation_id);

ALTER TABLE confere.importacao_linhas
 ADD CONSTRAINT ck_importacao_linha_aplicacao_coerente CHECK (
  (aplicacao_status = 'NAO_APLICADA' AND aplicada_em IS NULL AND operation_id IS NULL)
  OR
  (aplicacao_status = 'APLICADA'
   AND aplicada_em IS NOT NULL
   AND operation_id IS NOT NULL
   AND status_linha = 'APROVADA'
   AND decisao IS NOT NULL
   AND decidido_por IS NOT NULL
   AND decidido_em IS NOT NULL)
 );

CREATE INDEX ix_importacao_linhas_aplicacao
 ON confere.importacao_linhas(importacao_id, aplicacao_status, status_linha);

COMMENT ON TABLE confere.importacao_paginas IS
 'Rastreabilidade por página física; uma página com falha impede a confirmação de completude do lote.';

COMMENT ON TABLE confere.fotografias_area IS
 'Fotografias completas e históricas por área; somente uma pode estar vigente por área.';

COMMENT ON COLUMN confere.importacoes.fotografia_base_id IS
 'Fotografia vigente usada na conciliação; aplicação deve falhar se ela deixar de ser a vigente.';

COMMENT ON COLUMN confere.importacao_linhas.operation_id IS
 'Chave idempotente única da aplicação desta linha; preenchida somente após aplicação confirmada.';
