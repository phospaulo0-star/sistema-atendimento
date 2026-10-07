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

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server
});

/*
=========================================================
VERSÃO
=========================================================
*/

const VERSAO = "2.8.0";

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

A recusa permanece armazenada até o GUICHÊ confirmar
que recebeu a informação.
*/

const recusasPendentes = new Map();

/*
=========================================================
FUNÇÕES AUXILIARES
=========================================================
*/

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
) {

  for (
    const cliente of clientes.values()
  ) {

    if (
      cliente.role === role &&
      cliente.ws !== ignorarWs &&
      cliente.ws.readyState === WebSocket.OPEN
    ) {

      enviar(
        cliente.ws,
        dados
      );

    }

  }

}


function encontrarClientePorId(clientId) {

  if (!clientId) {
    return null;
  }

  for (
    const cliente of clientes.values()
  ) {

    if (
      cliente.clientId === clientId
    ) {

      return cliente;

    }

  }

  return null;
}


/*
=========================================================
ENVIAR RECUSA AO GUICHÊ
=========================================================
*/

function enviarRecusaAoGuiche(recusa) {

  if (!recusa || !recusa.ownerId) {
    return false;
  }

  const guiche =
    encontrarClientePorId(
      recusa.ownerId
    );

  if (!guiche) {
    return false;
  }

  return enviar(
    guiche.ws,
    {
      type: "record_refused",

      recordId:
        recusa.recordId,

      record:
        recusa.record,

      reason:
        recusa.reason,

      refusedAt:
        recusa.refusedAt,

      ownerId:
        recusa.ownerId,

      status:
        "recusado"
    }
  );
}


/*
=========================================================
ENVIAR ATENDIMENTO PARA AS MESAS
=========================================================
*/

