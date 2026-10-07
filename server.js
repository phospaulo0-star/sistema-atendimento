const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();

/* ============================================================
   ARQUIVOS PÚBLICOS
============================================================ */

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

/*
 * clientes:
 *
 * clientId -> {
 *   ws,
 *   role
 * }
 *
 * role:
 *   sender   = GUICHÊ
 *   receiver = MESA
 */

const clientes =
  new Map();

/* ============================================================
   ATENDIMENTOS PENDENTES
============================================================ */

/*
 * Os registros ficam aqui enquanto ainda não foram
 * confirmados pela MESA.
 *
 * recordId -> {
 *   recordId,
 *   record,
 *   sentAt,
 *   ownerId
 * }
 */

const pendentes =
  new Map();

/* ============================================================
   FUNÇÕES AUXILIARES
============================================================ */

function enviar(
  ws,
  dados
){

  if(
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ){

    try{

      ws.send(
        JSON.stringify(dados)
      );

      return true;

    }catch(error){

      console.error(
        "Erro ao enviar WebSocket:",
        error
      );

      return false;
    }
  }

  return false;
}

function enviarParaGuiches(
  dados
){

  let quantidade = 0;

  for(
    const cliente
    of clientes.values()
  ){

    if(
      cliente.role ===
      "sender"
    ){

      if(
        enviar(
          cliente.ws,
          dados
        )
      ){

        quantidade++;

      }

    }

  }

  return quantidade;
}

function enviarParaMesas(
  dados,
  ignorarWs = null
){

  let quantidade = 0;

  for(
    const cliente
    of clientes.values()
  ){

    if(
      cliente.role ===
      "receiver" &&
      cliente.ws !==
        ignorarWs
    ){

      if(
        enviar(
          cliente.ws,
          dados
        )
      ){

        quantidade++;

      }

    }

  }

  return quantidade;
}

/* ============================================================
   ENVIAR PENDENTES PARA UMA MESA
============================================================ */

