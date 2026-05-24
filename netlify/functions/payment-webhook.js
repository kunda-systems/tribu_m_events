// Netlify Function: payment-webhook
// Appelé par Mollie lors d'un changement de statut de paiement.
// Vérifie le paiement, puis crée un lead CRM dans Odoo KUNDA avec le tag TRIBU-M.

const ODOO_URL = 'https://kunda.odoo.com';
const ODOO_DB = 'kunda';

// ─── Odoo helpers ────────────────────────────────────────────────────────────

async function getOdooSession() {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: 1,
      params: {
        db: ODOO_DB,
        login: process.env.ODOO_USER,   // email du compte Odoo qui a créé la clé API
        password: process.env.ODOO_API_KEY,
      },
    }),
  });

  const data = await res.json();

  if (!data.result?.uid) {
    throw new Error(`Authentification Odoo échouée: ${JSON.stringify(data.error || data)}`);
  }

  // Extraire le session_id du header Set-Cookie
  const cookie = res.headers.get('set-cookie') || '';
  const match = cookie.match(/session_id=([^;,\s]+)/);
  if (!match) throw new Error('session_id Odoo introuvable dans la réponse');

  return { uid: data.result.uid, sessionId: match[1] };
}

async function odooCall(sessionId, model, method, args, kwargs = {}) {
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session_id=${sessionId}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: 1,
      params: { model, method, args, kwargs },
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Odoo RPC error [${model}.${method}]: ${JSON.stringify(data.error.data?.message || data.error)}`);
  return data.result;
}

async function getOrCreateTag(sessionId, tagName) {
  const existing = await odooCall(
    sessionId, 'crm.tag', 'search_read',
    [[['name', '=', tagName]]],
    { fields: ['id', 'name'], limit: 1 }
  );
  if (existing?.length > 0) return existing[0].id;

  console.log(`Tag "${tagName}" introuvable dans Odoo — création…`);
  const newId = await odooCall(sessionId, 'crm.tag', 'create', [{ name: tagName }]);
  console.log(`Tag "${tagName}" créé avec ID ${newId}`);
  return newId;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Mollie exige TOUJOURS une réponse HTTP 200, même en cas d'erreur
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'OK' };

    // Mollie envoie le paiement ID en form-urlencoded: id=tr_xxxx
    const params = new URLSearchParams(event.body || '');
    const paymentId = params.get('id');
    if (!paymentId) {
      console.warn('Webhook reçu sans payment ID');
      return { statusCode: 200, body: 'OK' };
    }

    // Vérifier le paiement auprès de Mollie
    const mollieRes = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await mollieRes.json();

    console.log(`Webhook Mollie — paiement ${paymentId} : ${payment.status}`);

    if (payment.status !== 'paid') {
      // Statuts possibles : open, canceled, expired, failed, pending — on ignore
      return { statusCode: 200, body: `Status: ${payment.status}` };
    }

    const { name, email, eventId, eventTitle, eventDate, price } = payment.metadata || {};

    if (!email) {
      console.error('Métadonnées Mollie manquantes sur le paiement', paymentId);
      return { statusCode: 200, body: 'OK — metadata missing' };
    }

    // ── Créer le lead CRM dans Odoo ──────────────────────────────────────────
    const { sessionId } = await getOdooSession();
    const tagId = await getOrCreateTag(sessionId, 'TRIBU-M');

    const leadId = await odooCall(sessionId, 'crm.lead', 'create', [{
      name: `[TRIBU-M] ${eventTitle} — ${name}`,
      contact_name: name,
      email_from: email,
      description: [
        `Événement : ${eventTitle}`,
        `Date      : ${eventDate}`,
        `Montant   : ${price} €`,
        `Mollie ID : ${paymentId}`,
        `Payé le   : ${new Date().toLocaleString('fr-BE', { timeZone: 'Europe/Brussels' })}`,
      ].join('\n'),
      tag_ids: [[4, tagId]],   // commande many2many Odoo : 4 = lier un enregistrement existant
    }]);

    console.log(`✅ Lead Odoo créé — ID ${leadId} | ${email} | ${eventTitle}`);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('payment-webhook error:', err.message);
    // On retourne 200 quand même pour éviter les retries Mollie en boucle
    return { statusCode: 200, body: 'OK — error logged' };
  }
};
