const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const clientes = new Map();
const proprietarios = new Map();

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

wss.on("connection", (ws) => {

  const id = crypto.randomUUID();

  clientes.set(id, {
    ws,
    role: "unknown"
  });

  enviar(ws, {
    type: "connected",
    id,
    version: "2.0.0"
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

    const cliente =
      clientes.get(id);

    if (!cliente) {
      return;
    }

    // Registro do tipo de conexão
    if (
      mensagem.type === "register"
    ) {

      cliente.role =
        mensagem.role === "receiver"
          ? "receiver"
          : "sender";

      enviar(ws, {
        type: "registered",
        role: cliente.role
      });

      return;
    }

    // Novo atendimento enviado pelo guichê
    if (
      mensagem.type === "send_record"
    ) {

      const recordId =
        mensagem.recordId ||
        crypto.randomUUID();

      proprietarios.set(
        recordId,
        id
      );

      const atendimento = {
        type: "new_record",
        recordId,
        record:
          mensagem.record || {},
        sentAt:
          new Date().toISOString()
      };

      for (
        const clienteAtual
        of clientes.values()
      ) {

        if (
          clienteAtual.role ===
          "receiver"
        ) {

          enviar(
            clienteAtual.ws,
            atendimento
          );

        }

      }

      return;
    }

    // Confirmação feita pela Mesa
    if (
      mensagem.type ===
      "confirm_received"
    ) {

      const recordId =
        mensagem.recordId;

      const idDoGuiche =
        proprietarios.get(
          recordId
        );

      if (!idDoGuiche) {
        return;
      }

      const confirmacao = {
        type: "record_received",

        recordId,

        receivedAt:
          new Date().toISOString()
      };

      // Confirma para o Guichê
      enviar(
        clientes.get(
          idDoGuiche
        )?.ws,
        confirmacao
      );

      // Confirma também para a Mesa
      enviar(
        ws,
        confirmacao
      );

      proprietarios.delete(
        recordId
      );
    }

  });

  ws.on("close", () => {

    for (
      const [
        recordId,
        ownerId
      ]
      of proprietarios.entries()
    ) {

      if (
        ownerId === id
      ) {

        proprietarios.delete(
          recordId
        );

      }

    }

    clientes.delete(id);

  });

});

// Teste de funcionamento
app.get(
  "/health",
  (_req, res) => {

    res.json({
      ok: true,
      version: "2.0.0",
      clients:
        clientes.size,
      pendingRecords:
        proprietarios.size
    });

  }
);

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Sistema de Atendimento V2 iniciado na porta " +
      PORT
    );

  }
);
