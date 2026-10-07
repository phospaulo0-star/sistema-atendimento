const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");


const app =
  express();


app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


const server =
  http.createServer(
    app
  );


const wss =
  new WebSocket.Server({
    server
  });


/*
 * Clientes conectados
 */
const clientes =
  new Map();


/*
 * Atendimentos ainda não
 * confirmados pela MESA.
 *
 * IMPORTANTE:
 * Nunca apagar aqui simplesmente
 * porque o GUICHÊ ou a MESA
 * desconectou.
 */
const pendentes =
  new Map();


function enviar(
  ws,
  dados
) {

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(
        dados
      )
    );
  }
}


/*
 * Entrega imediatamente
 * todos os atendimentos
 * pendentes para uma MESA
 * recém-conectada.
 */
function enviarPendentesParaMesa(
  ws
) {

  for (
    const item
    of pendentes.values()
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


wss.on(
  "connection",
  (ws) => {

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
          "2.2.0"

      }
    );


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


        if (!cliente) {
          return;
        }


        /*
         * REGISTRO
         */

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
           * MESA:
           * entrega imediatamente
           * os pendentes.
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


        /*
         * NOVO ATENDIMENTO
         */

        if (
          mensagem.type ===
          "send_record"
        ) {

          const recordId =
            mensagem.recordId ||
            crypto.randomUUID();


          /*
           * Se já existe,
           * o GUICHÊ está reenviando
           * o mesmo atendimento.
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
             * Atualiza o proprietário
             * para a nova conexão
             * do GUICHÊ.
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
           * Entrega imediatamente
           * para todas as MESAS
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


        /*
         * CONFIRMAÇÃO DA MESA
         */

        if (
          mensagem.type ===
          "confirm_received"
        ) {

          const recordId =
            mensagem.recordId;


          const item =
            pendentes.get(
              recordId
            );


          if (!item) {
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
           * Avisa o GUICHÊ.
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
           * Avisa todas as MESAS.
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
           * Só agora remove
           * da fila pendente.
           */
          pendentes.delete(
            recordId
          );


          return;
        }

      }
    );


    ws.on(
      "close",
      () => {

        /*
         * NÃO remover pendentes.
         *
         * Isso é fundamental para que
         * a MESA possa receber depois.
         */

        clientes.delete(
          id
        );
      }
    );

  }
);


/*
 * TESTE DO SERVIDOR
 */

app.get(
  "/health",
  (_req, res) => {

    res.json({

      ok:
        true,

      version:
        "2.2.0",

      clients:
        clientes.size,

      pendingRecords:
        pendentes.size

    });

  }
);


const PORT =
  process.env.PORT ||
  3000;


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Sistema de Atendimento V2.2 iniciado na porta " +
      PORT
    );

  }
);
