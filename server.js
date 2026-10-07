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

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

const clientes = new Map();

/*
  Atendimento aguardando a confirmação da MESA.
  O recordId é a identificação única do atendimento.
*/
const pendentes = new Map();


function enviar(ws, dados) {

  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(dados)
    );

  }

}


/*
  Quando a MESA conecta, recebe todos
  os atendimentos que ainda aguardam
  confirmação.
*/
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


wss.on(
  "connection",
  (ws) => {

    const clientId =
      crypto.randomUUID();


    clientes.set(
      clientId,
      {
        ws,
        role: "unknown"
      }
    );


    enviar(
      ws,
      {
        type: "connected",

        id:
          clientId,

        version:
          "2.4.0"
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
              type: "error",

              message:
                "Mensagem inválida."
            }
          );

          return;

        }


        const cliente =
          clientes.get(
            clientId
          );


        if (!cliente) {

          return;

        }


        /*
          REGISTRO DO TIPO DE CLIENTE
          
          GUICHÊ = sender
          MESA   = receiver
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
            Se for a MESA,
            envia imediatamente
            os atendimentos pendentes.
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
          GUICHÊ ENVIA ATENDIMENTO
        */
        if (
          mensagem.type ===
          "send_record"
        ) {

          const registro =
            {
              ...(mensagem.record || {})
            };


          /*
            IMPORTANTE:
            primeiro tenta usar o
            recordId enviado pelo
            GUICHÊ.

            Isso corrige o problema
            que estava acontecendo.
          */
          const recordId =
            mensagem.recordId ||
            registro.recordId ||
            crypto.randomUUID();


          registro.recordId =
            recordId;


          /*
            Se já existe esse atendimento,
            apenas atualiza o dono da
            conexão para o GUICHÊ atual.
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
              registro;


            existente.ownerId =
              clientId;

          }

          else {

            pendentes.set(
              recordId,
              {
                recordId,

                record:
                  registro,

                sentAt:
                  new Date()
                    .toISOString(),

                ownerId:
                  clientId
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
            Envia para todas as MESAS
            conectadas.
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
          MESA CONFIRMA RECEBIMENTO
        */
        if (
          mensagem.type ===
          "confirm_received"
        ) {

          const recordId =
            mensagem.recordId;


          if (!recordId) {

            enviar(
              ws,
              {
                type:
                  "error",

                message:
                  "Confirmação sem recordId."
              }
            );

            return;

          }


          const item =
            pendentes.get(
              recordId
            );


          /*
            Se já foi confirmado,
            não cria outro atendimento.
          */
          if (!item) {

            enviar(
              ws,
              {
                type:
                  "confirm_result",

                recordId,

                ok:
                  false,

                message:
                  "Atendimento já confirmado ou não encontrado."
              }
            );

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
            Retorna a confirmação
            para o GUICHÊ que enviou.
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
            Também informa outras MESAS,
            se houver.
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
                confirmacao
              );

            }

          }


          /*
            Agora o atendimento deixa
            de ser pendente.
          */
          pendentes.delete(
            recordId
          );


          enviar(
            ws,
            {
              type:
                "confirm_result",

              recordId,

              ok:
                true,

              receivedAt
            }
          );


          return;

        }

      }
    );


    /*
      IMPORTANTE:
      se o GUICHÊ ou MESA fechar,
      NÃO apagamos os atendimentos
      pendentes.
    */
    ws.on(
      "close",
      () => {

        clientes.delete(
          clientId
        );

      }
    );

  }
);


/*
  Teste do servidor:
  
  https://seu-site.onrender.com/health
*/
app.get(
  "/health",
  (_req, res) => {

    res.json(
      {
        ok:
          true,

        version:
          "2.4.0",

        clients:
          clientes.size,

        pendingRecords:
          pendentes.size
      }
    );

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
      "Sistema de Atendimento V2.4 iniciado na porta " +
      PORT
    );

  }
);
