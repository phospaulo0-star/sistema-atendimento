-- CONFERE DOS PAVILHÕES
-- Migration inicial v1 — estrutura relacional de base.
-- Projeto exclusivo: confere-pavilhoes-dev / branch confere-dev.
-- ATENÇÃO: arquivo versionado para revisão. Não aplicar automaticamente.
-- Regras de autorização, append-only, snapshots imutáveis e transações
-- precisam também de implementação na API e testes de integração.
-- Horários operacionais devem ser calculados pela aplicação em
-- America/Campo_Grande; timestamps são armazenados como TIMESTAMPTZ.

CREATE SCHEMA IF NOT EXISTS confere;

CREATE TABLE confere.areas (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 codigo TEXT NOT NULL UNIQUE,
 nome TEXT NOT NULL,
 conta_codigo TEXT NOT NULL CHECK (conta_codigo IN ('A','B','C','D','VIRTUAL')),
 ativa BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (codigo IN ('PAV_A','PAV_B','PAV_C','DISC_RISCO','DISCIPLINAR','PAV_D','CP','PAV_VIRTUAL'))
);

CREATE TABLE confere.usuarios (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 login TEXT NOT NULL UNIQUE,
 nome_exibicao TEXT NOT NULL,
 senha_hash TEXT NOT NULL,
 perfil TEXT NOT NULL CHECK (perfil IN ('ADMINISTRADOR','CHEFE','AUXILIAR','RESPONSAVEL_AREA')),
 ativo BOOLEAN NOT NULL DEFAULT TRUE,
 ultimo_acesso_em TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE confere.usuario_areas (
 usuario_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 permissoes JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (usuario_id, area_id)
);

CREATE TABLE confere.celas (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 codigo TEXT NOT NULL,
 codigo_normalizado TEXT NOT NULL,
 ordem_exibicao INTEGER,
 ativa BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT uq_celas_area_codigo UNIQUE (area_id, codigo_normalizado),
 CONSTRAINT uq_celas_id_area UNIQUE (id, area_id),
 CHECK (length(trim(codigo)) > 0),
 CHECK (length(trim(codigo_normalizado)) > 0)
);

CREATE TABLE confere.internos (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 nome_completo TEXT NOT NULL,
 data_entrada DATE,
 procedencia TEXT,
 setor_trabalho TEXT,
 status_cadastro TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status_cadastro IN ('ATIVO','EXCLUIDO')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_by UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 updated_by UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 CHECK (length(trim(nome_completo)) > 0)
);

CREATE TABLE confere.historico_eventos (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 interno_id UUID REFERENCES confere.internos(id) ON DELETE RESTRICT,
 area_id UUID REFERENCES confere.areas(id) ON DELETE RESTRICT,
 tipo_evento TEXT NOT NULL,
 ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 responsavel_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 motivo TEXT,
 dados_anteriores JSONB,
 dados_novos JSONB,
 referencia_tipo TEXT,
 referencia_id UUID,
 operation_id UUID UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE confere.auditoria (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 ator_id UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 acao TEXT NOT NULL,
 entidade TEXT NOT NULL,
 entidade_id UUID,
 ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 device_id TEXT,
 session_ref TEXT,
 correlation_id UUID,
 detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE confere.localizacoes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 interno_id UUID NOT NULL REFERENCES confere.internos(id) ON DELETE RESTRICT,
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 cela_id UUID NOT NULL,
 inicio_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 fim_em TIMESTAMPTZ,
 motivo TEXT,
 responsavel_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 evento_origem_id UUID REFERENCES confere.historico_eventos(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT fk_localizacoes_cela_area FOREIGN KEY (cela_id, area_id) REFERENCES confere.celas(id, area_id) ON DELETE RESTRICT,
 CHECK (fim_em IS NULL OR fim_em >= inicio_em)
);

CREATE UNIQUE INDEX uq_localizacoes_atual_interno
 ON confere.localizacoes(interno_id) WHERE fim_em IS NULL;
CREATE INDEX ix_localizacoes_area_cela_fim
 ON confere.localizacoes(area_id, cela_id, fim_em);
CREATE INDEX ix_localizacoes_interno_periodo
 ON confere.localizacoes(interno_id, inicio_em DESC);

CREATE TABLE confere.importacoes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 arquivo_nome TEXT NOT NULL,
 arquivo_hash_sha256 CHAR(64) NOT NULL,
 arquivo_tamanho_bytes BIGINT,
 status TEXT NOT NULL CHECK (status IN ('RECEBIDA','EXTRAINDO','AGUARDANDO_REVISAO','APLICANDO','APLICADA','CANCELADA','FALHA')),
 enviado_por UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 aplicado_em TIMESTAMPTZ,
 versao_extrator TEXT,
 resumo JSONB NOT NULL DEFAULT '{}'::jsonb,
 CHECK (arquivo_hash_sha256 ~ '^[0-9a-fA-F]{64}$'),
 CHECK (arquivo_tamanho_bytes IS NULL OR arquivo_tamanho_bytes > 0)
);
CREATE INDEX ix_importacoes_area_criado ON confere.importacoes(area_id, criado_em DESC);

CREATE TABLE confere.importacao_linhas (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 importacao_id UUID NOT NULL REFERENCES confere.importacoes(id) ON DELETE RESTRICT,
 pagina INTEGER,
 ordem_linha INTEGER,
 cela_codigo_extraido TEXT,
 nome_extraido TEXT,
 data_entrada DATE,
 procedencia TEXT,
 setor_trabalho TEXT,
 status_linha TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status_linha IN ('PENDENTE','INCLUSAO','CORRESPONDENCIA','ALTERACAO','MUDANCA_CELA','POSSIVEL_HOMONIMO','POSSIVEL_AUSENCIA','DIVERGENCIA','INVALIDA','APROVADA','REJEITADA')),
 interno_sugerido_id UUID REFERENCES confere.internos(id) ON DELETE RESTRICT,
 decisao TEXT CHECK (decisao IS NULL OR decisao IN ('INCLUIR','ATUALIZAR','MOVER','EXCLUIR','IGNORAR','VINCULAR')),
 decidido_por UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 decidido_em TIMESTAMPTZ,
 motivo_decisao TEXT,
 dados_brutos JSONB NOT NULL DEFAULT '{}'::jsonb,
 CHECK (pagina IS NULL OR pagina > 0),
 CHECK (ordem_linha IS NULL OR ordem_linha > 0)
);
CREATE INDEX ix_importacao_linhas_lote_status
 ON confere.importacao_linhas(importacao_id, status_linha);

CREATE TABLE confere.movimentacoes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 interno_id UUID NOT NULL REFERENCES confere.internos(id) ON DELETE RESTRICT,
 tipo TEXT NOT NULL CHECK (tipo IN ('MEDICO','ODONTOLOGICO','AUTORIZACAO','LICENCA_JUDICIAL_7_DIAS','TRABALHO','EVASAO','TRANSFERENCIA','OUTRA')),
 descricao TEXT,
 inicio_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 fim_em TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','ENCERRADA','CANCELADA')),
 area_origem_id UUID REFERENCES confere.areas(id) ON DELETE RESTRICT,
 area_destino_id UUID REFERENCES confere.areas(id) ON DELETE RESTRICT,
 responsavel_abertura_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 responsavel_encerramento_id UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 motivo TEXT,
 observacao_encerramento TEXT,
 operation_id UUID UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (fim_em IS NULL OR fim_em >= inicio_em),
 CHECK ((status = 'ABERTA' AND fim_em IS NULL) OR (status <> 'ABERTA' AND fim_em IS NOT NULL))
);
CREATE INDEX ix_movimentacoes_interno_status ON confere.movimentacoes(interno_id, status);
CREATE INDEX ix_movimentacoes_origem_inicio ON confere.movimentacoes(area_origem_id, inicio_em DESC);

