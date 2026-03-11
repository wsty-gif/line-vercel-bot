export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return new Response('OK', { status: 200 });
    }

    if (request.method === 'POST') {
      return new Response(
        JSON.stringify({ ok: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
}