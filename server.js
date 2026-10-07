"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

/*
============================================================
SERVIDOR DO SISTEMA DE ATENDIMENTO
VERSÃO 2.7.0

FLUXO DA RECUSA

GUICHÊ
   |
   | send_record
   v
SERVIDOR
   |
   v
MESA
   |
   | refuse_record
   v
SERVIDOR
   |
   | record_refused
   v
MESMO GUICHÊ QUE ENVIOU
   |
   v
status = recusado
   |
   +-- EDITAR
   +-- REENVIAR
   +-- ARQUIVAR
============================================================
*/

app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sistema: "sistema-atendimento",
    versao: "2.7.0",
    data: new Date().toISOString()
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    versao: "2.7.0",
    clientes: clientes.size,
    pendentesMesa: pendentes.size,
    recusasPendentes: recusasPendentes.size,
    data: new Date().toISOString()
  });
});

/*
============================================================
ESTRUTURAS
============================================================
*/

/*
clientes

id => {
  ws,
  role,
  conectadoEm
}
*/
const clientes = new Map();

/*
pendentes

recordId => {
  recordId,
  record,
  ownerId,
  criadoEm,
  atualizadoEm
}
*/
const pendentes = new Map();

/*
recusasPendentes

recordId => {
  recordId,
  record,
  ownerId,
  reason,
  refusedAt
}
*/
const recusasPendentes = new Map();

let contadorClientes = 0;

/*
============================================================
UTILITÁRIOS
============================================================
*/