CREATE TABLE confere.transferencias (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 interno_id UUID NOT NULL REFERENCES confere.internos(id) ON DELETE RESTRICT,
 localizacao_origem_id UUID NOT NULL REFERENCES confere.localizacoes(id) ON DELETE RESTRICT,
 area_origem_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 cela_origem_id UUID NOT NULL REFERENCES confere.celas(id) ON DELETE RESTRICT,
 area_destino_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 cela_destino_id UUID NOT NULL REFERENCES confere.celas(id) ON DELETE RESTRICT,
 solicitante_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 motivo TEXT NOT NULL,
 criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ACEITA','RECUSADA','CANCELADA')),
 operation_id UUID NOT NULL UNIQUE,
 CHECK (area_origem_id <> area_destino_id OR cela_origem_id <> cela_destino_id)
);
CREATE INDEX ix_transferencias_status_criada ON confere.transferencias(status, criada_em DESC);

CREATE TABLE confere.transferencias_aprovacoes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 transferencia_id UUID NOT NULL REFERENCES confere.transferencias(id) ON DELETE RESTRICT,
 decisao TEXT NOT NULL CHECK (decisao IN ('ACEITA','RECUSADA')),
 usuario_destino_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 decidido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 observacao TEXT
);

CREATE TABLE confere.conferencias (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 area_id UUID NOT NULL REFERENCES confere.areas(id) ON DELETE RESTRICT,
 modalidade TEXT NOT NULL CHECK (modalidade IN ('POR_CELA','GERAL')),
 status TEXT NOT NULL DEFAULT 'EM_ANDAMENTO' CHECK (status IN ('EM_ANDAMENTO','FINALIZADA','CANCELADA')),
 iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 finalizada_em TIMESTAMPTZ,
 responsavel_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 observacao TEXT,
 CHECK (finalizada_em IS NULL OR finalizada_em >= iniciada_em),
 CHECK ((status = 'FINALIZADA' AND finalizada_em IS NOT NULL) OR (status <> 'FINALIZADA' AND finalizada_em IS NULL))
);

