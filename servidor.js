const express = require("express");
const http = require("http");
const WebSocket = require("ws");
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

/*
=========================================================
CLIENTES CONECTADOS
=========================================================
*/

const clientes = new Map();

/*
=========================================================
ATENDIMENTOS PENDENTES
=========================================================

recordId -> {
  recordId,
  record,
  ownerId,
  createdAt,
  updatedAt
}
*/

const pendentes = new Map();

/*
=========================================================
RECUSAS PENDENTES
=========================================================

A recusa fica armazenada até o GUICHÊ confirmar
que recebeu a informação.
*/

const recusasPendentes = new Map();


/*
=========================================================
FUNÇÕES AUXILIARES
=========================================================
*/

function enviar(ws, dados){

  if(
    ws &&
    ws.readyState === WebSocket.OPEN
  ){

    try{

      ws.send(
        JSON.stringify(dados)
      );

      return true;

    }catch(erro){

      console.error(
        "Erro ao enviar mensagem:",
        erro
      );

    }

  }

  return false;

}


function transmitirParaRole(
  role,
  dados,
  ignorarWs = null
){

  for(
    const cliente of clientes.values()
  ){

    if(
      cliente.role === role &&
      cliente.ws !== ignorarWs &&
      cliente.ws.readyState ===
        WebSocket.OPEN
    ){

      enviar(
        cliente.ws,
        dados
      );

    }

  }

}


function encontrarClientePorId(
  clientId
){

  if(!clientId){
    return null;
  }

  for(
    const cliente of clientes.values()
  ){

    if(
      cliente.clientId ===
      clientId
    ){

      return cliente;

    }

  }

  return null;

}


/*
=========================================================
CONEXÃO WEBSOCKET
=========================================================
*/

