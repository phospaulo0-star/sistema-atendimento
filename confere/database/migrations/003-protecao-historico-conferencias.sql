-- CONFERE DOS PAVILHÕES
-- Migration 003 — proteção de auditoria, histórico e conferências.
-- Depende das migrations 001 e 002.
-- Aplicação somente após revisão e autorização expressa.

CREATE OR REPLACE FUNCTION confere.fn_bloquear_alteracao_historico() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Registro historico/auditoria e imutavel';
END;
$$;

CREATE TRIGGER trg_auditoria_imutavel
 BEFORE UPDATE OR DELETE ON confere.auditoria
 FOR EACH ROW EXECUTE FUNCTION confere.fn_bloquear_alteracao_historico();

CREATE TRIGGER trg_historico_eventos_imutavel
 BEFORE UPDATE OR DELETE ON confere.historico_eventos
 FOR EACH ROW EXECUTE FUNCTION confere.fn_bloquear_alteracao_historico();

CREATE OR REPLACE FUNCTION confere.fn_proteger_conferencia_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Itens de conferencia nao podem ser apagados';
 END IF;
 IF NEW.conferencia_id IS DISTINCT FROM OLD.conferencia_id
    OR NEW.interno_id IS DISTINCT FROM OLD.interno_id
    OR NEW.nome_snapshot IS DISTINCT FROM OLD.nome_snapshot
    OR NEW.area_snapshot IS DISTINCT FROM OLD.area_snapshot
    OR NEW.cela_snapshot IS DISTINCT FROM OLD.cela_snapshot
    OR NEW.localizacao_id_snapshot IS DISTINCT FROM OLD.localizacao_id_snapshot THEN
  RAISE EXCEPTION 'Snapshot da conferencia e imutavel';
 END IF;
 SELECT status INTO v_status FROM confere.conferencias WHERE id = OLD.conferencia_id FOR UPDATE;
 IF v_status IS DISTINCT FROM 'EM_ANDAMENTO' THEN
  RAISE EXCEPTION 'Conferencia finalizada ou cancelada nao pode ser alterada';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conferencia_item_protegido
 BEFORE UPDATE OR DELETE ON confere.conferencia_itens
 FOR EACH ROW EXECUTE FUNCTION confere.fn_proteger_conferencia_item();

CREATE OR REPLACE FUNCTION confere.fn_proteger_conferencia() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Conferencias nao podem ser apagadas';
 END IF;
 IF OLD.status IN ('FINALIZADA','CANCELADA') THEN
  RAISE EXCEPTION 'Conferencia finalizada ou cancelada e imutavel';
 END IF;
 IF NEW.area_id IS DISTINCT FROM OLD.area_id
    OR NEW.modalidade IS DISTINCT FROM OLD.modalidade
    OR NEW.iniciada_em IS DISTINCT FROM OLD.iniciada_em
    OR NEW.responsavel_id IS DISTINCT FROM OLD.responsavel_id THEN
  RAISE EXCEPTION 'Identidade e parametros iniciais da conferencia sao imutaveis';
 END IF;
 IF NEW.status NOT IN ('EM_ANDAMENTO','FINALIZADA','CANCELADA') THEN
  RAISE EXCEPTION 'Transicao de status invalida';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conferencia_protegida
 BEFORE UPDATE OR DELETE ON confere.conferencias
 FOR EACH ROW EXECUTE FUNCTION confere.fn_proteger_conferencia();
