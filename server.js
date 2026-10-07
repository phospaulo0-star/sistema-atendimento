const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT =
  process.env.PORT || 3000;


/* =========================================================
   ARQUIVOS PÚBLICOS
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* =========================================================
   SERVIDOR HTTP
========================================================= */

const server =
  http.createServer(
    app
  );


/* =========================================================
   WEBSOCKET
========================================================= */

const wss =
  new WebSocket.Server({
    server
  });


/*
 * Clientes conectados.
 *
 * role:
 *   sender   = GUICHÊ
 *   receiver = MESA
 */
const clientes =
  new Map();


/*
 * Atendimentos enviados mas ainda
 * não confirmados pela MESA.
 *
 * O atendimento permanece aqui mesmo
 * que GUICHÊ ou MESA desconectem.
 */
const pendentes =
  new Map();


/* =========================================================
   ENVIO
========================================================= */

function enviar(
  ws,
  dados
) {

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {

    try {

      ws.send(
        JSON.stringify(
          dados
        )
      );

      return true;

    } catch {

      return false;

    }

  }

  return false;

}


/* =========================================================
   ENVIAR PENDENTES PARA UMA MESA
========================================================= */

function enviarPendentesParaMesa(
  ws
) {

  for (
    const item of pendentes.values()
  ) {

    enviar(
      ws,
      {

        type:
          "new_record",

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


/* =========================================================
   CONEXÃO
========================================================= */

wss.on(
  "connection",
  ws => {

    const id =
      crypto.randomUUID();


    clientes.set(
      id,
      {

        ws,

        role:
          "unknown"

      }
    );


    enviar(
      ws,
      {

        type:
          "connected",

        id,

        version:
          "2.3.0"

      }
    );


    /* =====================================================
       MENSAGENS
    ===================================================== */

    ws.on(
      "message",
      raw => {

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

              type:
                "error",

              message:
                "Mensagem inválida."

            }
          );

          return;

        }


        const cliente =
          clientes.get(
            id
          );


        if (
          !cliente
        ) {

          return;

        }


        /* =================================================
           REGISTRO DO CLIENTE
        ================================================= */

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

              type:
                "registered",

              role:
                cliente.role

            }
          );


          /*
           * Se for uma MESA,
           * entrega imediatamente
           * todos os pendentes.
           */
          if (
            cliente.role ===
            "receiver"
          ) {

            enviarPendentesParaMesa(
              ws
            );

          }


          return;

        }


        /* =================================================
           NOVO ATENDIMENTO
        ================================================= */

        if (
          mensagem.type ===
          "send_record"
        ) {

          const recordId =
            mensagem.recordId ||
            crypto.randomUUID();


          /*
           * DEDUPLICAÇÃO
           *
           * Se o GUICHÊ reenviar o mesmo
           * registro após uma reconexão,
           * não criamos outro atendimento.
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


            existente.record =
              mensagem.record ||
              existente.record;


            /*
             * Atualizamos o proprietário
             * para a conexão atual do GUICHÊ.
             */
            existente.ownerId =
              id;

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
           * Envia para TODAS as MESAS
           * conectadas.
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


          return;

        }


        /* =================================================
           CONFIRMAÇÃO DE RECEBIMENTO
        ================================================= */

        if (
          mensagem.type ===
          "confirm_received"
        ) {

          const recordId =
            mensagem.recordId;


          if (
            !recordId
          ) {

            return;

          }


          const item =
            pendentes.get(
              recordId
            );


          /*
           * Já confirmado anteriormente.
           */
          if (
            !item
          ) {

            return;

          }


          const receivedAt =
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
           * Avisa o GUICHÊ que enviou.
           */
          const sender =
            clientes.get(
              item.ownerId
            );


          if (
            sender
          ) {

            enviar(
              sender.ws,
              confirmacao
            );

          }


          /*
           * Avisa também todas as MESAS.
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
           * SOMENTE depois da confirmação
           * retiramos o atendimento da fila
           * do servidor.
           */
          pendentes.delete(
            recordId
          );


          return;

        }

      }
    );


    /* =====================================================
       DESCONEXÃO
    ===================================================== */

    ws.on(
      "close",
      () => {

        /*
         * NÃO apagamos pendentes.
         *
         * Se a MESA cair, os atendimentos
         * continuam no servidor.
         *
         * Quando a MESA voltar, receberá
         * novamente todos os pendentes.
         */

        clientes.delete(
          id
        );

      }
    );


    ws.on(
      "error",
      () => {

        /*
         * O close normalmente será
         * acionado em seguida.
         */

      }
    );

  }
);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (_req, res) => {

    res.json({

      ok:
        true,

      version:
        "2.3.0",

      clients:
        clientes.size,

      pendingRecords:
        pendentes.size

    });

  }
);


/* =========================================================
   INÍCIO
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Sistema de Atendimento V2.3 iniciado na porta ${PORT}`
    );

  }
);