wss.on(
  "connection",
  (ws) => {

    const cliente = {

      ws,

      role:
        "receiver",

      clientId:
        null,

      ownerId:
        null

    };

    clientes.set(
      ws,
      cliente
    );

    console.log(
      "Cliente conectado."
    );


    /*
    =====================================================
    MENSAGENS
    =====================================================
    */

    ws.on(
      "message",
      (mensagem) => {

        try{

          const dados =
            JSON.parse(
              mensagem.toString()
            );


          /*
          ===============================================
          REGISTER
          ===============================================
          */

          if(
            dados.type ===
            "register"
          ){

            cliente.role =
              dados.role ||
              "receiver";

            cliente.clientId =
              dados.clientId ||
              null;

            cliente.ownerId =
              dados.ownerId ||
              dados.clientId ||
              null;

            console.log(
              "Cliente registrado:",
              cliente.role,
              cliente.clientId
            );


            /*
            ---------------------------------------------
            Enviar ao receptor todos os atendimentos
            que ainda estão pendentes.
            ---------------------------------------------
            */

            if(
              cliente.role ===
              "receiver"
            ){

              for(
                const pendente
                of pendentes.values()
              ){

                enviar(
                  ws,
                  {
                    type:
                      "new_record",

                    recordId:
                      pendente.recordId,

                    record:
                      pendente.record,

                    createdAt:
                      pendente.createdAt
                  }
                );

              }

            }


            /*
            ---------------------------------------------
            Se for GUICHÊ, entregar recusas pendentes
            que pertencem a ele.
            ---------------------------------------------
            */

            if(
              cliente.role ===
              "sender"
            ){

              for(
                const recusa
                of recusasPendentes.values()
              ){

                if(
                  recusa.ownerId ===
                  cliente.clientId
                ){

                  enviar(
                    ws,
                    {
                      type:
                        "record_refused",

                      recordId:
                        recusa.recordId,

                      record:
                        recusa.record,

                      reason:
                        recusa.reason,

                      refusedAt:
                        recusa.refusedAt
                    }
                  );

                }

              }

            }

            return;

          }


          /*
          ===============================================
          SEND_RECORD
          ===============================================
          */

          if(
            dados.type ===
            "send_record"
          ){

            const recordId =
              dados.recordId;

            if(!recordId){

              enviar(
                ws,
                {
                  type:
                    "send_result",

                  ok:false,

                  error:
                    "recordId não informado."
                }
              );

              return;

            }

            const agora =
              new Date()
                .toISOString();


            /*
            ---------------------------------------------
            Se esse atendimento já tinha sido recusado,
            um novo envio cancela a recusa pendente.
            ---------------------------------------------
            */

            recusasPendentes.delete(
              recordId
            );


            /*
            ---------------------------------------------
            Guardar/atualizar atendimento pendente.
            ---------------------------------------------
            */

            const anterior =
              pendentes.get(
                recordId
              );

            const pendente = {

              recordId,

              record:
                dados.record ||
                {},

              ownerId:
                dados.ownerId ||
                cliente.clientId ||
                anterior?.ownerId ||
                null,

              createdAt:
                anterior?.createdAt ||
                agora,

              updatedAt:
                agora

            };

            pendentes.set(
              recordId,
              pendente
            );


            console.log(
              "Atendimento enviado:",
              recordId
            );


            /*
            ---------------------------------------------
            Enviar para todas as MESAS conectadas.
            ---------------------------------------------
            */

            transmitirParaRole(
              "receiver",
              {
                type:
                  "new_record",

                recordId,

                record:
                  pendente.record,

                createdAt:
                  pendente.createdAt
              }
            );


            /*
            ---------------------------------------------
            Confirmar ao GUICHÊ que o servidor recebeu.
            ---------------------------------------------
            */

            enviar(
              ws,
              {
                type:
                  "send_result",

                ok:true,

                recordId
              }
            );

            return;

          }


          /*
          ===============================================
          CONFIRM_RECEIVED
          ===============================================
          */

          if(
            dados.type ===
            "confirm_received"
          ){

            const recordId =
              dados.recordId;

            const pendente =
              pendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Mesmo que o servidor tenha reiniciado e
            perdido o pendente, ainda avisamos o GUICHÊ
            se o ownerId estiver disponível.
            ---------------------------------------------
            */

            let ownerId =
              pendente?.ownerId ||
              dados.ownerId ||
              null;


            if(
              pendente &&
              dados.ownerId &&
              pendente.ownerId !==
                dados.ownerId
            ){

              ownerId =
                pendente.ownerId;

            }


            const recebidoEm =
              dados.receivedAt ||
              new Date()
                .toISOString();


            /*
            ---------------------------------------------
            Avisar o GUICHÊ.
            ---------------------------------------------
            */

            if(ownerId){

              const guiche =
                encontrarClientePorId(
                  ownerId
                );

              if(guiche){

                enviar(
                  guiche.ws,
                  {
                    type:
                      "record_received",

                    recordId,

                    receivedAt:
                      recebidoEm
                  }
                );

              }

            }


            /*
            ---------------------------------------------
            Avisar todas as MESAS para manter a situação
            sincronizada.
            ---------------------------------------------
            */

            transmitirParaRole(
              "receiver",
              {
                type:
                  "record_received",

                recordId,

                receivedAt:
                  recebidoEm
              }
            );


            /*
            ---------------------------------------------
            Depois que a Mesa recebeu, o pendente deixa
            de existir no servidor.
            ---------------------------------------------
            */

            pendentes.delete(
              recordId
            );


            enviar(
              ws,
              {
                type:
                  "confirm_result",

                ok:true,

                recordId
              }
            );

            console.log(
              "Atendimento recebido:",
              recordId
            );

            return;

          }


          /*
          ===============================================
          REFUSE_RECORD
          ===============================================

          A MESA envia esta mensagem quando recusa
          um atendimento.
          */

          if(
            dados.type ===
            "refuse_record"
          ){

            const recordId =
              dados.recordId;

            if(!recordId){

              enviar(
                ws,
                {
                  type:
                    "refuse_result",

                  ok:false,

                  error:
                    "recordId não informado."
                }
              );

              return;

            }


            const pendente =
              pendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Descobrir quem é o dono do atendimento.
            ---------------------------------------------
            */

            const ownerId =
              pendente?.ownerId ||
              dados.ownerId ||
              null;


            const registro =
              dados.record ||
              pendente?.record ||
              {};


            const motivo =
              String(
                dados.reason ||
                dados.motivoRecusa ||
                "Motivo não informado."
              ).trim();


            const refusedAt =
              dados.refusedAt ||
              new Date()
                .toISOString();


            /*
            ---------------------------------------------
            Criar registro de recusa.
            ---------------------------------------------
            */

            const recusa = {

              recordId,

              record:
                registro,

              ownerId,

              reason:
                motivo,

              refusedAt

            };


            /*
            ---------------------------------------------
            Guardar a recusa até o GUICHÊ confirmar.
            ---------------------------------------------
            */

            recusasPendentes.set(
              recordId,
              recusa
            );


            /*
            ---------------------------------------------
            REMOVER imediatamente dos pendentes.

            Isso garante que a MESA não continue mostrando
            o atendimento recusado.
            ---------------------------------------------
            */

            pendentes.delete(
              recordId
            );


            console.log(
              "Atendimento recusado:",
              recordId,
              motivo
            );


            /*
            ---------------------------------------------
            Enviar recusa para o GUICHÊ.
            ---------------------------------------------
            */

            if(ownerId){

              const guiche =
                encontrarClientePorId(
                  ownerId
                );

              if(guiche){

                enviar(
                  guiche.ws,
                  {
                    type:
                      "record_refused",

                    recordId,

                    record:
                      registro,

                    reason:
                      motivo,

                    refusedAt
                  }
                );

              }

            }


            /*
            ---------------------------------------------
            Remover das outras MESAS conectadas.
            ---------------------------------------------
            */

            transmitirParaRole(
              "receiver",
              {
                type:
                  "record_removed",

                recordId,

                reason:
                  motivo,

                refusedAt
              },
              ws
            );


            /*
            ---------------------------------------------
            Confirmar para a MESA que a recusa foi
            registrada pelo servidor.
            ---------------------------------------------
            */

            enviar(
              ws,
              {
                type:
                  "refuse_result",

                ok:true,

                recordId,

                refusedAt
              }
            );

            return;

          }


          /*
          ===============================================
          CONFIRM_REFUSAL_RECEIVED
          ===============================================

          O GUICHÊ envia esta mensagem depois que recebeu
          a recusa.
          */

          if(
            dados.type ===
            "confirm_refusal_received"
          ){

            const recordId =
              dados.recordId;

            const recusa =
              recusasPendentes.get(
                recordId
              );

            if(!recusa){

              enviar(
                ws,
                {
                  type:
                    "confirm_refusal_result",

                  ok:true,

                  recordId,

                  alreadyConfirmed:true
                }
              );

              return;

            }


            /*
            ---------------------------------------------
            Segurança: somente o GUICHÊ dono pode
            confirmar a recusa.
            ---------------------------------------------
            */

            if(
              recusa.ownerId &&
              dados.ownerId &&
              recusa.ownerId !==
                dados.ownerId
            ){

              enviar(
                ws,
                {
                  type:
                    "confirm_refusal_result",

                  ok:false,

                  recordId,

                  error:
                    "Cliente não autorizado."
                }
              );

              return;

            }


            recusasPendentes.delete(
              recordId
            );


            enviar(
              ws,
              {
                type:
                  "confirm_refusal_result",

                ok:true,

                recordId
              }
            );


            console.log(
              "GUICHÊ confirmou recebimento da recusa:",
              recordId
            );

            return;

          }


          /*
          ===============================================
          PING
          ===============================================
          */

          if(
            dados.type ===
            "ping"
          ){

            enviar(
              ws,
              {
                type:
                  "pong",

                time:
                  new Date()
                    .toISOString()
              }
            );

            return;

          }

        }catch(erro){

          console.error(
            "Erro ao processar mensagem:",
            erro
          );

          enviar(
            ws,
            {
              type:
                "server_error",

              error:
                "Erro ao processar a mensagem."
            }
          );

        }

      }
    );


    /*
    =====================================================
    DESCONEXÃO
    =====================================================
    */

    ws.on(
      "close",
      () => {

        clientes.delete(
          ws
        );

        console.log(
          "Cliente desconectado."
        );

      }
    );


    /*
    =====================================================
    ERRO
    =====================================================
    */

    ws.on(
      "error",
      (erro) => {

        console.error(
          "Erro WebSocket:",
          erro
        );

      }
    );

  }
);