CREATE TABLE confere.conferencia_itens (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 conferencia_id UUID NOT NULL REFERENCES confere.conferencias(id) ON DELETE RESTRICT,
 interno_id UUID NOT NULL REFERENCES confere.internos(id) ON DELETE RESTRICT,
 nome_snapshot TEXT NOT NULL,
 area_snapshot TEXT NOT NULL,
 cela_snapshot TEXT NOT NULL,
 localizacao_id_snapshot UUID,
 resultado TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (resultado IN ('PENDENTE','CONFERIDO','NAO_LOCALIZADO','OUTRA_SITUACAO')),
 outra_situacao TEXT,
 marcado_por UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 marcado_em TIMESTAMPTZ,
 UNIQUE (conferencia_id, interno_id),
 CHECK ((resultado = 'OUTRA_SITUACAO' AND length(trim(coalesce(outra_situacao,''))) > 0) OR (resultado <> 'OUTRA_SITUACAO' AND outra_situacao IS NULL))
);
CREATE INDEX ix_conferencia_itens_conferencia_resultado
 ON confere.conferencia_itens(conferencia_id, resultado);

CREATE TABLE confere.plantoes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 inicio_em TIMESTAMPTZ NOT NULL,
 fim_em TIMESTAMPTZ NOT NULL,
 identificacao_ciclo TEXT,
 status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','FECHADO')),
 fechado_em TIMESTAMPTZ,
 responsavel_fechamento_id UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (fim_em > inicio_em),
 CHECK ((status = 'FECHADO' AND fechado_em IS NOT NULL) OR (status = 'ABERTO' AND fechado_em IS NULL)),
 UNIQUE (inicio_em, fim_em)
);

CREATE TABLE confere.senhas_diarias (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 usuario_id UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 conta_codigo TEXT CHECK (conta_codigo IS NULL OR conta_codigo IN ('A','B','C','D','VIRTUAL')),
 senha_hash TEXT NOT NULL,
 valid_from TIMESTAMPTZ NOT NULL,
 valid_until TIMESTAMPTZ NOT NULL,
 gerada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 gerada_por UUID REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 ativa BOOLEAN NOT NULL DEFAULT TRUE,
 CHECK (valid_until > valid_from),
 CHECK (usuario_id IS NOT NULL OR conta_codigo IS NOT NULL)
);
CREATE INDEX ix_senhas_diarias_usuario_validade
 ON confere.senhas_diarias(usuario_id, valid_from, valid_until);
CREATE INDEX ix_senhas_diarias_conta_validade
 ON confere.senhas_diarias(conta_codigo, valid_from, valid_until);

CREATE TABLE confere.plantao_resumos (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 plantao_id UUID NOT NULL REFERENCES confere.plantoes(id) ON DELETE RESTRICT,
 area_id UUID REFERENCES confere.areas(id) ON DELETE RESTRICT,
 resumo JSONB NOT NULL,
 gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 versao INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
 hash_conteudo CHAR(64),
 UNIQUE (plantao_id, area_id, versao)
);

CREATE TABLE confere.operacoes_sincronizadas (
 operation_id UUID PRIMARY KEY,
 device_id TEXT NOT NULL,
 usuario_id UUID NOT NULL REFERENCES confere.usuarios(id) ON DELETE RESTRICT,
 tipo_operacao TEXT NOT NULL,
 payload_hash CHAR(64) NOT NULL,
 recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
 ocorrido_local_em TIMESTAMPTZ,
 status TEXT NOT NULL CHECK (status IN ('PROCESSANDO','CONCLUIDA','REJEITADA')),
 resultado JSONB
);

CREATE INDEX ix_historico_eventos_interno_data
 ON confere.historico_eventos(interno_id, ocorrido_em DESC);
CREATE INDEX ix_historico_eventos_area_data
 ON confere.historico_eventos(area_id, ocorrido_em DESC);
CREATE INDEX ix_auditoria_entidade_data
 ON confere.auditoria(entidade, entidade_id, ocorrido_em DESC);
CREATE INDEX ix_internos_nome ON confere.internos(lower(nome_completo));

-- Observações deliberadas para esta primeira versão:
-- 1. Não inserir usuários, senhas ou dados operacionais nesta migration.
-- 2. Não criar triggers/funções nesta etapa: a ferramenta de validação
--    divide o SQL por ponto e vírgula. Proteções append-only e snapshot
--    imutável serão implementadas em migration própria e na API.
-- 3. A validação de PDF completo e as transações de importação/transferência
--    são regras de serviço e precisam de testes de integração.
