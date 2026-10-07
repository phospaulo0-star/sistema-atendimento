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

const server =
  http.createServer(app);

const wss =
  new WebSocket.Server({
    server
  });

/* ============================================================
   CLIENTES CONECTADOS
============================================================ */

const clientes = new Map();

/*
 * Atendimentos aguardando a MESA.
 *
 * recordId -> {
 *   recordId,
 *   record,
 *   sentAt,
 *   ownerId
 * }
 */
const pendentes = new Map();

/*
 * Recusas aguardando confirmação do GUICHÊ.
 *
 * recordId -> {
 *   recordId,
 *   record,
 *   ownerId,
 *   reason,
 *   refusedAt
 * }
 */
const recusasPendentes = new Map();

/* ============================================================
   ENVIO
============================================================ */

function enviar(ws, dados) {

  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {

    try {

      ws.send(
        JSON.stringify(dados)
      );

      return true;

    } catch (erro) {

      console.error(
        "Erro ao enviar WebSocket:",
        erro
      );

      return false;
    }
  }

  return false;
}

/* ============================================================
   ENVIAR PENDENTES PARA MESA
============================================================ */

function enviarPendentesParaMesa(ws) {

  for (
    const item of pendentes.values()
  ) {

    enviar(
      ws,
      {
        type: "new_record",

        recordId:
          item.recordId,

        record:
          item.record,

        sentAt:
          item.sentAt
      }
    );
  }
}

/* ============================================================
   ENVIAR RECUSAS PARA GUICHÊ
============================================================ */

function enviarRecusasParaGuiche(
  ws,
  clientId
) {

  for (
    const item of recusasPendentes.values()
  ) {

    /*
     * Só entrega ao GUICHÊ que originalmente
     * criou o atendimento.
     */
    if (
      item.ownerId === clientId
    ) {

      enviar(
        ws,
        {
          type: "record_refused",

          recordId:
            item.recordId,

          record:
            item.record,

          reason:
            item.reason,

          refusedAt:
            item.refusedAt
        }
      );

    }

  }
}

/* ============================================================
   CONEXÃO
============================================================ */