function enviarPendentesParaMesa(
  ws
){

  for(
    const item
    of pendentes.values()
  ){

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

/* ============================================================
   CONEXÃO WEBSOCKET
============================================================ */

wss.on(
  "connection",
  ws => {

    const clientId =
      crypto.randomUUID();

    clientes.set(
      clientId,
      {
        ws,
        role:"unknown"
      }
    );

    console.log(
      "Cliente conectado:",
      clientId
    );

    enviar(
      ws,
      {
        type:
          "connected",

        id:
          clientId,

        version:
          "2.5.0"
      }
    );

    /* ========================================================
       RECEBIMENTO DE MENSAGENS
    ======================================================== */

    ws.on(
      "message",
      raw => {

        let mensagem;

        try{

          mensagem =
            JSON.parse(
              raw.toString()
            );

        }catch(error){

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
            clientId
          );

        if(!cliente){
          return;
        }

        console.log(
          "Mensagem recebida:",
          mensagem.type,
          "de",
          cliente.role
        );

        /* ====================================================
           REGISTRO DO CLIENTE
        ==================================================== */

        if(
          mensagem.type ===
          "register"
        ){

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

          console.log(
            "Cliente registrado:",
            clientId,
            cliente.role
          );

          /*
           * Se for MESA, enviamos imediatamente
           * todos os atendimentos que ainda estão
           * pendentes.
           */
          if(
            cliente.role ===
            "receiver"
          ){

            enviarPendentesParaMesa(
              ws
            );

          }

          return;
        }

        /* ====================================================
           GUICHÊ ENVIA NOVO ATENDIMENTO
        ==================================================== */

        if(
          mensagem.type ===
          "send_record"
        ){

          processarEnvioDoGuiche(
            ws,
            clientId,
            mensagem
          );

          return;
        }

        /* ====================================================
           MESA CONFIRMA RECEBIMENTO
        ==================================================== */

        if(
          mensagem.type ===
          "confirm_received"
        ){

          processarConfirmacaoMesa(
            ws,
            clientId,
            mensagem
          );

          return;
        }

        /* ====================================================
           MESA RECUSA ATENDIMENTO
        ==================================================== */

        if(
          mensagem.type ===
          "refuse_record"
        ){

          processarRecusaMesa(
            ws,
            clientId,
            mensagem
          );

          return;
        }

        /* ====================================================
           TIPO DESCONHECIDO
        ==================================================== */

        enviar(
          ws,
          {
            type:
              "error",

            message:
              "Tipo de mensagem não reconhecido: " +
              String(
                mensagem.type ||
                ""
              )
          }
        );

      }
    );

    /* ========================================================
       DESCONECTOU
    ======================================================== */

    ws.on(
      "close",
      ()=>{
        
        const clienteAtual =
          clientes.get(
            clientId
          );

        console.log(
          "Cliente desconectado:",
          clientId,
          clienteAtual?.role
        );

        clientes.delete(
          clientId
        );

      }
    );

    ws.on(
      "error",
      error => {

        console.error(
          "Erro WebSocket:",
          error
        );

      }
    );

  }
);

/* ============================================================
   GUICHÊ ENVIA ATENDIMENTO
============================================================ */

function processarEnvioDoGuiche(
  ws,
  clientId,
  mensagem
){

  const registro =
    {
      ...(mensagem.record || {})
    };

  const recordId =
    mensagem.recordId ||
    registro.recordId ||
    crypto.randomUUID();

  registro.recordId =
    recordId;

  /*
   * Se não houver data de envio,
   * o servidor cria uma.
   */
  if(
    !registro.enviadoEm
  ){

    registro.enviadoEm =
      new Date().toISOString();

  }

  /*
   * O servidor considera o cadastro aguardando
   * recebimento pela Mesa.
   */
  registro.status =
    "aguardando_mesa";

  /*
   * Se o registro já existe, significa que o GUICHÊ
   * está reenviando ou tentando novamente depois
   * de uma queda de conexão.
   */
  if(
    pendentes.has(
      recordId
    )
  ){

    const existente =
      pendentes.get(
        recordId
      );

    existente.record =
      registro;

    /*
     * O novo GUICHÊ que enviou o registro passa
     * a ser o proprietário dele.
     */
    existente.ownerId =
      clientId;

    console.log(
      "Atendimento atualizado:",
      recordId
    );

  }else{

    pendentes.set(
      recordId,
      {
        recordId,
        record:registro,
        sentAt:
          registro.enviadoEm ||
          new Date().toISOString(),
        ownerId:
          clientId
      }
    );

    console.log(
      "Novo atendimento pendente:",
      recordId
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
   * Envia para todas as Mesas conectadas.
   */
  const mesas =
    enviarParaMesas(
      atendimento
    );

  /*
   * Retorna confirmação técnica para o GUICHÊ.
   */
  enviar(
    ws,
    {
      type:
        "send_result",

      recordId,

      ok:true,

      mesasConectadas:
        mesas
    }
  );

}

/* ============================================================
   MESA CONFIRMA RECEBIMENTO
============================================================ */

function processarConfirmacaoMesa(
  ws,
  clientId,
  mensagem
){

  const recordId =
    mensagem.recordId;

  if(!recordId){

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

  /*
   * Procura o atendimento pendente.
   */
  const item =
    pendentes.get(
      recordId
    );

  /*
   * Caso não esteja mais no servidor,
   * pode ser uma confirmação repetida.
   */
  if(!item){

    enviar(
      ws,
      {
        type:
          "confirm_result",

        recordId,

        ok:false,

        message:
          "Atendimento já confirmado ou não encontrado."
      }
    );

    return;
  }

  const receivedAt =
    mensagem.receivedAt ||
    new Date().toISOString();

  /*
   * Atualiza o registro antes de enviá-lo.
   */
  item.record = {
    ...item.record,

    status:
      "recebido",

    recebidoEm:
      receivedAt
  };

  /*
   * Confirmação para o GUICHÊ que originalmente
   * enviou o cadastro.
   */
  const sender =
    clientes.get(
      item.ownerId
    );

  enviar(
    sender?.ws,
    {
      type:
        "record_received",

      recordId,

      receivedAt
    }
  );

  /*
   * Também avisa outras Mesas conectadas,
   * evitando que uma segunda Mesa continue tratando
   * o mesmo cadastro.
   */
  enviarParaMesas(
    {
      type:
        "record_received",

      recordId,

      receivedAt
    },
    ws
  );

  /*
   * Agora o atendimento deixa de ser pendente.
   */
  pendentes.delete(
    recordId
  );

  /*
   * Confirma para a própria Mesa.
   */
  enviar(
    ws,
    {
      type:
        "confirm_result",

      recordId,

      ok:true,

      receivedAt
    }
  );

  console.log(
    "Atendimento recebido pela Mesa:",
    recordId
  );

}

/* ============================================================
   MESA RECUSA ATENDIMENTO
============================================================ */

function processarRecusaMesa(
  ws,
  clientId,
  mensagem
){

  const recordId =
    mensagem.recordId;

  if(!recordId){

    enviar(
      ws,
      {
        type:
          "error",

        message:
          "Recusa sem recordId."
      }
    );

    return;
  }

  /*
   * Procura o cadastro que estava aguardando
   * recebimento pela Mesa.
   */
  const item =
    pendentes.get(
      recordId
    );

  /*
   * Se não estiver mais pendente, pode ser uma
   * recusa repetida ou uma mensagem atrasada.
   */
  if(!item){

    enviar(
      ws,
      {
        type:
          "refuse_result",

        recordId,

        ok:false,

        message:
          "Atendimento não está mais pendente no servidor."
      }
    );

    return;
  }

  const recusadoEm =
    mensagem.refusedAt ||
    new Date().toISOString();

  const motivo =
    String(
      mensagem.reason ||
      mensagem.record?.motivoRecusa ||
      "Motivo não informado."
    ).trim();

  /*
   * Atualiza o registro com a recusa.
   */
  const registroRecusado = {

    ...item.record,

    ...(mensagem.record || {}),

    recordId,

    status:
      "recusado",

    recusadoEm,

    motivoRecusa:
      motivo,

    recebidoEm:
      null

  };

  /*
   * Mantemos o histórico das recusas.
   */
  let historicoRecusas =
    Array.isArray(
      registroRecusado.historicoRecusas
    )
      ? [
          ...registroRecusado.historicoRecusas
        ]
      : [];

  historicoRecusas.push({

    motivo,

    em:
      recusadoEm,

    origem:
      "MESA"

  });

  registroRecusado.historicoRecusas =
    historicoRecusas;

  /*
   * Descobre o GUICHÊ que enviou originalmente.
   */
  const sender =
    clientes.get(
      item.ownerId
    );

  /*
   * Mensagem enviada ao GUICHÊ.
   *
   * Esta é a parte que faz:
   *
   * MESA -> SERVIDOR -> GUICHÊ
   */
  const mensagemRecusa = {

    type:
      "record_refused",

    recordId,

    record:
      registroRecusado,

    refusedAt:
      recusadoEm,

    reason:
      motivo

  };

  const enviadoAoGuiche =
    enviar(
      sender?.ws,
      mensagemRecusa
    );

  /*
   * Remove imediatamente dos pendentes.
   *
   * Portanto, o atendimento recusado deixa de aparecer
   * como pendente na Mesa e não será reenviado
   * automaticamente para a própria Mesa.
   */
  pendentes.delete(
    recordId
  );

  /*
   * Confirma tecnicamente para a Mesa.
   */
  enviar(
    ws,
    {
      type:
        "refuse_result",

      recordId,

      ok:
        true,

      sentToGuiche:
        enviadoAoGuiche,

      refusedAt:
        recusadoEm
    }
  );

  /*
   * Se o GUICHÊ estiver temporariamente desconectado,
   * não mantemos o cadastro na fila da Mesa.
   *
   * O GUICHÊ poderá receber novamente quando reconectar
   * somente se houver uma camada persistente externa.
   *
   * Por isso informamos no console para facilitar diagnóstico.
   */
  if(!enviadoAoGuiche){

    console.log(
      "GUICHÊ não estava conectado no momento da recusa:",
      recordId
    );

  }else{

    console.log(
      "Recusa enviada ao GUICHÊ:",
      recordId
    );

  }

}

/* ============================================================
   ROTA DE SAÚDE
============================================================ */

app.get(
  "/health",
  (_req,res)=>{

    let mesas = 0;
    let guiches = 0;

    for(
      const cliente
      of clientes.values()
    ){

      if(
        cliente.role ===
        "receiver"
      ){

        mesas++;

      }

      if(
        cliente.role ===
        "sender"
      ){

        guiches++;

      }

    }

    res.json({

      ok:true,

      version:
        "2.5.0",

      clients:
        clientes.size,

      mesasConectadas:
        mesas,

      guichesConectados:
        guiches,

      pendingRecords:
        pendentes.size,

      timestamp:
        new Date().toISOString()

    });

  }
);

/* ============================================================
   ROTA DE STATUS
============================================================ */

app.get(
  "/status",
  (_req,res)=>{

    const listaPendentes =
      [...pendentes.values()]
        .map(
          item=>({

            recordId:
              item.recordId,

            nome:
              item.record?.nome ||
              item.record?.nomeInterno ||
              "",

            atendimento:
              item.record?.atendimento ||
              "",

            sentAt:
              item.sentAt,

            ownerId:
              item.ownerId

          })
        );

    res.json({

      ok:true,

      version:
        "2.5.0",

      pendentes:
        listaPendentes

    });

  }
);

/* ============================================================
   TRATAMENTO DE ERROS HTTP
============================================================ */

app.use(
  (err,_req,res,_next)=>{

    console.error(
      "Erro HTTP:",
      err
    );

    res.status(500).json({

      ok:false,

      error:
        "Erro interno do servidor."

    });

  }
);

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

const PORT =
  process.env.PORT ||
  3000;

server.listen(
  PORT,
  "0.0.0.0",
  ()=>{
    
    console.log(
      "=========================================="
    );

    console.log(
      " SISTEMA DE ATENDIMENTO V2.5"
    );

    console.log(
      " Servidor iniciado na porta:",
      PORT
    );

    console.log(
      " GUICHÊ <-> SERVIDOR <-> MESA"
    );

    console.log(
      " Recusa MESA -> GUICHÊ habilitada"
    );

    console.log(
      " Reenvio GUICHÊ -> MESA habilitado"
    );

    console.log(
      "=========================================="
    );

  }
);
