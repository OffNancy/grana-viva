// netlify/functions/mp-webhook.js
//
// O que essa função faz:
// 1. O Mercado Pago avisa aqui toda vez que algo muda numa assinatura
//    (pagamento aprovado, pagamento recusado, assinatura pausada/cancelada).
// 2. A função descobre o e-mail de quem assinou e o UID dele no Firebase.
// 3. Ativa/bloqueia o login e grava o status no Firestore (usuarios/{uid}).
//
// REGRA DE TOLERÂNCIA (2 dias):
//   - Se uma cobrança recorrente for RECUSADA, a conta NÃO é bloqueada na hora.
//     Em vez disso, gravamos um prazo de 2 dias (bloqueioApos) no Firestore.
//   - Uma função separada (mp-check-bloqueios.js), que roda 1x por dia, verifica
//     quem passou desse prazo sem pagar e bloqueia o acesso nessa hora.
//   - Se o pagamento for aprovado antes do prazo, o período de graça é cancelado.
//   - Se o cliente CANCELAR ou PAUSAR a assinatura por vontade própria, o bloqueio
//     é imediato (não é uma cobrança em atraso, foi uma decisão do cliente).
//
// Variáveis de ambiente necessárias no Netlify (Site settings > Environment variables):
//   MP_ACCESS_TOKEN               -> Access Token de produção do Mercado Pago
//   FIREBASE_SERVICE_ACCOUNT_JSON -> conteúdo INTEIRO do JSON da conta de serviço do Firebase
//   MP_PLAN_ID_ECONOMISTA         -> (opcional) ID do plano "Modo Economista" no Mercado Pago.
//                                    Quando o preapproval_plan_id da assinatura for esse valor,
//                                    o campo "plano" do usuário é gravado como "economista".
//                                    Qualquer outro plano é gravado como "base".

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const DOIS_DIAS_MS = 2 * 24 * 60 * 60 * 1000;

async function buscarNaApiMP(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`Erro ao consultar Mercado Pago (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

// Ativa/desativa o LOGIN no Firebase Authentication. Retorna o UID do usuário.
async function definirAcesso(email, liberar) {
  const usuario = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(usuario.uid, { disabled: !liberar });
  console.log(`${liberar ? "✅ Liberado" : "⛔ Bloqueado"}: ${email} (uid: ${usuario.uid})`);
  return usuario.uid;
}

function planoParaId(planId) {
  const idEconomista = process.env.MP_PLAN_ID_ECONOMISTA;
  return idEconomista && planId === idEconomista ? "economista" : "base";
}

// Pagamento aprovado (ou assinatura autorizada/reativada): libera tudo e limpa a tolerância.
async function confirmarPagamento(uid, planId) {
  await db.collection("usuarios").doc(uid).set({
    plano: planoParaId(planId),
    bloqueado: false,
    renovacaoPendente: false,
    bloqueioApos: null,
  }, { merge: true });
}

// Cobrança recorrente recusada: NÃO bloqueia ainda, só marca o prazo de 2 dias.
async function iniciarPeriodoDeGraca(uid) {
  const bloqueioApos = Date.now() + DOIS_DIAS_MS;
  await db.collection("usuarios").doc(uid).set({
    renovacaoPendente: true,
    bloqueioApos,
  }, { merge: true });
  console.log(`⏳ Período de graça iniciado (uid ${uid}) — bloqueia em ${new Date(bloqueioApos).toISOString()} se não pagar antes`);
}

// Cancelamento/pausa voluntária ou assinatura nunca aprovada: bloqueia na hora.
async function bloquearAgora(uid) {
  await db.collection("usuarios").doc(uid).set({
    bloqueado: true,
    renovacaoPendente: false,
    bloqueioApos: null,
  }, { merge: true });
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
      return { statusCode: 200, body: "ok (sem dados pra processar)" };
    }

    if (tipo === "subscription_preapproval" || tipo === "preapproval") {
      // Mudança direta no status da assinatura (autorizada, pausada, cancelada...)
      const preapproval = await buscarNaApiMP(`https://api.mercadopago.com/preapproval/${id}`);
      const email = preapproval.payer_email;
      const status = preapproval.status;
      const planId = preapproval.preapproval_plan_id;
      if (!email || !status) return { statusCode: 200, body: "ok (sem e-mail ou status)" };

      if (status === "authorized") {
        const uid = await definirAcesso(email, true);
        await confirmarPagamento(uid, planId);
      } else if (status === "paused" || status === "cancelled" || status === "rejected") {
        const uid = await definirAcesso(email, false);
        await bloquearAgora(uid);
      }
      return { statusCode: 200, body: "ok" };
    }

    if (tipo === "subscription_authorized_payment") {
      // Uma cobrança recorrente aconteceu (aprovada ou recusada)
      const pagamento = await buscarNaApiMP(`https://api.mercadopago.com/authorized_payments/${id}`);
      const status = pagamento.status; // "approved", "rejected", etc.
      const preapprovalId = pagamento.preapproval_id;
      if (!preapprovalId) return { statusCode: 200, body: "ok (sem preapproval_id)" };

      const preapproval = await buscarNaApiMP(`https://api.mercadopago.com/preapproval/${preapprovalId}`);
      const email = preapproval.payer_email;
      const planId = preapproval.preapproval_plan_id;
      if (!email) return { statusCode: 200, body: "ok (sem e-mail)" };

      const usuario = await admin.auth().getUserByEmail(email);

      if (status === "approved") {
        // Pagamento em dia (ou renovou dentro do período de graça): garante acesso liberado.
        await admin.auth().updateUser(usuario.uid, { disabled: false });
        await confirmarPagamento(usuario.uid, planId);
        console.log(`✅ Pagamento aprovado: ${email}`);
      } else if (status === "rejected") {
        // Não bloqueia agora — só inicia a contagem dos 2 dias de tolerância.
        await iniciarPeriodoDeGraca(usuario.uid);
        console.log(`⚠️ Pagamento recusado, período de graça iniciado: ${email}`);
      }
      return { statusCode: 200, body: "ok" };
    }

    // Outros tipos de notificação (ex: pagamentos avulsos) — ignora
    return { statusCode: 200, body: "ok (tipo não tratado)" };
  } catch (erro) {
    console.error("Erro no webhook do Mercado Pago:", erro);
    // Retorna 200 mesmo em erro interno pra evitar retentativas infinitas do Mercado Pago;
    // o erro fica registrado no log do Netlify.
    return { statusCode: 200, body: "erro registrado no log" };
  }
};
