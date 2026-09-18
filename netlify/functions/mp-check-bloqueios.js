// netlify/functions/mp-check-bloqueios.js
//
// Função AGENDADA (roda 1x por dia sozinha — configuração no netlify.toml).
//
// O que ela faz:
// Procura no Firestore todo usuário que está em "período de graça"
// (renovacaoPendente: true) cujo prazo de 2 dias (bloqueioApos) já passou
// SEM que um novo pagamento tenha sido aprovado (o webhook já teria limpado
// esses campos se tivesse pago). Quem se encaixa nisso é bloqueado agora.
//
// Variáveis de ambiente necessárias (as mesmas do mp-webhook.js):
//   FIREBASE_SERVICE_ACCOUNT_JSON

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

exports.handler = async () => {
  try {
    const agora = Date.now();

    // Se o Firestore pedir pra criar um índice composto na primeira execução,
    // é só clicar no link que aparece no log de erro do Netlify — ele cria sozinho.
    const snap = await db.collection("usuarios")
      .where("renovacaoPendente", "==", true)
      .where("bloqueioApos", "<=", agora)
      .get();

    if (snap.empty) {
      return { statusCode: 200, body: "ok (nenhum bloqueio pendente hoje)" };
    }

    const resultados = [];
    for (const docSnap of snap.docs) {
      const uid = docSnap.id;
      try {
        await admin.auth().updateUser(uid, { disabled: true });
        await docSnap.ref.set({
          bloqueado: true,
          renovacaoPendente: false,
          bloqueioApos: null,
        }, { merge: true });
        resultados.push(`⛔ Bloqueado por falta de pagamento: uid ${uid}`);
      } catch (e) {
        resultados.push(`Erro ao bloquear uid ${uid}: ${e.message}`);
      }
    }

    console.log(resultados.join("\n"));
    return { statusCode: 200, body: resultados.join("\n") };
  } catch (erro) {
    console.error("Erro ao checar bloqueios pendentes:", erro);
    return { statusCode: 200, body: "erro registrado no log" };
  }
};
