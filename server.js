const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

// Clientes conectados
const clientes = new Map();

// Registros enviados pelo GUICHÊ
// permanecem aqui até a MESA confirmar
const pendentes = new Map();

function enviar(ws, dados) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(dados)
    );
  }
}

// Envia todos os atendimentos ainda pendentes
// para uma MESA que acabou de conectar
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

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();

  clientes.set(id, {
    ws,
    role: "unknown"
  });

  enviar(ws, {
    type: "connected",
    id,
    version: "2.3.0"
  });

  ws.on("message", (raw) => {
    let mensagem;

    try {
      mensagem = JSON.parse(
        raw.toString()
      );
    } catch {
      enviar(ws, {
        type: "error",
        message: "Mensagem inválida."
      });

      return;
    }

    const cliente = clientes.get(id);

    if (!cliente) {
      return;
    }

    // =====================================================
    // REGISTRO DO TIPO DE CLIENTE
    // =====================================================

    if (mensagem.type === "register") {
      cliente.role =
        mensagem.role === "receiver"
          ? "receiver"
          : "sender";

      enviar(ws, {
        type: "registered",
        role: cliente.role
      });

      // Se for a MESA, envia tudo que estava pendente
      // mesmo que ela tenha ficado desconectada
      if (cliente.role === "receiver") {
        enviarPendentesParaMesa(ws);
      }

      return;
    }

    // =====================================================
    // NOVO ATENDIMENTO
    // =====================================================

    if (mensagem.type === "send_record") {
      const recordId =
        mensagem.recordId ||
        crypto.randomUUID();

      // Evita duplicação caso o GUICHÊ tente
      // reenviar o mesmo atendimento
      if (pendentes.has(recordId)) {
        const existente =
          pendentes.get(recordId);

        // Atualiza o proprietário da conexão
        existente.ownerId = id;
      } else {
        pendentes.set(recordId, {
          recordId,
          record: mensagem.record || {},
          sentAt: new Date().toISOString(),
          ownerId: id
        });
      }

      const item =
        pendentes.get(recordId);

      const atendimento = {
        type: "new_record",
        recordId: item.recordId,
        record: item.record,
        sentAt: item.sentAt
      };

      // Envia para todas as MESAS conectadas
      for (
        const clienteAtual
        of clientes.values()
      ) {
        if (
          clienteAtual.role === "receiver"
        ) {
          enviar(
            clienteAtual.ws,
            atendimento
          );
        }
      }

      return;
    }

    // =====================================================
    // CONFIRMAÇÃO DE RECEBIMENTO PELA MESA
    // =====================================================

    if (
      mensagem.type ===
      "confirm_received"
    ) {
      const recordId =
        mensagem.recordId;

      if (!recordId) {
        return;
      }

      const item =
        pendentes.get(recordId);

      // Já foi confirmado
      if (!item) {
        return;
      }

      const receivedAt =
        new Date().toISOString();

      const confirmacao = {
        type: "record_received",
        recordId,
        receivedAt
      };

      // Avisa o GUICHÊ que a MESA recebeu
      const sender =
        clientes.get(item.ownerId);

      enviar(
        sender?.ws,
        confirmacao
      );

      // Avisa também outras MESAS conectadas
      // para manter tudo sincronizado
      for (
        const clienteAtual
        of clientes.values()
      ) {
        if (
          clienteAtual.role === "receiver"
        ) {
          enviar(
            clienteAtual.ws,
            confirmacao
          );
        }
      }

      // Agora o atendimento deixa de ser pendente
      pendentes.delete(recordId);

      return;
    }
  });

  // =====================================================
  // CLIENTE DESCONECTOU
  // =====================================================

  ws.on("close", () => {
    clientes.delete(id);
  });

  ws.on("error", () => {
    clientes.delete(id);
  });
});

// =======================================================
// TESTE DO SERVIDOR
// =======================================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "2.3.0",
    clients: clientes.size,
    pendingRecords: pendentes.size
  });
});

// =======================================================
// INICIALIZAÇÃO
// =======================================================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Sistema de Atendimento V2.3 iniciado na porta " +
      PORT
    );
  }
);
