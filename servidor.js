const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);

const VERSAO = "2.9.0";

app.use(express.static(path.join(__dirname, "public")));

const wss = new WebSocket.Server({ server });

/* =========================================================
   ARMAZENAMENTO EM MEMÓRIA
========================================================= */

const clientes = new Map();
const pendentes = new Map();
const recusasPendentes = new Map();

/*
clientes:
  WebSocket -> {
    ws,
    role,
    clientId,
    ownerId
  }

pendentes:
  recordId -> {
    recordId,
    record,
    ownerId,
    createdAt,
    updatedAt
  }

recusasPendentes:
  recordId -> {
    recordId,
    record,
    ownerId,
    reason,
    refusedAt
  }
*/

/* =========================================================
   FUNÇÕES AUXILIARES
========================================================= */

function agoraISO() {
  return new Date().toISOString();
}

function criarId() {
  return crypto.randomUUID();
}

function enviar(ws, dados) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify(dados));
    return true;
  } catch (erro) {
    console.error("Erro ao enviar WebSocket:", erro);
    return false;
  }
}

function responderErro(ws, tipo, mensagem, recordId) {
  const resposta = {
    type: tipo,
    ok: false,
    message: mensagem
  };

  if (recordId) {
    resposta.recordId = recordId;
  }

  enviar(ws, resposta);
}

function clienteAutorizado(ws, role) {
  const cliente = clientes.get(ws);

  return Boolean(
    cliente &&
    cliente.role === role &&
    ws.readyState === WebSocket.OPEN
  );
}

function encontrarClientePorId(clientId) {
  if (!clientId) {
    return null;
  }

  for (const cliente of clientes.values()) {
    if (
      cliente.clientId === clientId &&
      cliente.ws.readyState === WebSocket.OPEN
    ) {
      return cliente;
    }
  }

  return null;
}

function transmitirParaRole(role, dados, ignorarWs = null) {
  let enviados = 0;

  for (const cliente of clientes.values()) {
    if (
      cliente.role === role &&
      cliente.ws !== ignorarWs &&
      cliente.ws.readyState === WebSocket.OPEN
    ) {
      if (enviar(cliente.ws, dados)) {
        enviados++;
      }
    }
  }

  return enviados;
}

function normalizarRegistro(registro) {
  if (
    registro &&
    typeof registro === "object" &&
    !Array.isArray(registro)
  ) {
    return { ...registro };
  }

  return {};
}

/* =========================================================
   ENVIO DE ATENDIMENTO PARA A MESA
========================================================= */

function transmitirNovoAtendimento(pendente, wsEspecifico = null) {
  if (!pendente) {
    return;
  }

  const mensagem = {
    type: "new_record",
    recordId: pendente.recordId,
    record: pendente.record,
    createdAt: pendente.createdAt,
    updatedAt: pendente.updatedAt,
    sentAt: pendente.createdAt,
    reenvio: Boolean(
      pendente.record &&
      pendente.record.reenvio
    )
  };

  if (wsEspecifico) {
    enviar(wsEspecifico, mensagem);
    return;
  }

  transmitirParaRole("receiver", mensagem);
}

function enviarPendentesParaMesa(ws) {
  for (const pendente of pendentes.values()) {
    transmitirNovoAtendimento(pendente, ws);
  }
}

/* =========================================================
   ENVIO DE RECUSA PARA O GUICHÊ
========================================================= */

function enviarRecusaAoGuiche(recusa, wsEspecifico = null) {
  if (!recusa || !recusa.ownerId) {
    return false;
  }

  let destino = wsEspecifico;

  if (!destino) {
    const cliente = encontrarClientePorId(recusa.ownerId);

    if (!cliente) {
      return false;
    }

    destino = cliente.ws;
  }

  const clienteDestino = clientes.get(destino);

  if (
    !clienteDestino ||
    clienteDestino.role !== "sender" ||
    clienteDestino.clientId !== recusa.ownerId
  ) {
    return false;
  }

  return enviar(destino, {
    type: "record_refused",
    recordId: recusa.recordId,
    record: recusa.record,
    reason: recusa.reason,
    refusedAt: recusa.refusedAt,
    ownerId: recusa.ownerId,
    status: "recusado"
  });
}