wss.on(
  "connection",
  (ws) => {

    const id =
      crypto.randomUUID();

    clientes.set(
      id,
      {
        ws,
        role: "unknown"
      }
    );

    enviar(
      ws,
      {
        type: "connected",

        id,

        version:
          "2.7.0"
      }
    );

    /* ========================================================
       MENSAGENS
    ======================================================== */

    ws.on(
      "message",
      (raw) => {

        let mensagem;

        try {

          mensagem =
            JSON.parse(
              raw.toString()
            );

        } catch {

          enviar(
            ws,
            {
              type: "error",

              message:
                "Mensagem inválida."
            }
          );

          return;
        }

        const cliente =
          clientes.get(id);

        if (!cliente) {
          return;
        }

        /* ======================================================
           REGISTER
        ====================================================== */

        if (
          mensagem.type ===
          "register"
        ) {

          cliente.role =
            mensagem.role ===
            "receiver"
              ? "receiver"
              : "sender";

          enviar(
            ws,
            {
              type: "registered",

              role:
                cliente.role
            }
          );

          /*
           * MESA recebe todos os atendimentos
           * ainda pendentes.
           */
          if (
            cliente.role ===
            "receiver"
          ) {

            enviarPendentesParaMesa(
              ws
            );

          }

          /*
           * GUICHÊ recebe recusas que estavam
           * aguardando confirmação.
           */
          if (
            cliente.role ===
            "sender"
          ) {

            enviarRecusasParaGuiche(
              ws,
              id
            );

          }

          return;
        }

        /* ======================================================
           PING
        ====================================================== */

        if (
          mensagem.type ===
          "ping"
        ) {

          enviar(
            ws,
            {
              type: "pong"
            }
          );

          return;
        }

        /* ======================================================
           PONG
        ====================================================== */

        if (
          mensagem.type ===
          "pong"
        ) {

          return;
        }

        /* ======================================================
           NOVO ATENDIMENTO
        ====================================================== */

        if (
          mensagem.type ===
          "send_record"
        ) {

          const recordId =
            String(
              mensagem.recordId ||
              crypto.randomUUID()
            );

          /*
           * Se já existe, significa que o GUICHÊ
           * está reenviando o mesmo atendimento.
           */
          if (
            pendentes.has(
              recordId
            )
          ) {

            const existente =
              pendentes.get(
                recordId
              );

            /*
             * IMPORTANTE:
             *
             * Atualizamos o proprietário para
             * esta conexão atual do GUICHÊ.
             */
            existente.ownerId =
              id;

            /*
             * Atualiza os dados caso tenham
             * sido modificados.
             */
            if (
              mensagem.record &&
              typeof mensagem.record ===
                "object"
            ) {

              existente.record =
                {
                  ...existente.record,
                  ...mensagem.record
                };

            }

          } else {

            pendentes.set(
              recordId,
              {
                recordId,

                record:
                  mensagem.record ||
                  {},

                sentAt:
                  new Date()
                    .toISOString(),

                ownerId:
                  id
              }
            );

          }

          /*
           * Se o atendimento estava anteriormente
           * marcado como recusa pendente, um novo
           * envio manual significa que ele voltou
           * para a MESA.
           */
          recusasPendentes.delete(
            recordId
          );

          const item =
            pendentes.get(
              recordId
            );

          const atendimento =
            {
              type:
                "new_record",

              recordId:
                item.recordId,

              record:
                item.record,

              sentAt:
                item.sentAt
            };

          /*
           * Entrega para todas as MESAS.
           */
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

          /*
           * Confirma que o servidor recebeu
           * o envio.
           */
          enviar(
            ws,
            {
              type:
                "send_result",

              ok:
                true,

              recordId
            }
          );

          return;
        }

        /* ======================================================
           MESA RECEBEU
        ====================================================== */

        if (
          mensagem.type ===
          "confirm_received"
        ) {

          const recordId =
            String(
              mensagem.recordId ||
              ""
            );

          if (!recordId) {
            return;
          }

          const item =
            pendentes.get(
              recordId
            );

          /*
           * Pode acontecer de a confirmação
           * chegar depois de alguma operação.
           */
          if (!item) {

            enviar(
              ws,
              {
                type:
                  "confirm_result",

                ok:
                  false,

                alreadyConfirmed:
                  true,

                recordId,

                message:
                  "Atendimento já não está pendente."
              }
            );

            return;
          }

          const receivedAt =
            mensagem.receivedAt ||
            new Date()
              .toISOString();

          const confirmacao =
            {
              type:
                "record_received",

              recordId,

              receivedAt
            };

          /*
           * Avisa o GUICHÊ proprietário.
           */
          const sender =
            clientes.get(
              item.ownerId
            );

          enviar(
            sender?.ws,
            confirmacao
          );

          /*
           * Avisa as MESAS.
           */
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
                confirmacao
              );

            }

          }

          /*
           * Agora pode retirar da fila.
           */
          pendentes.delete(
            recordId
          );

          enviar(
            ws,
            {
              type:
                "confirm_result",

              ok:
                true,

              recordId
            }
          );

          return;
        }

        /* ======================================================
           MESA RECUSOU
        ====================================================== */

        if (
          mensagem.type ===
          "refuse_record"
        ) {

          const recordId =
            String(
              mensagem.recordId ||
              ""
            );

          if (!recordId) {

            enviar(
              ws,
              {
                type:
                  "refuse_result",

                ok:
                  false,

                message:
                  "recordId da recusa não informado."
              }
            );

            return;
          }

          /*
           * Localiza o atendimento que estava
           * aguardando a MESA.
           */
          const item =
            pendentes.get(
              recordId
            );

          /*
           * Se não encontrou em pendentes,
           * verifica se a recusa já havia sido
           * registrada.
           */
          if (!item) {

            const recusaExistente =
              recusasPendentes.get(
                recordId
              );

            if (
              recusaExistente
            ) {

              /*
               * Reenvia a recusa para o GUICHÊ.
               */
              const owner =
                clientes.get(
                  recusaExistente.ownerId
                );

              enviar(
                owner?.ws,
                {
                  type:
                    "record_refused",

                  recordId,

                  record:
                    recusaExistente.record,

                  reason:
                    recusaExistente.reason,

                  refusedAt:
                    recusaExistente.refusedAt
                }
              );

              enviar(
                ws,
                {
                  type:
                    "refuse_result",

                  ok:
                    true,

                  recordId
                }
              );

              return;
            }

            enviar(
              ws,
              {
                type:
                  "refuse_result",

                ok:
                  false,

                recordId,

                message:
                  "Atendimento não está mais pendente."
              }
            );

            return;
          }

          /*
           * O proprietário correto é o GUICHÊ
           * que enviou originalmente o atendimento.
           */
          const ownerId =
            item.ownerId;

          const refusedAt =
            mensagem.refusedAt ||
            new Date()
              .toISOString();

          const reason =
            String(
              mensagem.reason ||
              mensagem.record?.motivoRecusa ||
              "Motivo não informado."
            ).trim();

          /*
           * Monta o registro recusado.
           */
          const registroRecusado =
            {
              ...item.record,

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
           * Guarda a recusa até o GUICHÊ
           * confirmar que recebeu.
           */
          recusasPendentes.set(
            recordId,
            {
              recordId,

              record:
                registroRecusado,

              ownerId,

              reason,

              refusedAt
            }
          );

          /*
           * MUITO IMPORTANTE:
           *
           * Remove da fila da MESA.
           *
           * A partir deste momento a MESA
           * não deve mais receber este atendimento.
           */
          pendentes.delete(
            recordId
          );

          /*
           * Entrega imediatamente ao GUICHÊ.
           */
          const sender =
            clientes.get(
              ownerId
            );

          enviar(
            sender?.ws,
            {
              type:
                "record_refused",

              recordId,

              record:
                registroRecusado,

              reason,

              refusedAt
            }
          );

          /*
           * Também avisamos a MESA que a recusa
           * foi aceita pelo servidor.
           */
          enviar(
            ws,
            {
              type:
                "refuse_result",

              ok:
                true,

              recordId
            }
          );

          /*
           * Caso existam várias MESAS abertas,
           * remove o atendimento das outras.
           */
          for (
            const clienteAtual
            of clientes.values()
          ) {

            if (
              clienteAtual.role ===
                "receiver" &&
              clienteAtual.ws !== ws
            ) {

              enviar(
                clienteAtual.ws,
                {
                  type:
                    "record_removed",

                  recordId,

                  reason:
                    "Atendimento recusado."
                }
              );

            }

          }

          return;
        }

        /* ======================================================
           GUICHÊ CONFIRMOU RECEBIMENTO DA RECUSA
        ====================================================== */

        if (
          mensagem.type ===
          "confirm_refusal_received"
        ) {

          const recordId =
            String(
              mensagem.recordId ||
              ""
            );

          if (!recordId) {
            return;
          }

          const item =
            recusasPendentes.get(
              recordId
            );

          if (!item) {

            enviar(
              ws,
              {
                type:
                  "confirm_refusal_result",

                ok:
                  true,

                recordId,

                alreadyConfirmed:
                  true
              }
            );

            return;
          }

          /*
           * Somente o GUICHÊ proprietário
           * pode confirmar esta recusa.
           */
          if (
            item.ownerId !== id
          ) {

            enviar(
              ws,
              {
                type:
                  "confirm_refusal_result",

                ok:
                  false,

                recordId,

                message:
                  "Este GUICHÊ não é o proprietário do atendimento."
              }
            );

            return;
          }

          /*
           * O GUICHÊ recebeu.
           * Podemos retirar a recusa da memória
           * de entrega.
           */
          recusasPendentes.delete(
            recordId
          );

          enviar(
            ws,
            {
              type:
                "confirm_refusal_result",

              ok:
                true,

              recordId
            }
          );

          return;
        }

        /* ======================================================
           ERRO DESCONHECIDO
        ====================================================== */

        enviar(
          ws,
          {
            type:
              "error",

            message:
              "Tipo de mensagem não reconhecido."
          }
        );

      }
    );

    /* ========================================================
       DESCONECTOU
    ======================================================== */

    ws.on(
      "close",
      () => {

        /*
         * NÃO apagamos pendentes.
         *
         * NÃO apagamos recusas pendentes.
         *
         * Elas permanecem no servidor para que,
         * quando o dispositivo voltar, os dados
         * possam ser entregues novamente.
         */

        clientes.delete(
          id
        );

      }
    );

  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/health",
  (_req,res) => {

    res.json({

      ok:
        true,

      version:
        "2.7.0",

      clients:
        clientes.size,

      pendingRecords:
        pendentes.size,

      pendingRefusals:
        recusasPendentes.size

    });

  }
);

/* ============================================================
   STATUS
============================================================ */

app.get(
  "/status",
  (_req,res) => {

    res.json({

      ok:
        true,

      version:
        "2.7.0",

      clientes:
        [...clientes.values()]
          .map(
            cliente=>({
              role:
                cliente.role
            })
          ),

      pendentes:
        [...pendentes.values()]
          .map(
            item=>({
              recordId:
                item.recordId,

              ownerId:
                item.ownerId,

              sentAt:
                item.sentAt
            })
          ),

      recusas:
        [...recusasPendentes.values()]
          .map(
            item=>({
              recordId:
                item.recordId,

              ownerId:
                item.ownerId,

              reason:
                item.reason,

              refusedAt:
                item.refusedAt
            })
          )

    });

  }
);

/* ============================================================
   SERVIDOR
============================================================ */

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Sistema de Atendimento V2.7 iniciado na porta " +
      PORT
    );

  }
);
