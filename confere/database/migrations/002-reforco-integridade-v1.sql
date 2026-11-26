-- CONFERE DOS PAVILHÕES
-- Migration 002 — reforço de integridade relacional.
-- Depende de 001-estrutura-inicial-v1.sql.
-- Não aplicada à branch permanente confere-dev.

ALTER TABLE confere.areas
 ADD CONSTRAINT ck_areas_conta_codigo CHECK (
  (codigo = 'PAV_A' AND conta_codigo = 'A') OR
  (codigo = 'PAV_B' AND conta_codigo = 'B') OR
  (codigo IN ('PAV_C','DISC_RISCO','DISCIPLINAR') AND conta_codigo = 'C') OR
  (codigo IN ('PAV_D','CP') AND conta_codigo = 'D') OR
  (codigo = 'PAV_VIRTUAL' AND conta_codigo = 'VIRTUAL')
);

ALTER TABLE confere.localizacoes
 ADD CONSTRAINT uq_localizacoes_id_area_cela UNIQUE (id, area_id, cela_id);

ALTER TABLE confere.transferencias
 ADD CONSTRAINT fk_transfer_origem_localizacao_composta
 FOREIGN KEY (localizacao_origem_id, area_origem_id, cela_origem_id)
 REFERENCES confere.localizacoes(id, area_id, cela_id) ON DELETE RESTRICT;

ALTER TABLE confere.transferencias
 ADD CONSTRAINT fk_transfer_cela_origem_area
 FOREIGN KEY (cela_origem_id, area_origem_id)
 REFERENCES confere.celas(id, area_id) ON DELETE RESTRICT;

ALTER TABLE confere.transferencias
 ADD CONSTRAINT fk_transfer_cela_destino_area
 FOREIGN KEY (cela_destino_id, area_destino_id)
 REFERENCES confere.celas(id, area_id) ON DELETE RESTRICT;

ALTER TABLE confere.transferencias_aprovacoes
 ADD CONSTRAINT uq_transferencia_aprovacao_unica UNIQUE (transferencia_id);

ALTER TABLE confere.transferencias
 ADD CONSTRAINT ck_transferencia_motivo_nao_vazio
 CHECK (length(trim(motivo)) > 0);

ALTER TABLE confere.importacoes
 ADD CONSTRAINT uq_importacao_hash_por_area
 UNIQUE (area_id, arquivo_hash_sha256);

ALTER TABLE confere.senhas_diarias
 ADD CONSTRAINT ck_senha_diaria_alvo_exclusivo CHECK (
  (usuario_id IS NOT NULL AND conta_codigo IS NULL) OR
  (usuario_id IS NULL AND conta_codigo IS NOT NULL)
);

CREATE UNIQUE INDEX uq_senha_diaria_usuario_inicio
 ON confere.senhas_diarias(usuario_id, valid_from) WHERE usuario_id IS NOT NULL;

CREATE UNIQUE INDEX uq_senha_diaria_conta_inicio
 ON confere.senhas_diarias(conta_codigo, valid_from) WHERE conta_codigo IS NOT NULL;

ALTER TABLE confere.conferencia_itens
 ADD CONSTRAINT ck_conferencia_marcacao_coerente CHECK (
  (resultado = 'PENDENTE' AND marcado_por IS NULL AND marcado_em IS NULL) OR
  (resultado <> 'PENDENTE' AND marcado_por IS NOT NULL AND marcado_em IS NOT NULL)
);

ALTER TABLE confere.movimentacoes
 ADD CONSTRAINT ck_movimentacao_responsavel_encerramento CHECK (
  (status = 'ABERTA' AND responsavel_encerramento_id IS NULL) OR
  (status <> 'ABERTA' AND responsavel_encerramento_id IS NOT NULL)
);

CREATE INDEX ix_transferencias_interno_criada
 ON confere.transferencias(interno_id, criada_em DESC);
