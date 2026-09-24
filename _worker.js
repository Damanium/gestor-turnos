export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Interceptar las peticiones de la API
    if (url.pathname.startsWith('/api/')) {
      const db = env.DB;
      if (!db) {
        return new Response(JSON.stringify({ error: "Base de datos D1 no vinculada (DB)" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      const headers = { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*" 
      };

      try {
        // GET /api/tecnicos -> Obtener la lista de técnicos
        if (url.pathname === '/api/tecnicos' && request.method === 'GET') {
          const { results } = await db.prepare("SELECT * FROM tecnicos ORDER BY orden ASC").all();
          return new Response(JSON.stringify(results), { headers });
        }

        // POST /api/tecnicos -> Añadir, editar o cambiar turno de técnico
        if (url.pathname === '/api/tecnicos' && request.method === 'POST') {
          const body = await request.json();

          if (body.action === 'add') {
            await db.prepare("INSERT INTO tecnicos (nombre, orden, es_turno_actual) VALUES (?, ?, 0)")
                    .bind(body.nombre, body.orden || 99).run();
          } else if (body.action === 'set_turno') {
            await db.prepare("UPDATE tecnicos SET es_turno_actual = 0").run();
            await db.prepare("UPDATE tecnicos SET es_turno_actual = 1 WHERE id = ?").bind(body.id).run();
          } else if (body.action === 'delete') {
            await db.prepare("DELETE FROM tecnicos WHERE id = ?").bind(body.id).run();
          }

          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // GET /api/incidencias -> Lista de incidencias
        if (url.pathname === '/api/incidencias' && request.method === 'GET') {
          const { results } = await db.prepare(`
            SELECT i.*, t.nombre as tecnico_nombre 
            FROM incidencias i 
            LEFT JOIN tecnicos t ON i.tecnico_id = t.id 
            ORDER BY i.fecha DESC
          `).all();
          return new Response(JSON.stringify(results), { headers });
        }

        // POST /api/incidencias -> Registrar incidencia y sumar al contador
        if (url.pathname === '/api/incidencias' && request.method === 'POST') {
          const body = await request.json();
          await db.prepare("INSERT INTO incidencias (tecnico_id, nota) VALUES (?, ?)")
                  .bind(body.tecnico_id, body.nota || "").run();
          await db.prepare("UPDATE tecnicos SET incidencias_totales = incidencias_totales + 1 WHERE id = ?")
                  .bind(body.tecnico_id).run();

          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // GET /api/ranking -> Ranking de incidencias
        if (url.pathname === '/api/ranking' && request.method === 'GET') {
          const { results } = await db.prepare("SELECT nombre, incidencias_totales FROM tecnicos ORDER BY incidencias_totales DESC").all();
          return new Response(JSON.stringify(results), { headers });
        }

        return new Response(JSON.stringify({ error: "Ruta no encontrada" }), { status: 404, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    // Servir la interfaz y recursos estáticos (HTML, CSS, JS)
    return env.ASSETS.fetch(request);
  }
};
