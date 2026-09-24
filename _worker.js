export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Intercepta las llamadas a la API
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Sirve los archivos estáticos (HTML, CSS, JS)
    return env.ASSETS.fetch(request);
  }
};