function enviarRecusasPendentesParaGuiche(ws, clientId) {
  if (!clientId) {
    return;
  }

  for (const recusa of recusasPendentes.values()) {
    if (recusa.ownerId === clientId) {
      enviarRecusaAoGuiche(recusa, ws);
    }
  }
}

/* =========================================================
   REGISTRO DO CLIENTE
========================================================= */

function registrarCliente(ws, dados) {
  const cliente = clientes.get(ws);

  if (!cliente) {
    return;
  }

  const role =
    dados.role === "receiver"
      ? "receiver"
      : dados.role === "sender"
        ? "sender"
        : null;

  if (!role) {
    responderErro(
      ws,
      "error",
      "Papel do cliente inválido."
    );
    return;
  }

  cliente.role = role;

  cliente.clientId =
    typeof dados.clientId === "string" &&
    dados.clientId.trim()
      ? dados.clientId.trim()
      : null;

  cliente.ownerId =
    typeof dados.ownerId === "string" &&
    dados.ownerId.trim()
      ? dados.ownerId.trim()
      : cliente.clientId;

  console.log(
    "Cliente registrado:",
    role,
    cliente.clientId || "(sem clientId)"
  );

  enviar(ws, {
    type: "registered",
    role,
    clientId: cliente.clientId,
    version: VERSAO
  });

  if (role === "receiver") {
    enviarPendentesParaMesa(ws);
  }

  if (role === "sender") {
    enviarRecusasPendentesParaGuiche(
      ws,
      cliente.clientId
    );
  }
}

/* =========================================================
   NOVO ATENDIMENTO / REENVIO DO GUICHÊ
========================================================= */

function receberNovoAtendimento(ws, dados) {
  if (!clienteAutorizado(ws, "sender")) {
    responderErro(
      ws,
      "send_result",
      "Somente o GUICHÊ pode enviar atendimentos.",
      dados.recordId
    );
    return;
  }

  const cliente = clientes.get(ws);

  const recordId = String(dados.recordId || "").trim();

  if (!recordId) {
    responderErro(
      ws,
      "send_result",
      "recordId não informado."
    );
    return;
  }

  const registroRecebido = normalizarRegistro(dados.record);
  const anterior = pendentes.get(recordId);
  const recusaAnterior = recusasPendentes.get(recordId);

  /*
   * O proprietário é identificado pelo clientId persistente
   * do GUICHÊ. Não usamos o identificador temporário do socket.
   */
  const ownerRecebido =
    typeof dados.ownerId === "string" && dados.ownerId.trim()
      ? dados.ownerId.trim()
      : cliente.clientId;

  const ownerId =
    anterior?.ownerId ||
    recusaAnterior?.ownerId ||
    ownerRecebido ||
    cliente.clientId ||
    null;

  if (
    ownerId &&
    cliente.clientId &&
    ownerId !== cliente.clientId
  ) {
    responderErro(
      ws,
      "send_result",
      "Este GUICHÊ não corresponde ao proprietário do atendimento.",
      recordId
    );
    return;
  }

  const agora = agoraISO();

  /*
   * Mantém os dados anteriores quando o reenvio não
   * contém algum campo. Os dados novos prevalecem.
   */
  const registro = {
    ...(anterior?.record || recusaAnterior?.record || {}),
    ...registroRecebido,
    recordId
  };

  /*
   * Um reenvio pode chegar com reenvio=true,
   * reenviadoEm ou status aguardando_mesa.
   */
  const ehReenvio = Boolean(
    registro.reenvio === true ||
    registro.reenviadoEm ||
    registro.status === "aguardando_mesa" ||
    recusaAnterior
  );

  if (ehReenvio) {
    registro.reenvio = true;
    registro.reenviadoEm =
      registro.reenviadoEm || agora;
    registro.status = "aguardando_mesa";
    registro.motivoRecusa = "";
    registro.recusadoEm = null;
  } else {
    registro.status =
      registro.status || "aguardando_mesa";
  }

  /*
   * Ao reenviar, cancela a recusa anterior do mesmo
   * atendimento para que ele volte à fila da MESA.
   */
  recusasPendentes.delete(recordId);

  const pendente = {
    recordId,
    record: registro,
    ownerId,
    createdAt:
      anterior?.createdAt ||
      registro.createdAt ||
      agora,
    updatedAt: agora
  };

  pendentes.set(recordId, pendente);

  console.log(
    "Atendimento enviado:",
    recordId,
    "proprietário:",
    ownerId,
    "reenvio:",
    ehReenvio
  );

  transmitirNovoAtendimento(pendente);

  enviar(ws, {
    type: "send_result",
    ok: true,
    recordId,
    reenvio: ehReenvio
  });
}

