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

    /*
     * REGISTRO DO TIPO DE USUÁRIO
     */

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

    /*
     * ENVIO DE UM ATENDIMENTO
     */

    if (msg.type === "send_record") {

      const recordId =
        crypto.randomUUID();

      const payload = {

        type: "new_record",

        recordId,

        record: msg.record,

        sentAt:
          new Date().toISOString()

      };

      /*
       * Guarda o ID do atendimento
       * junto ao remetente.
       */

      client.lastRecordId =
        recordId;

      /*
       * Envia para todas as Mesas
       * de Recebimento conectadas.
       */

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

    /*
     * CONFIRMAÇÃO DE RECEBIMENTO
     */

    if (
      msg.type ===
      "confirm_received"
    ) {

      const horarioRecebimento =
        new Date().toISOString();

      /*
       * Procuramos o atendimento
       * pelo ID informado pela Mesa.
       */

      const recordId =
        msg.recordId;

      /*
       * Enviamos a confirmação
       * para os Guichês conectados.
       */

      for (
        const c of clients.values()
      ) {

        if (
          c.role === "sender" &&
          c.ws.readyState ===
            WebSocket.OPEN
        ) {

          c.ws.send(
            JSON.stringify({

              type:
                "record_received",

              recordId,

              receivedAt:
                horarioRecebimento

            })
          );

        }

      }

      return;
    }

  });

  ws.on("close", () => {

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
