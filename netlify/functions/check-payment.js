// Netlify Function: check-payment
// Appelé depuis payment-return.html pour vérifier le statut d'un paiement Mollie.
// Si status === 'paid', crée un lead CRM dans Odoo (avec déduplication par Mollie ID).
// GET /.netlify/functions/check-payment?id=tr_xxxx

const ODOO_URL = 'https://kunda.odoo.com';
const ODOO_DB  = 'kunda';

// ─── Odoo helpers ────────────────────────────────────────────────────────────

async function getOdooSession() {
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: {
        db: ODOO_DB,
        login: process.env.ODOO_USER,
        password: process.env.ODOO_API_KEY,
      },
    }),
  });
  const data = await res.json();
  if (!data.result?.uid)
    throw new Error(`Auth Odoo échouée: ${JSON.stringify(data.error || data)}`);
  const cookie = res.headers.get('set-cookie') || '';
  const match  = cookie.match(/session_id=([^;,\s]+)/);
  if (!match) throw new Error('session_id Odoo introuvable');
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
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  if (data.error)
    throw new Error(`Odoo RPC [${model}.${method}]: ${JSON.stringify(data.error.data?.message || data.error)}`);
  return data.result;
}

async function getOrCreateTag(sessionId, tagName) {
  const existing = await odooCall(
    sessionId, 'crm.tag', 'search_read',
    [[['name', '=', tagName]]],
    { fields: ['id'], limit: 1 }
  );
  if (existing?.length > 0) return existing[0].id;
  console.log(`Tag "${tagName}" introuvable — création…`);
  const newId = await odooCall(sessionId, 'crm.tag', 'create', [{ name: tagName }]);
  console.log(`Tag "${tagName}" créé avec ID ${newId}`);
  return newId;
}

async function createOdooLeadIfNeeded(payment, paymentId) {
  const { name, email, eventTitle, eventDate, price } = payment.metadata || {};
  if (!email) {
    console.warn('Métadonnées manquantes sur le paiement', paymentId);
    return;
  }

  const { sessionId } = await getOdooSession();

  // Déduplication : on vérifie si un lead existe déjà pour ce Mollie ID
  const existing = await odooCall(
    sessionId, 'crm.lead', 'search',
    [[['description', 'like', paymentId]]],
    { limit: 1 }
  );
  if (existing?.length > 0) {
    console.log(`Lead déjà existant pour ${paymentId} — skip.`);
    return;
  }

  const tagId  = await getOrCreateTag(sessionId, 'TRIBU-M');
  const leadId = await odooCall(sessionId, 'crm.lead', 'create', [{
    name: `[TRIBU-M] ${eventTitle} — ${name}`,
    contact_name: name,
    email_from:   email,
    description: [
      `Événement : ${eventTitle}`,
      `Date      : ${eventDate}`,
      `Montant   : ${price} €`,
      `Mollie ID : ${paymentId}`,
      `Payé le   : ${new Date().toLocaleString('fr-BE', { timeZone: 'Europe/Brussels' })}`,
    ].join('\n'),
    tag_ids: [[4, tagId]],
  }]);

  console.log(`✅ Lead Odoo créé — ID ${leadId} | ${email} | ${eventTitle}`);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const paymentId = event.queryStringParameters?.id;
  if (!paymentId) {
    return { statusCode: 400, headers, body: JSON.stringify({ status: 'unknown' }) };
  }

  try {
    const res = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await res.json();

    // Si payé → créer le lead Odoo (déduplication incluse)
    if (payment.status === 'paid') {
      try {
        await createOdooLeadIfNeeded(payment, paymentId);
      } catch (err) {
        // Ne pas bloquer la confirmation utilisateur si Odoo échoue
        console.error('Odoo lead creation error:', err.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status:     payment.status,
        eventTitle: payment.metadata?.eventTitle || '',
        eventDate:  payment.metadata?.eventDate  || '',
        name:       payment.metadata?.name       || '',
        email:      payment.metadata?.email      || '',
        amount:     payment.amount?.value        || '',
      }),
    };
  } catch (err) {
    console.error('check-payment error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ status: 'error' }) };
  }
};
