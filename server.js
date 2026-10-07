const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const VERSION = "2.6.0";

// Clientes conectados
const clientes = new Map();

// Atendimentos aguardando a MESA receber
const pendentes = new Map();

// Recusas que ainda precisam chegar ao GUICHÊ
// Ficam armazenadas até o GUICHÊ confirmar o recebimento.
const recusasPendentes = new Map();

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function enviar(ws, dados) {
  if (!ws) return false;

  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify(dados));
    return true;
  } catch (erro) {
    console.error("Erro ao enviar WebSocket:", erro.message);
    return false;
  }
}

function transmitirParaRecebedores(dados, excluirWs = null) {
  for (const cliente of clientes.values()) {
    if (
      cliente.role === "receiver" &&
      cliente.ws !== excluirWs
    ) {
      enviar(cliente.ws, dados);
    }
  }
}

function enviarPendentesParaMesa(ws) {
  for (const item of pendentes.values()) {
    enviar(ws, {
      type: "new_record",
      recordId: item.recordId,
      record: item.record,
      sentAt: item.sentAt
    });
  }
}

function enviarRecusasParaGuiche(ws) {
  for (const item of recusasPendentes.values()) {
    enviar(ws, {
      type: "record_refused",
      recordId: item.recordId,
      record: item.record,
      refusedAt: item.refusedAt,
      reason: item.reason
    });
  }
}

// ======================================================
// PROCESSAMENTO DE ENVIO DO GUICHÊ
// ======================================================

function processarEnvioRegistro(cliente, mensagem) {
  const registro = {
    ...(mensagem.record || {})
  };

  const recordId =
    mensagem.recordId ||
    registro.recordId ||
    crypto.randomUUID();

  registro.recordId = recordId;

  // ----------------------------------------------------
  // Se já existe, atualiza o registro.
  // Isso é importante para REENVIAR depois de uma recusa.
  // ----------------------------------------------------

  if (pendentes.has(recordId)) {
    const existente = pendentes.get(recordId);

    existente.record = registro;
    existente.ownerId = cliente.id;
    existente.sentAt = new Date().toISOString();

    pendentes.set(recordId, existente);
  } else {
    pendentes.set(recordId, {
      recordId,
      record: registro,
      sentAt: new Date().toISOString(),
      ownerId: cliente.id
    });
  }

  // ----------------------------------------------------
  // Se esse atendimento estava na fila de recusas,
  // significa que o GUICHÊ está reenviando.
  // Remove a recusa pendente do servidor.
  // ----------------------------------------------------

  recusasPendentes.delete(recordId);

  const item = pendentes.get(recordId);

  const atendimento = {
    type: "new_record",
    recordId: item.recordId,
    record: item.record,
    sentAt: item.sentAt
  };

  // ----------------------------------------------------
  // ENVIO IMEDIATO PARA TODAS AS MESAS CONECTADAS
  // ----------------------------------------------------

  transmitirParaRecebedores(atendimento);

  // Confirma ao próprio GUICHÊ que o servidor recebeu
  enviar(cliente.ws, {
    type: "send_result",
    recordId,
    ok: true,
    sentAt: item.sentAt
  });
}

// ======================================================
// PROCESSAMENTO DE RECEBIMENTO PELA MESA
// ======================================================

function processarConfirmacaoRecebimento(cliente, mensagem) {
  const recordId = mensagem.recordId;

  if (!recordId) {
    enviar(cliente.ws, {
      type: "error",
      message: "Confirmação sem recordId."
    });

    return;
  }

  const item = pendentes.get(recordId);

  // ----------------------------------------------------
  // Se não está mais em pendentes, pode ser uma
  // confirmação duplicada depois de uma reconexão.
  // ----------------------------------------------------

  if (!item) {
    enviar(cliente.ws, {
      type: "confirm_result",
      recordId,
      ok: false,
      alreadyConfirmed: true,
      message: "Atendimento já confirmado ou não encontrado."
    });

    return;
  }

  const receivedAt =
    mensagem.receivedAt ||
    new Date().toISOString();

  const confirmacao = {
    type: "record_received",
    recordId,
    receivedAt
  };

  // ----------------------------------------------------
  // AVISA O GUICHÊ
  // ----------------------------------------------------

  const sender = clientes.get(item.ownerId);

  if (sender) {
    enviar(sender.ws, confirmacao);
  }

  // ----------------------------------------------------
  // AVISA AS OUTRAS MESAS
  // ----------------------------------------------------

  transmitirParaRecebedores(
    confirmacao,
    cliente.ws
  );

  // ----------------------------------------------------
  // AGORA O ATENDIMENTO DEIXA DE SER PENDENTE
  // ----------------------------------------------------

  pendentes.delete(recordId);

  enviar(cliente.ws, {
    type: "confirm_result",
    recordId,
    ok: true,
    receivedAt
  });

  console.log(
    `[RECEBIDO] ${recordId}`
  );
}

// ======================================================
// PROCESSAMENTO DE RECUSA
// ======================================================

