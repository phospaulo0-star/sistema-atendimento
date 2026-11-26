-- CONFERE DOS PAVILHÕES
-- Migration 004 — decisão transacional de transferência.
-- Depende das migrations 001 e 002.
-- SECURITY INVOKER: permissões da role chamadora são respeitadas.
-- Entre contas: Responsável ativo da área de destino decide.
-- Dentro da mesma conta: Responsável ativo da área de origem efetiva diretamente.

CREATE OR REPLACE FUNCTION confere.fn_decidir_transferencia(
 p_transferencia_id UUID,
 p_usuario_id UUID,
 p_decisao TEXT,
 p_observacao TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
 v_t confere.transferencias%ROWTYPE;
 v_l confere.localizacoes%ROWTYPE;
 v_i confere.internos%ROWTYPE;
 v_conta_origem TEXT;
 v_conta_destino TEXT;
 v_mesma_conta BOOLEAN;
 v_area_autorizacao UUID;
 v_destino_ativo BOOLEAN;
 v_nova_localizacao UUID;
 v_agora TIMESTAMPTZ := clock_timestamp();
BEGIN
 IF p_decisao NOT IN ('ACEITA','RECUSADA') THEN
  RAISE EXCEPTION 'Decisao invalida';
 END IF;
 IF p_observacao IS NULL OR length(trim(p_observacao)) = 0 THEN
  RAISE EXCEPTION 'Informe a observacao/motivo da decisao';
 END IF;

 SELECT * INTO v_t FROM confere.transferencias
  WHERE id = p_transferencia_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transferencia nao encontrada'; END IF;
 IF v_t.status <> 'PENDENTE' THEN RAISE EXCEPTION 'Transferencia nao esta pendente'; END IF;

 SELECT conta_codigo INTO v_conta_origem
 FROM confere.areas WHERE id = v_t.area_origem_id;
 SELECT conta_codigo INTO v_conta_destino
 FROM confere.areas WHERE id = v_t.area_destino_id;
 IF v_conta_origem IS NULL OR v_conta_destino IS NULL THEN
  RAISE EXCEPTION 'Conta da area de origem ou destino nao encontrada';
 END IF;
 v_mesma_conta := (v_conta_origem = v_conta_destino);
 v_area_autorizacao := CASE WHEN v_mesma_conta THEN v_t.area_origem_id ELSE v_t.area_destino_id END;

 PERFORM 1 FROM confere.usuarios
  WHERE id = p_usuario_id AND ativo = TRUE AND perfil = 'RESPONSAVEL_AREA';
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Somente Responsavel de area ativo pode decidir a transferencia';
 END IF;

 PERFORM 1 FROM confere.usuario_areas
  WHERE usuario_id = p_usuario_id AND area_id = v_area_autorizacao;
 IF NOT FOUND THEN
  IF v_mesma_conta THEN
   RAISE EXCEPTION 'Usuario nao autorizado na area de origem';
  ELSE
   RAISE EXCEPTION 'Usuario nao autorizado na area de destino';
  END IF;
 END IF;

 -- A recusa registra a decisão, sem alterar a localização.
 IF p_decisao = 'RECUSADA' THEN
  -- Para transferências entre contas, a recusa cabe ao destino.
  -- Na mesma conta, a área de origem pode interromper o pedido.
  IF NOT v_mesma_conta THEN
   INSERT INTO confere.transferencias_aprovacoes
    (transferencia_id, decisao, usuario_destino_id, decidido_em, observacao)
   VALUES (v_t.id, p_decisao, p_usuario_id, v_agora, trim(p_observacao));
  END IF;

  UPDATE confere.transferencias SET status='RECUSADA' WHERE id=v_t.id;

  INSERT INTO confere.historico_eventos
   (interno_id, area_id, tipo_evento, ocorrido_em, responsavel_id, motivo,
    dados_anteriores, dados_novos, referencia_tipo, referencia_id, operation_id)
  VALUES
   (v_t.interno_id, v_t.area_origem_id, 'TRANSFERENCIA_RECUSADA', v_agora, p_usuario_id,
    trim(p_observacao),
    jsonb_build_object('area_destino_id',v_t.area_destino_id,'cela_destino_id',v_t.cela_destino_id),
    jsonb_build_object('status','RECUSADA','mesma_conta',v_mesma_conta),
    'TRANSFERENCIA',v_t.id,v_t.operation_id);

  INSERT INTO confere.auditoria
   (ator_id, acao, entidade, entidade_id, ocorrido_em, correlation_id, detalhes)
  VALUES
   (p_usuario_id,'RECUSAR','TRANSFERENCIA',v_t.id,v_agora,v_t.operation_id,
    jsonb_build_object('interno_id',v_t.interno_id,'observacao',trim(p_observacao),
     'mesma_conta',v_mesma_conta,'conta_origem',v_conta_origem,'conta_destino',v_conta_destino));

  RETURN jsonb_build_object('status','RECUSADA','localizacao_alterada',false,
   'mesma_conta',v_mesma_conta);
 END IF;

 -- ACEITA: valida cadastro e localização atual, independentemente do fluxo.
 SELECT * INTO v_i FROM confere.internos
  WHERE id = v_t.interno_id FOR UPDATE;
 IF NOT FOUND OR v_i.status_cadastro <> 'ATIVO' THEN
  RAISE EXCEPTION 'Interno inexistente ou inativo';
 END IF;

 SELECT * INTO v_l FROM confere.localizacoes
  WHERE id = v_t.localizacao_origem_id FOR UPDATE;
 IF NOT FOUND
   OR v_l.interno_id <> v_t.interno_id
   OR v_l.area_id <> v_t.area_origem_id
   OR v_l.cela_id <> v_t.cela_origem_id
   OR v_l.fim_em IS NOT NULL THEN
  RAISE EXCEPTION 'Localizacao de origem nao e mais a localizacao atual do interno';
 END IF;

 SELECT (a.ativa AND c.ativa) INTO v_destino_ativo
 FROM confere.areas a
 JOIN confere.celas c ON c.area_id = a.id
 WHERE a.id = v_t.area_destino_id AND c.id = v_t.cela_destino_id;
 IF coalesce(v_destino_ativo,FALSE) = FALSE THEN
  RAISE EXCEPTION 'Area ou cela de destino inativa ou inexistente';
 END IF;

 -- Somente transferências entre contas distintas geram aceite formal do destino.
 -- Na mesma conta, o Responsável da origem efetiva diretamente; o evento e a
 -- auditoria identificam esse fluxo, sem registrar um aceite fictício do destino.
 IF NOT v_mesma_conta THEN
  INSERT INTO confere.transferencias_aprovacoes
   (transferencia_id, decisao, usuario_destino_id, decidido_em, observacao)
  VALUES (v_t.id, p_decisao, p_usuario_id, v_agora, trim(p_observacao));
 END IF;

 UPDATE confere.localizacoes SET fim_em=v_agora
  WHERE id=v_l.id AND fim_em IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Falha ao encerrar localizacao de origem'; END IF;

 INSERT INTO confere.localizacoes
  (interno_id,area_id,cela_id,inicio_em,motivo,responsavel_id)
 VALUES
  (v_t.interno_id,v_t.area_destino_id,v_t.cela_destino_id,v_agora,
   'Transferencia aceita: '||trim(p_observacao),p_usuario_id)
 RETURNING id INTO v_nova_localizacao;

 UPDATE confere.transferencias SET status='ACEITA' WHERE id=v_t.id;

 INSERT INTO confere.historico_eventos
  (interno_id,area_id,tipo_evento,ocorrido_em,responsavel_id,motivo,
   dados_anteriores,dados_novos,referencia_tipo,referencia_id,operation_id)
 VALUES
  (v_t.interno_id,v_t.area_destino_id,'TRANSFERENCIA_ACEITA',v_agora,p_usuario_id,
   trim(p_observacao),
   jsonb_build_object('area_id',v_t.area_origem_id,'cela_id',v_t.cela_origem_id,'localizacao_id',v_l.id),
   jsonb_build_object('area_id',v_t.area_destino_id,'cela_id',v_t.cela_destino_id,
    'localizacao_id',v_nova_localizacao,'mesma_conta',v_mesma_conta),
   'TRANSFERENCIA',v_t.id,v_t.operation_id);

 INSERT INTO confere.auditoria
  (ator_id,acao,entidade,entidade_id,ocorrido_em,correlation_id,detalhes)
 VALUES
  (p_usuario_id,'ACEITAR','TRANSFERENCIA',v_t.id,v_agora,v_t.operation_id,
   jsonb_build_object('interno_id',v_t.interno_id,'origem_area_id',v_t.area_origem_id,
    'origem_cela_id',v_t.cela_origem_id,'destino_area_id',v_t.area_destino_id,
    'destino_cela_id',v_t.cela_destino_id,'nova_localizacao_id',v_nova_localizacao,
    'mesma_conta',v_mesma_conta,'conta_origem',v_conta_origem,'conta_destino',v_conta_destino,
    'decisao_por_area',CASE WHEN v_mesma_conta THEN 'ORIGEM_DIRETA' ELSE 'DESTINO_ACEITE' END));

 RETURN jsonb_build_object('status','ACEITA','localizacao_alterada',true,
  'nova_localizacao_id',v_nova_localizacao,'mesma_conta',v_mesma_conta,
  'fluxo',CASE WHEN v_mesma_conta THEN 'ORIGEM_DIRETA' ELSE 'DESTINO_ACEITE' END);
END;
$$;