/*
=========================================================
HEALTH CHECK
=========================================================
*/

app.get(
  "/health",
  (req,res) => {

    res.json({

      ok:true,

      version:
        "2.7.0",

      clientes:
        clientes.size,

      pendentes:
        pendentes.size,

      recusasPendentes:
        recusasPendentes.size,

      timestamp:
        new Date()
          .toISOString()

    });

  }
);


/*
=========================================================
STATUS
=========================================================
*/

app.get(
  "/status",
  (req,res) => {

    const listaClientes =
      [];

    for(
      const cliente
      of clientes.values()
    ){

      listaClientes.push({

        role:
          cliente.role,

        clientId:
          cliente.clientId,

        ownerId:
          cliente.ownerId,

        conectado:
          cliente.ws.readyState ===
          WebSocket.OPEN

      });

    }

    res.json({

      ok:true,

      version:
        "2.7.0",

      clientes:
        listaClientes,

      pendentes:
        Array.from(
          pendentes.values()
        ).map(
          item => ({
            recordId:
              item.recordId,

            ownerId:
              item.ownerId,

            createdAt:
              item.createdAt,

            updatedAt:
              item.updatedAt
          })
        ),

      recusasPendentes:
        Array.from(
          recusasPendentes.values()
        ).map(
          item => ({
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


/*
=========================================================
PORTA
=========================================================
*/

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Servidor V2.7.0 funcionando na porta ${PORT}`
    );

  }
);