function processarRecusaMesa(cliente, mensagem) {
  const recordId = mensagem.recordId;

  if (!recordId) {
    enviar(cliente.ws, {
      type: "error",
      message: "Recusa sem recordId."
    });

    return;
  }

  const item = pendentes.get(recordId);

  // ----------------------------------------------------
  // Se não encontrou nos pendentes, pode ser uma recusa
  // duplicada. Não cria atendimento novo.
  // ----------------------------------------------------

  if (!item) {
    enviar(cliente.ws, {
      type: "refuse_result",
      recordId,
      ok: false,
      message: "Atendimento já processado ou não encontrado."
    });

    return;
  }

  const recusadoEm =
    mensagem.refusedAt ||
    new Date().toISOString();

  const motivo =
    String(
      mensagem.reason ||
      mensagem.motivoRecusa ||
      ""
    ).trim();

  const registroRecusado = {
    ...item.record,
    ...(mensagem.record || {}),
    recordId,

    status: "recusado",

    motivoRecusa: motivo,

    recusadoEm,

    // O atendimento volta para o GUICHÊ,
    // portanto não fica como recebido.
    recebidoEm: null
  };

  const recusa = {
    recordId,
    record: registroRecusado,
    refusedAt: recusadoEm,
    reason: motivo,
    ownerId: item.ownerId
  };

  // ----------------------------------------------------
  // MUITO IMPORTANTE:
  //
  // A recusa fica armazenada até o GUICHÊ receber.
  //
  // Assim, mesmo que o GUICHÊ esteja desligado,
  // a recusa NÃO será perdida.
  // ----------------------------------------------------

  recusasPendentes.set(
    recordId,
    recusa
  );

  // O atendimento deixa de estar aguardando a MESA.
  pendentes.delete(recordId);

  // ----------------------------------------------------
  // TENTA ENTREGAR IMEDIATAMENTE AO GUICHÊ
  // ----------------------------------------------------

  const sender = clientes.get(item.ownerId);

  let entregueAgora = false;

  if (sender) {
    entregueAgora = enviar(
      sender.ws,
      {
        type: "record_refused",
        recordId,
        record: registroRecusado,
        refusedAt: recusadoEm,
        reason: motivo
      }
    );
  }

  // ----------------------------------------------------
  // AVISA OUTRAS MESAS QUE O ATENDIMENTO FOI PROCESSADO
  // ----------------------------------------------------

  transmitirParaRecebedores(
    {
      type: "record_refused",
      recordId,
      refusedAt: recusadoEm,
      reason: motivo
    },
    cliente.ws
  );

  // ----------------------------------------------------
  // RESPONDE À MESA
  // ----------------------------------------------------

  enviar(cliente.ws, {
    type: "refuse_result",
    recordId,
    ok: true,
    deliveredToGuiche: entregueAgora,
    refusedAt: recusadoEm
  });

  console.log(
    `[RECUSADO] ${recordId} | motivo: ${motivo}`
  );
}

// ======================================================
// CONFIRMAÇÃO DE RECEBIMENTO DA RECUSA PELO GUICHÊ
// ======================================================

function processarConfirmacaoRecusa(cliente, mensagem) {
  const recordId = mensagem.recordId;

  if (!recordId) {
    enviar(cliente.ws, {
      type: "error",
      message: "Confirmação de recusa sem recordId."
    });

    return;
  }

  // Só remove do servidor depois que o GUICHÊ confirmar.
  const existe = recusasPendentes.has(recordId);

  if (existe) {
    recusasPendentes.delete(recordId);
  }

  enviar(cliente.ws, {
    type: "refusal_confirm_result",
    recordId,
    ok: true
  });

  console.log(
    `[RECUSA ENTREGUE AO GUICHÊ] ${recordId}`
  );
}

// ======================================================
// WEBSOCKET
// ======================================================

