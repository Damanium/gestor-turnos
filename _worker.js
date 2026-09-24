export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
        // GET /api/technicians -> Obtener todos los técnicos ordenados por posición base
        if (url.pathname === '/api/technicians' && request.method === 'GET') {
          const { results } = await db.prepare("SELECT * FROM technicians ORDER BY base_pos ASC").all();
          return new Response(JSON.stringify(results), { headers });
        }

        // POST /api/technicians -> Crear, actualizar o cambiar estado (activo/vacaciones)
        if (url.pathname === '/api/technicians' && request.method === 'POST') {
          const body = await request.json();

          if (body.action === 'add') {
            await db.prepare("INSERT INTO technicians (name, base_pos, active) VALUES (?, ?, 1)")
                    .bind(body.name, body.base_pos || 1).run();
          } else if (body.action === 'toggle_active') {
            await db.prepare("UPDATE technicians SET active = ? WHERE id = ?")
                    .bind(body.active ? 1 : 0, body.id).run();
          } else if (body.action === 'delete') {
            await db.prepare("DELETE FROM technicians WHERE id = ?").bind(body.id).run();
          }

          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // GET /api/jornadas/current -> Obtener la última jornada abierta
        if (url.pathname === '/api/jornadas/current' && request.method === 'GET') {
          const { results } = await db.prepare("SELECT * FROM jornadas ORDER BY id DESC LIMIT 1").all();
          const currentJornada = results[0] || null;
          return new Response(JSON.stringify(currentJornada), { headers });
        }

        // POST /api/jornadas -> Crear una nueva jornada laboral
        if (url.pathname === '/api/jornadas' && request.method === 'POST') {
          const body = await request.json();
          const nowISO = new Date().toISOString();
          const orderJson = JSON.stringify(body.order || []);

          const res = await db.prepare(
            "INSERT INTO jornadas (started_at, order_json, manual, valid) VALUES (?, ?, ?, ?)"
          ).bind(nowISO, orderJson, body.manual ? 1 : 0, body.valid ? 1 : 0).run();

          return new Response(JSON.stringify({ success: true, id: res.meta.last_row_id }), { headers });
        }

        // GET /api/assignments -> Obtener incidencias de una jornada específica
        if (url.pathname === '/api/assignments' && request.method === 'GET') {
          const jornadaId = url.searchParams.get('jornada_id');
          if (!jornadaId) {
            return new Response(JSON.stringify({ error: "Falta jornada_id" }), { status: 400, headers });
          }

          const { results } = await db.prepare(`
            SELECT a.*, COALESCE(t.name, '(eliminado)') as technician_name
            FROM assignments a
            LEFT JOIN technicians t ON a.technician_id = t.id
            WHERE a.jornada_id = ?
            ORDER BY a.seq ASC
          `).bind(jornadaId).all();

          return new Response(JSON.stringify(results), { headers });
        }

        // POST /api/assignments -> Asignar una incidencia en la jornada activa
        if (url.pathname === '/api/assignments' && request.method === 'POST') {
          const body = await request.json();
          const nowISO = new Date().toISOString();

          // Obtener el número correlativo (seq) dentro de la misma jornada
          const seqRes = await db.prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM assignments WHERE jornada_id = ?"
          ).bind(body.jornada_id).first();

          const nextSeq = seqRes ? seqRes.next_seq : 1;

          await db.prepare(`
            INSERT INTO assignments (jornada_id, seq, technician_id, note, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(body.jornada_id, nextSeq, body.technician_id, body.note || "", nowISO).run();

          return new Response(JSON.stringify({ success: true, seq: nextSeq }), { headers });
        }

        // GET /api/ranking -> Estadísticas históricas de incidencias asignadas por técnico
        if (url.pathname === '/api/ranking' && request.method === 'GET') {
          const { results } = await db.prepare(`
            SELECT COALESCE(t.name, '(eliminado)') as name, COUNT(a.id) as total_assignments
            FROM assignments a
            LEFT JOIN technicians t ON a.technician_id = t.id
            GROUP BY a.technician_id
            ORDER BY total_assignments DESC
          `).all();

          return new Response(JSON.stringify(results), { headers });
        }

        return new Response(JSON.stringify({ error: "Ruta no encontrada" }), { status: 404, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    // Servir los archivos estáticos de la interfaz web
    return env.ASSETS.fetch(request);
  }
};