/* =========================================================
   CONFIRMAÇÃO DE RECEBIMENTO PELA MESA
========================================================= */

function confirmarRecebimento(ws, dados) {
  if (!clienteAutorizado(ws, "receiver")) {
    responderErro(
      ws,
      "confirm_result",
      "Somente a MESA pode confirmar recebimentos.",
      dados.recordId
    );
    return;
  }

  const recordId = String(dados.recordId || "").trim();

  if (!recordId) {
    responderErro(
      ws,
      "confirm_result",
      "recordId não informado."
    );
    return;
  }

  const pendente = pendentes.get(recordId);

  /*
   * A MESA pode reenviar confirmações de registros
   * que já constam no histórico local. Isso é normal.
   */
  if (!pendente) {
    enviar(ws, {
      type: "confirm_result",
      ok: true,
      recordId,
      alreadyConfirmed: true
    });
    return;
  }

  const receivedAt =
    dados.receivedAt || agoraISO();

  const confirmacao = {
    type: "record_received",
    recordId,
    receivedAt
  };

  /*
   * Avisa o GUICHÊ proprietário, se estiver conectado.
   */
  const proprietario = encontrarClientePorId(
    pendente.ownerId
  );

  if (proprietario) {
    enviar(proprietario.ws, confirmacao);
  }

  /*
   * Avisa também as demais MESAS conectadas.
   */
  transmitirParaRole(
    "receiver",
    confirmacao
  );

  /*
   * A confirmação permite retirar o registro da fila.
   */
  pendentes.delete(recordId);

  enviar(ws, {
    type: "confirm_result",
    ok: true,
    recordId
  });

  console.log(
    "Atendimento recebido pela MESA:",
    recordId
  );
}

/* =========================================================
   RECUSA DE ATENDIMENTO PELA MESA
========================================================= */