wss.on("connection", (ws) => {

  const clientId = crypto.randomUUID();

  const cliente = {
    id: clientId,
    ws,
    role: "unknown",
    conectadoEm: new Date().toISOString()
  };

  clientes.set(clientId, cliente);

  console.log(
    `[CONEXÃO] ${clientId}`
  );

  // ----------------------------------------------------
  // CONEXÃO INICIAL
  // ----------------------------------------------------

  enviar(ws, {
    type: "connected",
    id: clientId,
    version: VERSION,
    serverTime: new Date().toISOString()
  });

  // ----------------------------------------------------
  // RECEBIMENTO DE MENSAGENS
  // ----------------------------------------------------

  ws.on("message", (raw) => {

    let mensagem;

    try {
      mensagem = JSON.parse(
        raw.toString()
      );
    } catch (erro) {

      enviar(ws, {
        type: "error",
        message: "Mensagem inválida."
      });

      return;
    }

    const clienteAtual =
      clientes.get(clientId);

    if (!clienteAtual) {
      return;
    }

    // --------------------------------------------------
    // REGISTRO DO TIPO DE CLIENTE
    // --------------------------------------------------

    if (mensagem.type === "register") {

      clienteAtual.role =
        mensagem.role === "receiver"
          ? "receiver"
          : "sender";

      enviar(ws, {
        type: "registered",
        role: clienteAtual.role,
        serverTime: new Date().toISOString()
      });

      // ------------------------------------------------
      // MESA:
      // entrega imediatamente tudo que está pendente.
      // ------------------------------------------------

      if (
        clienteAtual.role === "receiver"
      ) {
        enviarPendentesParaMesa(ws);
      }

      // ------------------------------------------------
      // GUICHÊ:
      // entrega imediatamente recusas que estavam
      // aguardando porque o GUICHÊ estava offline.
      // ------------------------------------------------

      if (
        clienteAtual.role === "sender"
      ) {
        enviarRecusasParaGuiche(ws);
      }

      console.log(
        `[REGISTRO] ${clientId} => ${clienteAtual.role}`
      );

      return;
    }

    // --------------------------------------------------
    // ENVIO DE NOVO ATENDIMENTO
    // --------------------------------------------------

    if (
      mensagem.type === "send_record"
    ) {

      processarEnvioRegistro(
        clienteAtual,
        mensagem
      );

      return;
    }

    // --------------------------------------------------
    // MESA RECEBEU
    // --------------------------------------------------

    if (
      mensagem.type === "confirm_received"
    ) {

      processarConfirmacaoRecebimento(
        clienteAtual,
        mensagem
      );

      return;
    }

    // --------------------------------------------------
    // MESA RECUSOU
    // --------------------------------------------------

    if (
      mensagem.type === "refuse_record"
    ) {

      processarRecusaMesa(
        clienteAtual,
        mensagem
      );

      return;
    }

    // --------------------------------------------------
    // GUICHÊ CONFIRMA QUE RECEBEU A RECUSA
    // --------------------------------------------------

    if (
      mensagem.type === "confirm_refusal_received"
    ) {

      processarConfirmacaoRecusa(
        clienteAtual,
        mensagem
      );

      return;
    }

    // --------------------------------------------------
    // PING MANUAL DO NAVEGADOR
    // --------------------------------------------------

    if (
      mensagem.type === "ping"
    ) {

      enviar(ws, {
        type: "pong",
        serverTime: new Date().toISOString()
      });

      return;
    }
  });

  // ----------------------------------------------------
  // FECHAMENTO
  // ----------------------------------------------------

  ws.on("close", () => {

    console.log(
      `[DESCONECTADO] ${clientId}`
    );

    clientes.delete(clientId);
  });

  ws.on("error", (erro) => {

    console.error(
      `[WEBSOCKET ERRO] ${clientId}:`,
      erro.message
    );
  });
});

// ======================================================
// PING AUTOMÁTICO DO SERVIDOR
// ======================================================
//
// Ajuda a manter a conexão ativa e detectar aparelhos
// que perderam a conexão sem fechar corretamente.
// ======================================================

const INTERVALO_PING = 15000;

const intervaloPing = setInterval(() => {

  for (const cliente of clientes.values()) {

    if (
      cliente.ws.readyState === WebSocket.OPEN
    ) {

      enviar(
        cliente.ws,
        {
          type: "server_ping",
          serverTime: new Date().toISOString()
        }
      );
    }
  }

}, INTERVALO_PING);

// ======================================================
// STATUS / HEALTH
// ======================================================

app.get("/health", (_req, res) => {

  res.json({
    ok: true,
    version: VERSION,

    clients: clientes.size,

    senders: [...clientes.values()]
      .filter(c => c.role === "sender")
      .length,

    receivers: [...clientes.values()]
      .filter(c => c.role === "receiver")
      .length,

    pendingRecords: pendentes.size,

    pendingRefusals: recusasPendentes.size,

    uptime: process.uptime(),

    serverTime: new Date().toISOString()
  });
});

app.get("/status", (_req, res) => {

  res.json({
    ok: true,
    version: VERSION,

    clientes: [...clientes.values()]
      .map(cliente => ({
        id: cliente.id,
        role: cliente.role,
        conectadoEm: cliente.conectadoEm
      })),

    pendentes: [...pendentes.values()]
      .map(item => ({
        recordId: item.recordId,
        sentAt: item.sentAt,
        ownerId: item.ownerId
      })),

    recusasPendentes: [...recusasPendentes.values()]
      .map(item => ({
        recordId: item.recordId,
        refusedAt: item.refusedAt,
        reason: item.reason,
        ownerId: item.ownerId
      })),

    serverTime: new Date().toISOString()
  });
});

// ======================================================
// ENCERRAMENTO LIMPO
// ======================================================

process.on("SIGTERM", () => {

  clearInterval(intervaloPing);

  for (const cliente of clientes.values()) {
    try {
      cliente.ws.close();
    } catch (_) {}
  }

  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {

  clearInterval(intervaloPing);

  for (const cliente of clientes.values()) {
    try {
      cliente.ws.close();
    } catch (_) {}
  }

  server.close(() => {
    process.exit(0);
  });
});

// ======================================================
// INICIALIZAÇÃO
// ======================================================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Sistema de Atendimento V${VERSION} iniciado na porta ${PORT}`
    );

  }
);
