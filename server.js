const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();

  clients.set(id, {
    ws: ws,
    role: "unknown"
  });

  ws.send(JSON.stringify({
    type: "connected",
    id: id
  }));

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    const client = clients.get(id);

    if (message.type === "register") {
      client.role =
        message.role === "receiver"
          ? "receiver"
          : "sender";

      ws.send(JSON.stringify({
        type: "registered",
        role: client.role
      }));

      return;
    }

    if (message.type === "send_record") {
      const data = {
        type: "new_record",
        record: message.record,
        sentAt: new Date().toISOString()
      };

      for (const item of clients.values()) {
        if (
          item.role === "receiver" &&
          item.ws.readyState === WebSocket.OPEN
        ) {
          item.ws.send(JSON.stringify(data));
        }
      }
    }
  });

  ws.on("close", () => {
    clients.delete(id);
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor iniciado na porta " + PORT);
});