function recusarAtendimento(ws, dados) {
  if (!clienteAutorizado(ws, "receiver")) {
    responderErro(
      ws,
      "refuse_result",
      "Somente a MESA pode recusar atendimentos.",
      dados.recordId
    );
    return;
  }

  const recordId = String(dados.recordId || "").trim();

  if (!recordId) {
    responderErro(
      ws,
      "refuse_result",
      "recordId não informado."
    );
    return;
  }

  const pendente = pendentes.get(recordId);

  /*
   * Se a recusa já existe, repetimos a entrega.
   * Isso permite recuperar mensagens após reconexões.
   */
  if (!pendente) {
    const recusaExistente =
      recusasPendentes.get(recordId);

    if (recusaExistente) {
      const entregue = enviarRecusaAoGuiche(
        recusaExistente
      );

      enviar(ws, {
        type: "refuse_result",
        ok: true,
        recordId,
        refusedAt: recusaExistente.refusedAt,
        deliveredToGuiche: entregue
      });

      return;
    }

    responderErro(
      ws,
      "refuse_result",
      "Atendimento não está mais pendente.",
      recordId
    );
    return;
  }

  const registro = {
    ...pendente.record,
    ...normalizarRegistro(dados.record),
    recordId
  };

  const motivo = String(
    dados.reason ??
    dados.motivoRecusa ??
    registro.motivoRecusa ??
    ""
  ).trim();

  if (!motivo) {
    responderErro(
      ws,
      "refuse_result",
      "Informe o motivo da recusa.",
      recordId
    );
    return;
  }

  const refusedAt =
    dados.refusedAt || agoraISO();

  registro.status = "recusado";
  registro.motivoRecusa = motivo;
  registro.recusadoEm = refusedAt;

  const recusa = {
    recordId,
    record: registro,
    ownerId: pendente.ownerId,
    reason: motivo,
    refusedAt
  };

  /*
   * A recusa permanece guardada até o GUICHÊ
   * proprietário confirmar o recebimento.
   */
  recusasPendentes.set(recordId, recusa);

  /*
   * Remove o atendimento da fila de pendentes da MESA.
   */
  pendentes.delete(recordId);

  const entregue = enviarRecusaAoGuiche(recusa);

  /*
   * Remove o atendimento das demais MESAS abertas.
   */
  transmitirParaRole(
    "receiver",
    {
      type: "record_removed",
      recordId,
      reason: motivo,
      refusedAt
    },
    ws
  );

  enviar(ws, {
    type: "refuse_result",
    ok: true,
    recordId,
    refusedAt,
    deliveredToGuiche: entregue
  });

  console.log(
    "Atendimento recusado:",
    recordId,
    "motivo:",
    motivo,
    "entregue ao GUICHÊ:",
    entregue
  );
}

/* =========================================================
   GUICHÊ CONFIRMA RECEBIMENTO DA RECUSA
========================================================= */

function confirmarRecebimentoRecusa(ws, dados) {
  if (!clienteAutorizado(ws, "sender")) {
    responderErro(
      ws,
      "confirm_refusal_result",
      "Somente o GUICHÊ pode confirmar a recusa.",
      dados.recordId
    );
    return;
  }

  const cliente = clientes.get(ws);
  const recordId = String(dados.recordId || "").trim();

  if (!recordId) {
    responderErro(
      ws,
      "confirm_refusal_result",
      "recordId não informado."
    );
    return;
  }

  const recusa = recusasPendentes.get(recordId);

  if (!recusa) {
    enviar(ws, {
      type: "confirm_refusal_result",
      ok: true,
      recordId,
      alreadyConfirmed: true
    });
    return;
  }

  /*
   * Só o GUICHÊ proprietário pode retirar a recusa
   * da fila de entrega.
   */
  if (
    !recusa.ownerId ||
    !cliente.clientId ||
    recusa.ownerId !== cliente.clientId
  ) {
    responderErro(
      ws,
      "confirm_refusal_result",
      "Este GUICHÊ não é o proprietário do atendimento.",
      recordId
    );
    return;
  }

  recusasPendentes.delete(recordId);

  enviar(ws, {
    type: "confirm_refusal_result",
    ok: true,
    recordId
  });

  console.log(
    "GUICHÊ confirmou o recebimento da recusa:",
    recordId
  );
}

/* =========================================================
   ATUALIZAÇÃO DE STATUS
========================================================= */

function atualizarStatusRegistro(ws, dados) {
  const cliente = clientes.get(ws);

  if (!cliente || cliente.role === "unknown") {
    return;
  }

  const recordId = String(dados.recordId || "").trim();
  const status = String(dados.status || "").trim();

  if (!recordId || !status) {
    return;
  }

  const pendente = pendentes.get(recordId);

  if (!pendente) {
    return;
  }

  /*
   * Somente o GUICHÊ proprietário ou uma MESA conectada
   * pode atualizar o status de um registro pendente.
   */
  if (
    cliente.role === "sender" &&
    cliente.clientId !== pendente.ownerId
  ) {
    return;
  }

  pendente.record = {
    ...pendente.record,
    status
  };

  pendente.updatedAt = agoraISO();

  console.log(
    "Status atualizado:",
    recordId,
    status
  );
}

