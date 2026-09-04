// netlify/functions/mp-webhook.js
//
// O que essa função faz:
// 1. O Mercado Pago avisa aqui toda vez que algo muda numa assinatura
//    (pagamento aprovado, pagamento recusado, assinatura pausada/cancelada).
// 2. A função descobre o e-mail de quem assinou.
// 3. Acha o usuário correspondente no Firebase Authentication (mesmo e-mail).
// 4. Ativa (desbloqueia) ou desativa (bloqueia) o login dessa pessoa automaticamente.
//
// Variáveis de ambiente necessárias no Netlify (Site settings > Environment variables):
//   MP_ACCESS_TOKEN               -> Access Token de produção do Mercado Pago
//   FIREBASE_SERVICE_ACCOUNT_JSON -> o conteúdo INTEIRO do arquivo JSON da conta de
//                                    serviço do Firebase (gerado em Configurações do
//                                    projeto > Contas de serviço > Gerar nova chave privada),
//                                    colado como uma única linha de texto.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// Status do Mercado Pago que significam "pode usar o sistema"
const STATUS_LIBERA = ["authorized", "approved"];
// Status que significam "bloquear o acesso"
const STATUS_BLOQUEIA = ["paused", "cancelled", "rejected"];

async function buscarNaApiMP(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`Erro ao consultar Mercado Pago (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

async function definirAcesso(email, liberar) {
  const usuario = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(usuario.uid, { disabled: !liberar });
  console.log(`${liberar ? "✅ Liberado" : "⛔ Bloqueado"}: ${email} (uid: ${usuario.uid})`);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const tipo = body.type || body.topic;
    const id = body.data?.id || body.id;

    if (!tipo || !id) {
      // Mercado Pago às vezes manda um teste/ping vazio; só confirma recebido
      return { statusCode: 200, body: "ok (sem dados pra processar)" };
    }

    let payerEmail = null;
    let status = null;

    if (tipo === "subscription_preapproval" || tipo === "preapproval") {
      // Mudança direta no status da assinatura (ex: pausada, cancelada, autorizada)
      const preapproval = await buscarNaApiMP(`https://api.mercadopago.com/preapproval/${id}`);
      payerEmail = preapproval.payer_email;
      status = preapproval.status;
    } else if (tipo === "subscription_authorized_payment") {
      // Uma cobrança recorrente aconteceu (aprovada ou recusada)
      const pagamento = await buscarNaApiMP(`https://api.mercadopago.com/authorized_payments/${id}`);
      status = pagamento.status; // "approved", "rejected", etc.
      const preapprovalId = pagamento.preapproval_id;
      if (preapprovalId) {
        const preapproval = await buscarNaApiMP(`https://api.mercadopago.com/preapproval/${preapprovalId}`);
        payerEmail = preapproval.payer_email;
      }
    } else {
      // Outros tipos de notificação (ex: pagamentos avulsos) — ignora
      return { statusCode: 200, body: "ok (tipo não tratado)" };
    }

    if (!payerEmail || !status) {
      return { statusCode: 200, body: "ok (sem e-mail ou status pra agir)" };
    }

    if (STATUS_LIBERA.includes(status)) {
      await definirAcesso(payerEmail, true);
    } else if (STATUS_BLOQUEIA.includes(status)) {
      await definirAcesso(payerEmail, false);
    }

    return { statusCode: 200, body: "ok" };
  } catch (erro) {
    console.error("Erro no webhook do Mercado Pago:", erro);
    // Retorna 200 mesmo em erro interno pra evitar que o Mercado Pago fique retentando
    // o mesmo evento indefinidamente; o erro fica registrado no log do Netlify.
    return { statusCode: 200, body: "erro registrado no log" };
  }
};
