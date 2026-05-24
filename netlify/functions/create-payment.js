// Netlify Function: create-payment
// Reçoit les données du formulaire de réservation,
// crée un paiement Mollie et retourne l'URL de paiement.

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { name, email, eventId, eventTitle, eventDate, price } = JSON.parse(event.body || '{}');

    if (!name?.trim() || !email?.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nom et email requis.' }) };
    }

    const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
    // Netlify injecte automatiquement process.env.URL avec l'URL du site déployé
    const SITE_URL = process.env.URL || 'https://tribu-m.eu';

    const mollieRes = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MOLLIE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: {
          currency: 'EUR',
          value: parseFloat(price).toFixed(2),
        },
        description: `Tribu·M — ${eventTitle}`,
        redirectUrl: `${SITE_URL}/payment-return.html`,
        webhookUrl: `${SITE_URL}/.netlify/functions/payment-webhook`,
        metadata: {
          name: name.trim(),
          email: email.trim().toLowerCase(),
          eventId,
          eventTitle,
          eventDate,
          price: String(price),
        },
      }),
    });

    const payment = await mollieRes.json();

    if (!payment._links?.checkout?.href) {
      console.error('Mollie error:', JSON.stringify(payment));
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Impossible de créer le paiement. Réessaie ou contacte-nous.' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        checkoutUrl: payment._links.checkout.href,
        paymentId: payment.id,
      }),
    };

  } catch (err) {
    console.error('create-payment error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur. Réessaie dans quelques instants.' }),
    };
  }
};
