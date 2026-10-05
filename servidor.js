const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const clientes = new Map();

wss.on("connection", (ws) => {
  const cliente = {
    ws: ws,
    role: "receiver"
  };

  clientes.set(ws, cliente);

  console.log("Computador conectado");

  ws.on("message", (mensagem) => {
    try {
      const dados = JSON.parse(mensagem.toString());

      if (dados.type === "register") {
        cliente.role = dados.role;
        return;
      }

      if (dados.type === "send_record") {
        for (const outro of clientes.values()) {
          if (
            outro.role === "receiver" &&
            outro.ws.readyState === WebSocket.OPEN
          ) {
            outro.ws.send(
              JSON.stringify({
                type: "new_record",
                record: dados.record
              })
            );
          }
        }
      }
    } catch (erro) {
      console.error("Erro:", erro);
    }
  });

  ws.on("close", () => {
    clientes.delete(ws);
    console.log("Computador desconectado");
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor funcionando na porta ${PORT}`);
});
