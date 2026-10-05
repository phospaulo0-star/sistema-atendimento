const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const server = http.createServer(app);

const wss =
  new WebSocket.Server({ server });

const clients = new Map();

// Guarda qual Guichê enviou cada atendimento
const recordOwners = new Map();

wss.on("connection", (ws) => {

  const id =
    crypto.randomUUID();

  clients.set(id, {
    ws,
    role: "unknown"
  });

  ws.send(
    JSON.stringify({
      type: "connected",
      id
    })
  );

  ws.on("message", (raw) => {

    let msg;

    try {
      msg =
        JSON.parse(
          raw.toString()
        );
    } catch {
      return;
    }

    const client =
      clients.get(id);

    if (!client) {
      return;
    }

    // REGISTRO DO TIPO DE USUÁRIO
    if (msg.type === "register") {

      client.role =
        msg.role === "receiver"
          ? "receiver"
          : "sender";

      ws.send(
        JSON.stringify({
          type: "registered",
          role: client.role
        })
      );

      return;
    }

    // ENVIO DE ATENDIMENTO
    if (msg.type === "send_record") {

      const recordId =
        msg.recordId ||
        crypto.randomUUID();

      // Guarda quem enviou
      recordOwners.set(
        recordId,
        id
      );

      const payload = {
        type: "new_record",
        recordId,
        record: msg.record,
        sentAt:
          new Date().toISOString()
      };

      // Envia para todas as Mesas
      for (
        const c of clients.values()
      ) {

        if (
          c.role === "receiver" &&
          c.ws.readyState ===
            WebSocket.OPEN
        ) {

          c.ws.send(
            JSON.stringify(
              payload
            )
          );

        }

      }

      return;
    }

    // CONFIRMAÇÃO DA MESA
    if (
      msg.type ===
      "confirm_received"
    ) {

      const recordId =
        msg.recordId;

      const senderId =
        recordOwners.get(
          recordId
        );

      if (!senderId) {
        return;
      }

      const sender =
        clients.get(senderId);

      if (
        sender &&
        sender.ws.readyState ===
          WebSocket.OPEN
      ) {

        sender.ws.send(
          JSON.stringify({

            type:
              "record_received",

            recordId,

            receivedAt:
              new Date().toISOString()

          })
        );

      }

      // Atendimento já foi confirmado
      recordOwners.delete(
        recordId
      );

      return;
    }

  });

  ws.on("close", () => {

    // Remove atendimentos desse Guichê
    for (
      const [
        recordId,
        ownerId
      ] of recordOwners.entries()
    ) {

      if (ownerId === id) {
        recordOwners.delete(
          recordId
        );
      }

    }

    clients.delete(id);

  });

});

app.get(
  "/health",
  (_req, res) => {

    res.json({
      ok: true
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
      `Servidor iniciado na porta ${PORT}`
    );

  }
);
