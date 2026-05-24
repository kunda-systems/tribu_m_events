// Netlify Function: check-payment
// Appelé depuis payment-return.html pour vérifier le statut d'un paiement Mollie.
// GET /.netlify/functions/check-payment?id=tr_xxxx

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: payment.status,           // paid | open | pending | canceled | expired | failed
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
