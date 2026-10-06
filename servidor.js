const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");


const app = express();

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
 * Clientes atualmente conectados.
 */
const clientes =
  new Map();


/*
 * Atendimentos que ainda não foram
 * confirmados pela MESA.
 *
 * Eles permanecem aqui mesmo se
 * o GUICHÊ ou a MESA desconectarem.
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
 * Envia todos os atendimentos
 * ainda pendentes para uma MESA
 * que acabou de conectar.
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
          "2.1.0"
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
         * REGISTRO DO CLIENTE
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
           * Se for MESA,
           * entrega imediatamente
           * todos os atendimentos
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
           * Se já existe, significa
           * que o GUICHÊ está reenviando
           * um atendimento pendente.
           *
           * Não cria duplicado.
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
           * Entrega o atendimento
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
           * Avisa o GUICHÊ
           * que a MESA recebeu.
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
           * Também avisa todas as MESAS.
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
           * Agora que houve confirmação,
           * pode retirar da fila pendente.
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
         * IMPORTANTE:
         *
         * NÃO apagamos os atendimentos
         * pendentes quando o GUICHÊ
         * ou a MESA desconecta.
         *
         * Assim o atendimento não é perdido.
         */


        clientes.delete(
          id
        );
      }
    );

  }
);


/*
 * Rota de teste do servidor.
 */
app.get(
  "/health",
  (_req, res) => {

    res.json({

      ok: true,

      version:
        "2.1.0",

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
      "Sistema de Atendimento V2.1 iniciado na porta " +
      PORT
    );

  }
);