function transmitirNovoAtendimento(
  pendente
) {

  if (!pendente) {
    return;
  }

  transmitirParaRole(
    "receiver",
    {
      type: "new_record",

      recordId:
        pendente.recordId,

      record:
        pendente.record,

      createdAt:
        pendente.createdAt,

      updatedAt:
        pendente.updatedAt,

      reenvio:
        !!(
          pendente.record &&
          pendente.record.reenvio
        )
    }
  );
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

        try {

          const dados =
            JSON.parse(
              mensagem.toString()
            );


          /*
          ===============================================
          REGISTER
          ===============================================
          */

          if (
            dados.type ===
            "register"
          ) {

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
            MESA:
            entregar todos os atendimentos pendentes.
            ---------------------------------------------
            */

            if (
              cliente.role ===
              "receiver"
            ) {

              for (
                const pendente
                of pendentes.values()
              ) {

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
                      pendente.createdAt,

                    updatedAt:
                      pendente.updatedAt,

                    reenvio:
                      !!(
                        pendente.record &&
                        pendente.record.reenvio
                      )
                  }
                );

              }

            }


            /*
            ---------------------------------------------
            GUICHÊ:
            entregar recusas que ainda não foram
            confirmadas.
            ---------------------------------------------
            */

            if (
              cliente.role ===
              "sender"
            ) {

              for (
                const recusa
                of recusasPendentes.values()
              ) {

                if (
                  recusa.ownerId ===
                  cliente.clientId
                ) {

                  enviarRecusaAoGuiche(
                    recusa
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

          if (
            dados.type ===
            "send_record"
          ) {

            const recordId =
              dados.recordId;

            if (!recordId) {

              enviar(
                ws,
                {
                  type:
                    "send_result",

                  ok:
                    false,

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
            Um novo envio cancela uma recusa pendente
            anterior do mesmo atendimento.
            ---------------------------------------------
            */

            recusasPendentes.delete(
              recordId
            );


            /*
            ---------------------------------------------
            Recuperar atendimento anterior.
            ---------------------------------------------
            */

            const anterior =
              pendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Montar registro.
            ---------------------------------------------
            */

            const registro =
              dados.record ||
              {};


            /*
            ---------------------------------------------
            Garantir informações importantes do reenvio.
            ---------------------------------------------
            */

            if (
              registro.reenvio === true
            ) {

              registro.reenvio =
                true;

              registro.reenviadoEm =
                registro.reenviadoEm ||
                agora;

              registro.status =
                "aguardando_mesa";

            }


            const pendente = {

              recordId,

              record:
                registro,

              ownerId:
                dados.ownerId ||
                cliente.clientId ||
                anterior?.ownerId ||
                null,

              createdAt:
                anterior?.createdAt ||
                registro.createdAt ||
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
              recordId,
              "owner:",
              pendente.ownerId,
              "reenvio:",
              !!registro.reenvio
            );


            /*
            ---------------------------------------------
            Enviar para todas as MESAS.
            ---------------------------------------------
            */

            transmitirNovoAtendimento(
              pendente
            );


            /*
            ---------------------------------------------
            Confirmar ao GUICHÊ.
            ---------------------------------------------
            */

            enviar(
              ws,
              {
                type:
                  "send_result",

                ok:
                  true,

                recordId,

                reenvio:
                  !!registro.reenvio
              }
            );

            return;
          }


          /*
          ===============================================
          CONFIRM_RECEIVED
          ===============================================
          */

          if (
            dados.type ===
            "confirm_received"
          ) {

            const recordId =
              dados.recordId;


            const pendente =
              pendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Descobrir o GUICHÊ dono.
            ---------------------------------------------
            */

            let ownerId =
              pendente?.ownerId ||
              dados.ownerId ||
              null;


            if (
              pendente &&
              dados.ownerId &&
              pendente.ownerId !==
                dados.ownerId
            ) {

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

            if (ownerId) {

              const guiche =
                encontrarClientePorId(
                  ownerId
                );

              if (guiche) {

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
            Avisar as MESAS.
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
            Retirar dos pendentes.
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

                ok:
                  true,

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
          */

          if (
            dados.type ===
            "refuse_record"
          ) {

            const recordId =
              dados.recordId;


            if (!recordId) {

              enviar(
                ws,
                {
                  type:
                    "refuse_result",

                  ok:
                    false,

                  error:
                    "recordId não informado."
                }
              );

              return;
            }


            /*
            ---------------------------------------------
            Procurar primeiro nos pendentes.
            ---------------------------------------------
            */

            const pendente =
              pendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Determinar o GUICHÊ dono.
            ---------------------------------------------
            */

            const ownerId =
              pendente?.ownerId ||
              dados.ownerId ||
              dados.record?.ownerId ||
              null;


            /*
            ---------------------------------------------
            Registro enviado pela MESA.
            ---------------------------------------------
            */

            const registro = {

              ...(pendente?.record || {}),
              ...(dados.record || {})

            };


            /*
            ---------------------------------------------
            Motivo da recusa.
            ---------------------------------------------
            */

            const motivo =
              String(
                dados.reason ??
                dados.motivoRecusa ??
                registro.motivoRecusa ??
                "Motivo não informado."
              ).trim();


            /*
            ---------------------------------------------
            Data/hora da recusa.
            ---------------------------------------------
            */

            const refusedAt =
              dados.refusedAt ||
              new Date()
                .toISOString();


            /*
            ---------------------------------------------
            Criar objeto definitivo da recusa.
            ---------------------------------------------
            */

            registro.status =
              "recusado";

            registro.motivoRecusa =
              motivo;

            registro.recusadoEm =
              refusedAt;


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
            Guardar no servidor.
            ---------------------------------------------
            */

            recusasPendentes.set(
              recordId,
              recusa
            );


            /*
            ---------------------------------------------
            Retirar imediatamente da fila da MESA.
            ---------------------------------------------
            */

            pendentes.delete(
              recordId
            );


            console.log(
              "===================================="
            );

            console.log(
              "ATENDIMENTO RECUSADO"
            );

            console.log(
              "recordId:",
              recordId
            );

            console.log(
              "ownerId:",
              ownerId
            );

            console.log(
              "motivo:",
              motivo
            );

            console.log(
              "===================================="
            );


            /*
            ---------------------------------------------
            ENVIAR PARA O GUICHÊ
            ---------------------------------------------
            */

            const enviadoAoGuiche =
              enviarRecusaAoGuiche(
                recusa
              );


            /*
            ---------------------------------------------
            Se o GUICHÊ estiver desconectado,
            a recusa permanece em recusasPendentes.
            ---------------------------------------------
            */

            if (!enviadoAoGuiche) {

              console.log(
                "GUICHÊ offline. Recusa armazenada para entrega posterior:",
                recordId
              );

            }


            /*
            ---------------------------------------------
            Remover das outras MESAS.
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
            Confirmar para a MESA.
            ---------------------------------------------
            */

            enviar(
              ws,
              {
                type:
                  "refuse_result",

                ok:
                  true,

                recordId,

                refusedAt,

                deliveredToGuiche:
                  enviadoAoGuiche
              }
            );

            return;
          }


          /*
          ===============================================
          CONFIRM_REFUSAL_RECEIVED
          ===============================================
          */

          if (
            dados.type ===
            "confirm_refusal_received"
          ) {

            const recordId =
              dados.recordId;


            const recusa =
              recusasPendentes.get(
                recordId
              );


            /*
            ---------------------------------------------
            Se já não estiver na fila, considerar
            confirmado.
            ---------------------------------------------
            */

            if (!recusa) {

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
            ---------------------------------------------
            Segurança.
            ---------------------------------------------
            */

            if (
              recusa.ownerId &&
              dados.ownerId &&
              recusa.ownerId !==
                dados.ownerId
            ) {

              enviar(
                ws,
                {
                  type:
                    "confirm_refusal_result",

                  ok:
                    false,

                  recordId,

                  error:
                    "Cliente não autorizado."
                }
              );

              return;
            }


            /*
            ---------------------------------------------
            Retirar recusa da fila do servidor.
            ---------------------------------------------
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


            console.log(
              "GUICHÊ confirmou recebimento da recusa:",
              recordId
            );

            return;
          }


          /*
          ===============================================
          RECORD_STATUS
          ===============================================

          Permite sincronização futura de status.
          ===============================================
          */

          if (
            dados.type ===
            "record_status"
          ) {

            const recordId =
              dados.recordId;

            const status =
              dados.status;

            console.log(
              "Atualização de status:",
              recordId,
              status
            );

            return;
          }


          /*
          ===============================================
          PING
          ===============================================
          */

          if (
            dados.type ===
            "ping"
          ) {

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

        } catch (erro) {

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
  (req, res) => {

    res.json({

      ok:
        true,

      version:
        VERSAO,

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
  (req, res) => {

    const listaClientes =
      [];

    for (
      const cliente
      of clientes.values()
    ) {

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

      ok:
        true,

      version:
        VERSAO,

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
      `Servidor V${VERSAO} funcionando na porta ${PORT}`
    );

  }
);