/* =========================================================
   WEBSOCKET
========================================================= */

wss.on("connection", (ws) => {
  const cliente = {
    ws,
    role: "unknown",
    clientId: null,
    ownerId: null
  };

  clientes.set(ws, cliente);

  console.log("Novo cliente conectado.");

  enviar(ws, {
    type: "connected",
    version: VERSAO
  });

  ws.on("message", (raw) => {
    let dados;

    try {
      dados = JSON.parse(raw.toString());
    } catch (erro) {
      responderErro(
        ws,
        "error",
        "Mensagem inválida. Envie um JSON válido."
      );
      return;
    }

    if (
      !dados ||
      typeof dados !== "object" ||
      Array.isArray(dados)
    ) {
      responderErro(
        ws,
        "error",
        "Formato de mensagem inválido."
      );
      return;
    }

    try {
      switch (dados.type) {
        case "register":
          registrarCliente(ws, dados);
          return;

        case "ping":
          enviar(ws, {
            type: "pong",
            time: agoraISO()
          });
          return;

        case "pong":
          return;

        case "send_record":
          receberNovoAtendimento(ws, dados);
          return;

        case "confirm_received":
          confirmarRecebimento(ws, dados);
          return;

        case "refuse_record":
          recusarAtendimento(ws, dados);
          return;

        case "confirm_refusal_received":
          confirmarRecebimentoRecusa(ws, dados);
          return;

        case "record_status":
          atualizarStatusRegistro(ws, dados);
          return;

        default:
          responderErro(
            ws,
            "error",
            "Tipo de mensagem não reconhecido."
          );
      }
    } catch (erro) {
      console.error(
        "Erro ao processar mensagem:",
        erro
      );

      responderErro(
        ws,
        "error",
        "Erro interno ao processar a mensagem.",
        dados.recordId
      );
    }
  });

  ws.on("close", () => {
    clientes.delete(ws);
    console.log("Cliente desconectado.");
  });

  ws.on("error", (erro) => {
    console.error("Erro WebSocket:", erro);
  });
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSAO,
    clients: clientes.size,
    pendingRecords: pendentes.size,
    pendingRefusals: recusasPendentes.size,
    timestamp: agoraISO()
  });
});

/* =========================================================
   STATUS COMPLETO
========================================================= */

app.get("/status", (_req, res) => {
  const listaClientes = [];

  for (const cliente of clientes.values()) {
    listaClientes.push({
      role: cliente.role,
      clientId: cliente.clientId,
      ownerId: cliente.ownerId,
      conectado:
        cliente.ws.readyState === WebSocket.OPEN
    });
  }

  res.json({
    ok: true,
    version: VERSAO,
    clientes: listaClientes,

    pendentes: Array.from(
      pendentes.values()
    ).map((item) => ({
      recordId: item.recordId,
      ownerId: item.ownerId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      record: item.record
    })),

    recusasPendentes: Array.from(
      recusasPendentes.values()
    ).map((item) => ({
      recordId: item.recordId,
      ownerId: item.ownerId,
      reason: item.reason,
      refusedAt: item.refusedAt
    }))
  });
});

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Sistema Atendimento V${VERSAO} iniciado na porta ${PORT}`
  );
});

/* =========================================================
   ENCERRAMENTO
========================================================= */

function encerrarServidor(sinal) {
  console.log(
    `Sinal ${sinal} recebido. Encerrando servidor...`
  );

  for (const cliente of clientes.values()) {
    try {
      cliente.ws.close(1001, "Servidor encerrando");
    } catch (erro) {
      console.error(
        "Erro ao fechar conexão:",
        erro
      );
    }
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => encerrarServidor("SIGTERM"));
process.on("SIGINT", () => encerrarServidor("SIGINT"));
