-- CONFERE DOS PAVILHÕES
-- Migration 006 — confirmação formal de completude e idempotência do lote.
-- Depende das migrations 001, 002 e 005.
-- DDL versionado para validação; não aplicar na branch permanente sem aprovação.

ALTER TABLE confere.importacoes
 ADD COLUMN quantidade_paginas_pdf INTEGER;

ALTER TABLE confere.importacoes
 ADD COLUMN completude_confirmada_em TIMESTAMPTZ;

ALTER TABLE confere.importacoes
 ADD COLUMN completude_confirmada_por UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT;

ALTER TABLE confere.importacoes
 ADD CONSTRAINT ck_importacao_completude_coerente CHECK (
   (completude_confirmada_em IS NULL AND completude_confirmada_por IS NULL AND quantidade_paginas_pdf IS NULL)
   OR
   (completude_confirmada_em IS NOT NULL AND completude_confirmada_por IS NOT NULL
    AND quantidade_paginas_pdf IS NOT NULL AND quantidade_paginas_pdf > 0)
 );

CREATE TABLE confere.importacao_operacoes (
 operation_id UUID PRIMARY KEY,
 importacao_id UUID NOT NULL REFERENCES confere.importacoes(id) ON DELETE RESTRICT,
 ator_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-fA-F]{64}$'),
 status TEXT NOT NULL CHECK (status IN ('PROCESSANDO','CONCLUIDA','REJEITADA')),
 iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 concluido_em TIMESTAMPTZ,
 resultado JSONB,
 CONSTRAINT ck_importacao_operacao_estado CHECK (
   (status = 'PROCESSANDO' AND concluido_em IS NULL)
   OR
   (status IN ('CONCLUIDA','REJEITADA') AND concluido_em IS NOT NULL)
 )
);

CREATE INDEX ix_importacao_operacoes_lote_data
 ON confere.importacao_operacoes(importacao_id, iniciado_em DESC);

ALTER TABLE confere.importacoes
 ADD CONSTRAINT ck_importacao_paginas_pdf_positivo
 CHECK (quantidade_paginas_pdf IS NULL OR quantidade_paginas_pdf > 0);