function gerarClientId() {
  contadorClientes++;

  return (
    "cliente-" +
    Date.now() +
    "-" +
    contadorClientes +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function agora() {
  return new Date().toISOString();
}

function enviar(ws, mensagem) {
  if (!ws) {
    return false;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify(mensagem));
    return true;
  } catch (erro) {
    console.error("Erro ao enviar WebSocket:", erro);
    return false;
  }
}

function enviarParaCliente(clientId, mensagem) {
  const cliente = clientes.get(clientId);

  if (!cliente) {
    return false;
  }

  return enviar(cliente.ws, mensagem);
}

function transmitirParaRole(role, mensagem, excluirId = null) {
  let quantidade = 0;

  for (const [id, cliente] of clientes.entries()) {
    if (id === excluirId) {
      continue;
    }

    if (cliente.role !== role) {
      continue;
    }

    if (enviar(cliente.ws, mensagem)) {
      quantidade++;
    }
  }

  return quantidade;
}

function registrarCliente(ws, role) {
  const clientId = gerarClientId();

  clientes.set(clientId, {
    ws,
    role,
    conectadoEm: agora()
  });

  ws.clientId = clientId;
  ws.role = role;

  return clientId;
}

function removerCliente(ws) {
  if (!ws || !ws.clientId) {
    return;
  }

  const id = ws.clientId;

  clientes.delete(id);

  console.log(
    `[CONEXÃO] Cliente removido: ${id}`
  );
}

/*
============================================================
REENVIAR PENDENTES PARA UMA MESA
============================================================
*/

function enviarPendentesParaMesa(ws) {
  for (const [recordId, item] of pendentes.entries()) {
    enviar(ws, {
      type: "new_record",
      recordId,
      record: item.record
    });
  }
}

/*
============================================================
REENVIAR RECUSAS PARA UM GUICHÊ
============================================================
*/

function enviarRecusasParaGuiche(clientId) {
  for (const [recordId, recusa] of recusasPendentes.entries()) {

    /*
     * Só entrega para o GUICHÊ que é dono daquele atendimento.
     */
    if (recusa.ownerId !== clientId) {
      continue;
    }

    enviarParaCliente(clientId, {
      type: "record_refused",
      recordId,
      record: recusa.record,
      reason: recusa.reason,
      refusedAt: recusa.refusedAt
    });
  }
}

/*
============================================================
 WEBSOCKET
============================================================
*/

wss.on("connection", (ws) => {

  console.log("[CONEXÃO] Novo cliente conectado.");

  ws.clientId = null;
  ws.role = null;

  enviar(ws, {
    type: "connected",
    serverTime: agora(),
    version: "2.7.0"
  });

  ws.on("message", (data) => {

    let mensagem;

    try {
      mensagem = JSON.parse(
        data.toString()
      );
    } catch (erro) {

      enviar(ws, {
        type: "error",
        message: "Mensagem inválida."
      });

      return;
    }

    tratarMensagem(ws, mensagem);
  });

  ws.on("close", () => {

    console.log(
      `[CONEXÃO] Cliente desconectado: ${ws.clientId || "não registrado"}`
    );

    removerCliente(ws);
  });

  ws.on("error", (erro) => {

    console.error(
      "[WEBSOCKET] Erro:",
      erro.message
    );

  });

});

/*
============================================================
TRATAMENTO DAS MENSAGENS
============================================================
*/

function tratarMensagem(ws, mensagem) {

  const tipo = mensagem.type;

  /*
  ----------------------------------------------------------
  REGISTER
  ----------------------------------------------------------
  */

  if (tipo === "register") {

    const role =
      mensagem.role === "receiver"
        ? "receiver"
        : "sender";

    /*
     * Se já estava registrado, atualiza a função.
     */
    if (ws.clientId) {

      const cliente =
        clientes.get(ws.clientId);

      if (cliente) {
        cliente.role = role;
      }

      ws.role = role;

    } else {

      registrarCliente(ws, role);

    }

    console.log(
      `[REGISTER] ${ws.clientId} => ${role}`
    );

    enviar(ws, {
      type: "registered",
      role,
      clientId: ws.clientId
    });

    /*
     * MESA recebe imediatamente tudo que está pendente.
     */
    if (role === "receiver") {

      enviarPendentesParaMesa(ws);

    }

    /*
     * GUICHÊ recebe imediatamente as recusas
     * que ficaram aguardando entrega.
     */
    if (role === "sender") {

      enviarRecusasParaGuiche(
        ws.clientId
      );

    }

    return;
  }

  /*
  ----------------------------------------------------------
  PING
  ----------------------------------------------------------
  */

  if (tipo === "ping") {

    enviar(ws, {
      type: "pong",
      at: agora()
    });

    return;
  }

  /*
  ----------------------------------------------------------
  PONG
  ----------------------------------------------------------
  */

  if (tipo === "pong") {
    return;
  }

  /*
  ----------------------------------------------------------
  SEND_RECORD
  GUICHÊ -> SERVIDOR -> MESA
  ----------------------------------------------------------
  */

  if (tipo === "send_record") {

    if (!ws.clientId) {

      enviar(ws, {
        type: "error",
        message: "Cliente ainda não registrado."
      });

      return;
    }

    if (ws.role !== "sender") {

      enviar(ws, {
        type: "error",
        message: "Somente o GUICHÊ pode enviar atendimentos."
      });

      return;
    }

    const recordId =
      mensagem.recordId ||
      mensagem.record?.recordId;

    if (!recordId) {

      enviar(ws, {
        type: "send_result",
        ok: false,
        message: "recordId não informado."
      });

      return;
    }

    const registro = {
      ...(mensagem.record || {}),
      recordId
    };

    /*
     * IMPORTANTE:
     * O dono passa a ser SEMPRE o GUICHÊ
     * que está fazendo este envio.
     *
     * Isso resolve o problema da recusa
     * voltar para o GUICHÊ errado ou não voltar.
     */
    const itemExistente =
      pendentes.get(recordId);

    const item = {

      recordId,

      record: registro,

      ownerId:
        ws.clientId,

      criadoEm:
        itemExistente?.criadoEm ||
        agora(),

      atualizadoEm:
        agora()

    };

    pendentes.set(
      recordId,
      item
    );

    /*
     * Se havia uma recusa antiga deste mesmo registro,
     * ela deixa de ser uma recusa pendente porque
     * o GUICHÊ acabou de reenviá-lo.
     */
    recusasPendentes.delete(
      recordId
    );

    /*
     * Envia para todas as MESA(s) conectadas.
     */
    const quantidadeMesa =
      transmitirParaRole(
        "receiver",
        {
          type: "new_record",
          recordId,
          record: registro
        }
      );

    console.log(
      `[ENVIO] ${recordId} | GUICHÊ ${ws.clientId} | MESA(s): ${quantidadeMesa}`
    );

    enviar(ws, {
      type: "send_result",
      ok: true,
      recordId,
      mesasConectadas:
        quantidadeMesa,
      ownerId:
        ws.clientId
    });

    return;
  }

  /*
  ----------------------------------------------------------
  CONFIRM_RECEIVED
  MESA -> SERVIDOR -> GUICHÊ
  ----------------------------------------------------------
  */

  if (tipo === "confirm_received") {

    if (!ws.clientId) {
      return;
    }

    if (ws.role !== "receiver") {
      return;
    }

    const recordId =
      mensagem.recordId;

    if (!recordId) {
      return;
    }

    const pending =
      pendentes.get(recordId);

    /*
     * Mesmo se o pendente já não estiver no Map,
     * podemos simplesmente ignorar.
     */
    if (!pending) {

      enviar(ws, {
        type: "confirm_result",
        ok: false,
        recordId,
        message:
          "Atendimento não está mais pendente no servidor."
      });

      return;
    }

    const receivedAt =
      mensagem.receivedAt ||
      agora();

    /*
     * Atualiza o registro antes de mandar
     * a confirmação ao GUICHÊ.
     */
    const registro = {
      ...pending.record,

      recordId,

      status:
        "recebido",

      recebidoEm:
        receivedAt

    };

    /*
     * Remove da fila da MESA.
     */
    pendentes.delete(
      recordId
    );

    /*
     * Se existia recusa antiga,
     * ela também deixa de ser pendente.
     */
    recusasPendentes.delete(
      recordId
    );

    /*
     * GUICHÊ dono.
     */
    if (pending.ownerId) {

      enviarParaCliente(
        pending.ownerId,
        {
          type: "record_received",
          recordId,
          record: registro,
          receivedAt
        }
      );

    }

    /*
     * Informa às outras MESA(s).
     */
    transmitirParaRole(
      "receiver",
      {
        type: "record_received",
        recordId,
        receivedAt
      },
      ws.clientId
    );

    enviar(ws, {
      type: "confirm_result",
      ok: true,
      recordId,
      receivedAt
    });

    console.log(
      `[RECEBIDO] ${recordId} | GUICHÊ: ${pending.ownerId}`
    );

    return;
  }

  /*
  ----------------------------------------------------------
  REFUSE_RECORD
  MESA -> SERVIDOR -> MESMO GUICHÊ
  ----------------------------------------------------------
  */

  if (tipo === "refuse_record") {

    if (!ws.clientId) {
      return;
    }

    if (ws.role !== "receiver") {

      enviar(ws, {
        type: "refuse_result",
        ok: false,
        recordId:
          mensagem.recordId,
        message:
          "Somente a MESA pode recusar atendimentos."
      });

      return;
    }

    const recordId =
      mensagem.recordId ||
      mensagem.record?.recordId;

    if (!recordId) {

      enviar(ws, {
        type: "refuse_result",
        ok: false,
        message:
          "recordId não informado."
      });

      return;
    }

    const pending =
      pendentes.get(recordId);

    if (!pending) {

      /*
       * Caso raro:
       * a MESA recusa depois que o servidor perdeu
       * o pendente.
       *
       * Mesmo assim, se o GUICHÊ estiver identificado
       * pela mensagem, tentamos entregar.
       */
      const registroMensagem = {
        ...(mensagem.record || {}),
        recordId
      };

      const reason =
        mensagem.reason ||
        registroMensagem.motivoRecusa ||
        "Motivo não informado.";

      const refusedAt =
        mensagem.refusedAt ||
        agora();

      enviar(ws, {
        type: "refuse_result",
        ok: false,
        recordId,
        message:
          "Atendimento não está mais pendente no servidor."
      });

      console.warn(
        `[RECUSA] ${recordId} não encontrado em pendentes.`
      );

      return;
    }

    const reason =
      String(
        mensagem.reason ||
        mensagem.record?.motivoRecusa ||
        ""
      ).trim() ||
      "Motivo não informado.";

    const refusedAt =
      mensagem.refusedAt ||
      agora();

    /*
     * Cria o registro recusado.
     *
     * IMPORTANTE:
     * status vira RECUSADO.
     */
    const registroRecusado = {

      ...pending.record,

      ...(mensagem.record || {}),

      recordId,

      status:
        "recusado",

      motivoRecusa:
        reason,

      recusadoEm:
        refusedAt,

      recebidoEm:
        null

    };

    /*
     * Guarda a recusa para entrega ao GUICHÊ.
     *
     * Isso é persistente durante a execução do servidor.
     * Se o GUICHÊ estiver offline neste momento,
     * receberá quando reconectar.
     */
    recusasPendentes.set(
      recordId,
      {

        recordId,

        record:
          registroRecusado,

        ownerId:
          pending.ownerId,

        reason,

        refusedAt

      }
    );

    /*
     * MUITO IMPORTANTE:
     *
     * A partir deste momento o atendimento
     * NÃO É MAIS PENDENTE DA MESA.
     */
    pendentes.delete(
      recordId
    );

    /*
     * Entrega imediatamente ao GUICHÊ dono.
     */
    let entregueAoGuiche = false;

    if (pending.ownerId) {

      entregueAoGuiche =
        enviarParaCliente(
          pending.ownerId,
          {
            type: "record_refused",

            recordId,

            record:
              registroRecusado,

            reason,

            refusedAt

          }
        );

    }

    /*
     * A própria MESA recebe confirmação da recusa.
     */
    enviar(ws, {
      type: "refuse_result",

      ok: true,

      recordId,

      refusedAt,

      deliveredToGuiche:
        entregueAoGuiche

    });

    /*
     * Outras MESAs são informadas para retirar
     * o atendimento da lista, caso estejam exibindo.
     */
    transmitirParaRole(
      "receiver",
      {
        type: "record_removed",
        recordId,
        reason: "recusado"
      },
      ws.clientId
    );

    console.log(
      `[RECUSADO] ${recordId} | GUICHÊ: ${pending.ownerId} | entregue: ${entregueAoGuiche}`
    );

    return;
  }

  /*
  ----------------------------------------------------------
  CONFIRM_REFUSAL_RECEIVED
  GUICHÊ -> SERVIDOR
  ----------------------------------------------------------
  */

  if (
    tipo ===
    "confirm_refusal_received"
  ) {

    if (!ws.clientId) {
      return;
    }

    const recordId =
      mensagem.recordId;

    if (!recordId) {
      return;
    }

    const recusa =
      recusasPendentes.get(
        recordId
      );

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
     * Só o GUICHÊ dono pode confirmar.
     */
    if (
      recusa.ownerId !==
      ws.clientId
    ) {

      enviar(ws, {
        type: "confirm_refusal_result",
        ok: false,
        recordId,
        message:
          "Este atendimento pertence a outro GUICHÊ."
      });

      return;
    }

    /*
     * Agora a recusa pode sair da memória
     * de pendências do servidor.
     */
    recusasPendentes.delete(
      recordId
    );

    enviar(ws, {
      type: "confirm_refusal_result",
      ok: true,
      recordId
    });

    console.log(
      `[RECUSA CONFIRMADA] ${recordId} | GUICHÊ: ${ws.clientId}`
    );

    return;
  }

  /*
  ----------------------------------------------------------
  UNKNOWN
  ----------------------------------------------------------
  */

  enviar(ws, {
    type: "error",
    message:
      "Tipo de mensagem não reconhecido: " +
      String(tipo || "")
  });
}

/*
============================================================
PING DO SERVIDOR
============================================================
*/

setInterval(() => {

  for (const [id, cliente] of clientes.entries()) {

    if (
      cliente.ws.readyState !==
      WebSocket.OPEN
    ) {

      removerCliente(
        cliente.ws
      );

      continue;
    }

    enviar(
      cliente.ws,
      {
        type: "server_ping",
        at: agora()
      }
    );

  }

}, 15000);

/*
============================================================
INICIALIZAÇÃO
============================================================
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Servidor do Sistema de Atendimento iniciado na porta ${PORT}`
    );

    console.log(
      "Versão: 2.7.0"
    );

  }
);
