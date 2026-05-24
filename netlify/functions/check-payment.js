// Netlify Function: check-payment
// Appelé depuis payment-return.html pour vérifier le statut d'un paiement Mollie.
// Si status === 'paid', crée un lead CRM dans Odoo via REST API (Bearer token).
// GET /.netlify/functions/check-payment?id=tr_xxxx

const ODOO_URL = 'https://kunda.odoo.com';

// ─── Odoo REST API (Odoo 17 — Bearer token) ──────────────────────────────────

async function odooRest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.ODOO_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(`${ODOO_URL}${path}`, opts);
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 400) }; }

  if (!res.ok) {
    throw new Error(`Odoo REST [${method} ${path}] ${res.status}: ${JSON.stringify(data).substring(0, 400)}`);
  }
  return data;
}

async function getOrCreateTag(tagName) {
  const domain  = encodeURIComponent(JSON.stringify([['name', '=', tagName]]));
  const fields  = encodeURIComponent(JSON.stringify(['id']));
  const results = await odooRest(`/api/crm.tag?domain=${domain}&fields=${fields}&limit=1`);

  if (Array.isArray(results) && results.length > 0) return results[0].id;

  // Créer le tag s'il n'existe pas
  console.log(`Tag "${tagName}" introuvable — création…`);
  const newTag = await odooRest('/api/crm.tag', 'POST', { name: tagName });
  console.log(`Tag "${tagName}" créé :`, JSON.stringify(newTag));
  return newTag.id;
}

async function createOdooLeadIfNeeded(payment, paymentId) {
  const { name, email, eventTitle, eventDate, price } = payment.metadata || {};
  if (!email) {
    console.warn('Métadonnées Mollie manquantes sur', paymentId);
    return;
  }

  // Déduplication : vérifier si un lead existe déjà pour ce Mollie ID
  const dedupDomain = encodeURIComponent(JSON.stringify([['description', 'like', paymentId]]));
  const existing    = await odooRest(`/api/crm.lead?domain=${dedupDomain}&limit=1&fields=${encodeURIComponent(JSON.stringify(['id']))}`);
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`Lead déjà existant pour ${paymentId} — skip.`);
    return;
  }

  const tagId = await getOrCreateTag('TRIBU-M');

  const lead = await odooRest('/api/crm.lead', 'POST', {
    name:         `[TRIBU-M] ${eventTitle} — ${name}`,
    contact_name: name,
    email_from:   email,
    description:  [
      `Événement : ${eventTitle}`,
      `Date      : ${eventDate}`,
      `Montant   : ${price} €`,
      `Mollie ID : ${paymentId}`,
      `Payé le   : ${new Date().toLocaleString('fr-BE', { timeZone: 'Europe/Brussels' })}`,
    ].join('\n'),
    tag_ids: [{ id: tagId }],
  });

  console.log(`✅ Lead Odoo créé — ID ${lead?.id} | ${email} | ${eventTitle}`);
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
    const res     = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await res.json();

    // Si payé → créer le lead Odoo (déduplication incluse)
    if (payment.status === 'paid') {
      try {
        await createOdooLeadIfNeeded(payment, paymentId);
      } catch (err) {
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
