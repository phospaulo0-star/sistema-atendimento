const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clientes = new Map();
const pendentes = new Map();

/* =========================================================
   FUNÇÕES AUXILIARES
========================================================= */

function enviar(ws, dados) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(dados));
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

/* =========================================================
   CONEXÃO WEBSOCKET
========================================================= */

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID();

  clientes.set(clientId, {
    ws,
    role: "unknown"
  });

  console.log("Novo cliente conectado:", clientId);

  enviar(ws, {
    type: "connected",
    id: clientId,
    version: "2.5.0"
  });

  /* =======================================================
     RECEBIMENTO DE MENSAGENS
  ======================================================= */

  ws.on("message", (raw) => {
    let mensagem;

    try {
      mensagem = JSON.parse(raw.toString());
    } catch (erro) {
      enviar(ws, {
        type: "error",
        message: "Mensagem inválida."
      });
      return;
    }

    const cliente = clientes.get(clientId);

    if (!cliente) {
      return;
    }

    /* =====================================================
       REGISTRO DO TIPO DE CLIENTE
    ===================================================== */

    if (mensagem.type === "register") {
      cliente.role =
        mensagem.role === "receiver"
          ? "receiver"
          : "sender";

      enviar(ws, {
        type: "registered",
        role: cliente.role
      });

      console.log(
        "Cliente registrado:",
        clientId,
        "como",
        cliente.role
      );

      /*
       * Se for a MESA, envia todos os atendimentos
       * que ainda estão aguardando recebimento.
       */
      if (cliente.role === "receiver") {
        enviarPendentesParaMesa(ws);
      }

      return;
    }

    /* =====================================================
       GUICHÊ ENVIA NOVO ATENDIMENTO
    ===================================================== */

    if (mensagem.type === "send_record") {
      const registro = {
        ...(mensagem.record || {})
      };

      const recordId =
        mensagem.recordId ||
        registro.recordId ||
        crypto.randomUUID();

      registro.recordId = recordId;

      /*
       * Se o registro já existe, atualizamos o dono.
       * Isso é importante quando o Guichê reconecta
       * e reenviará um atendimento que ainda aguarda a Mesa.
       */
      if (pendentes.has(recordId)) {
        const existente = pendentes.get(recordId);

        existente.record = registro;
        existente.ownerId = clientId;

        console.log(
          "Atendimento reenviado:",
          recordId
        );
      } else {
        pendentes.set(recordId, {
          recordId,
          record: registro,
          sentAt: new Date().toISOString(),
          ownerId: clientId
        });

        console.log(
          "Novo atendimento recebido:",
          recordId
        );
      }

      const item = pendentes.get(recordId);

      const atendimento = {
        type: "new_record",
        recordId: item.recordId,
        record: item.record,
        sentAt: item.sentAt
      };

      /*
       * Envia para todas as Mesas conectadas.
       */
      for (const clienteAtual of clientes.values()) {
        if (clienteAtual.role === "receiver") {
          enviar(clienteAtual.ws, atendimento);
        }
      }

      return;
    }

    /* =====================================================
       MESA CONFIRMA RECEBIMENTO
    ===================================================== */

    if (mensagem.type === "confirm_received") {
      const recordId = mensagem.recordId;

      if (!recordId) {
        enviar(ws, {
          type: "error",
          message: "Confirmação sem recordId."
        });
        return;
      }

      const item = pendentes.get(recordId);

      /*
       * Se não está mais pendente, pode ser porque o Guichê
       * reenviou ou porque o atendimento já foi confirmado.
       */
      if (!item) {
        enviar(ws, {
          type: "confirm_result",
          recordId,
          ok: false,
          message:
            "Atendimento já confirmado ou não encontrado."
        });

        return;
      }

      /*
       * Usa o horário enviado pela Mesa, se existir.
       * Caso contrário, cria o horário no servidor.
       */
      const receivedAt =
        mensagem.receivedAt ||
        new Date().toISOString();

      const confirmacao = {
        type: "record_received",
        recordId,
        receivedAt
      };

      /*
       * Envia confirmação para o Guichê que enviou
       * originalmente o atendimento.
       */
      const sender = clientes.get(item.ownerId);

      enviar(sender?.ws, confirmacao);

      /*
       * Informa outras Mesas conectadas.
       */
      for (const clienteAtual of clientes.values()) {
        if (
          clienteAtual.role === "receiver" &&
          clienteAtual.ws !== ws
        ) {
          enviar(clienteAtual.ws, confirmacao);
        }
      }

      /*
       * Remove da fila pendente.
       */
      pendentes.delete(recordId);

      enviar(ws, {
        type: "confirm_result",
        recordId,
        ok: true,
        receivedAt
      });

      console.log(
        "Atendimento recebido pela Mesa:",
        recordId
      );

      return;
    }

    /* =====================================================
       MESA RECUSA UM ATENDIMENTO
    ===================================================== */

    if (mensagem.type === "refuse_record") {
      const recordId = mensagem.recordId;

      if (!recordId) {
        enviar(ws, {
          type: "refuse_result",
          ok: false,
          message: "Recusa sem recordId."
        });

        return;
      }

      const item = pendentes.get(recordId);

      /*
       * Se o atendimento não estiver mais pendente,
       * ainda podemos encaminhar a recusa usando
       * os dados enviados pela Mesa.
       */
      const registro = {
        ...(mensagem.record || {})
      };

      registro.recordId =
        recordId;

      const refusedAt =
        mensagem.refusedAt ||
        new Date().toISOString();

      const reason =
        String(mensagem.reason || "").trim();

      /*
       * Informação completa que será devolvida ao Guichê.
       */
      const recusa = {
        type: "record_refused",
        recordId,
        record: registro,
        refusedAt,
        reason
      };

      /*
       * Se ainda existir um pendente, descobrimos
       * exatamente qual Guichê enviou o registro.
       */
      if (item) {
        const sender = clientes.get(item.ownerId);

        enviar(sender?.ws, recusa);

        /*
         * O atendimento foi recusado pela Mesa.
         * Portanto, não deve continuar aparecendo
         * como pendente para novas Mesas.
         */
        pendentes.delete(recordId);

        console.log(
          "Atendimento recusado:",
          recordId,
          "Motivo:",
          reason
        );
      } else {
        /*
         * Mesmo que o servidor tenha perdido o pendente,
         * encaminhamos a confirmação para o Guichê,
         * caso haja algum Guichê conectado que esteja
         * aguardando o resultado.
         */
        for (const clienteAtual of clientes.values()) {
          if (clienteAtual.role === "sender") {
            enviar(clienteAtual.ws, recusa);
          }
        }

        console.log(
          "Recusa recebida, mas atendimento não estava pendente:",
          recordId
        );
      }

      /*
       * Confirma para a Mesa que a recusa foi processada.
       */
      enviar(ws, {
        type: "refuse_result",
        recordId,
        ok: true,
        refusedAt
      });

      return;
    }

    /* =====================================================
       TIPO DESCONHECIDO
    ===================================================== */

    enviar(ws, {
      type: "error",
      message:
        "Tipo de mensagem não reconhecido: " +
        String(mensagem.type || "")
    });
  });

  /* =======================================================
     CLIENTE DESCONECTADO
  ======================================================= */

  ws.on("close", () => {
    console.log(
      "Cliente desconectado:",
      clientId
    );

    clientes.delete(clientId);
  });

  ws.on("error", (erro) => {
    console.error(
      "Erro WebSocket:",
      erro.message
    );
  });
});

/* =========================================================
   ROTA DE TESTE
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "2.5.0",
    clients: clientes.size,
    pendingRecords: pendentes.size,
    status: "online"
  });
});

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Sistema de Atendimento V2.5 iniciado na porta " +
      PORT
    );
  }
);
