// _worker.js — API de rotación de técnicos (Cloudflare Worker + D1)
//
// Tablas usadas: technicians, jornadas, assignments.
// (tecnicos e incidencias son de una versión anterior y ya no se usan.)

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// ---------------------------------------------------------------------------
// Reglas de rotación. Todo lo que decide "quién va primero" y "qué es válido"
// está en estas tres funciones para poder cambiarlo sin tocar el resto.
// ---------------------------------------------------------------------------

/** Siguiente técnico: el primer activo tras el último que atendió, girando sobre el orden. */
function nextFor(order, assignments, activeIds) {
  if (!order.length) return null;
  const lastId = assignments.length ? assignments[assignments.length - 1].technician_id : null;
  const start = lastId === null ? -1 : order.indexOf(lastId); // -1 => empieza por el primero
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length];
    if (activeIds.has(id)) return id;
  }
  return null;
}

/** Orden del día: técnicos activos por base_pos, rotados para que empiece startId. */
function buildOrder(techs, startId) {
  const base = techs
    .filter((t) => t.active)
    .sort((a, b) => a.base_pos - b.base_pos || a.id - b.id)
    .map((t) => t.id);
  const i = base.indexOf(startId);
  return i > 0 ? [...base.slice(i), ...base.slice(0, i)] : base;
}

/**
 * Regla del primero/último (SUPUESTO — ajústala a tu regla real):
 * hace falta al menos 2 técnicos activos y el primero de hoy no puede ser
 * quien atendió la última incidencia registrada antes de esta jornada.
 */
function isValid(order, activeIds, prevLastId) {
  const active = order.filter((id) => activeIds.has(id));
  if (active.length < 2) return false;
  return active[0] !== prevLastId;
}

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------

function parseOrder(text) {
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

async function getTechs(db) {
  const { results } = await db
    .prepare("SELECT id, name, base_pos, active FROM technicians ORDER BY base_pos ASC, id ASC")
    .all();
  return results.map((t) => ({ ...t, active: !!t.active }));
}

async function getAssignments(db, jornadaId) {
  const { results } = await db
    .prepare(
      "SELECT id, seq, technician_id, note, created_at FROM assignments WHERE jornada_id = ? ORDER BY seq ASC"
    )
    .bind(jornadaId)
    .all();
  return results.map((a) => ({ ...a, note: a.note || "" }));
}

/** Técnico que atendió la última incidencia registrada en jornadas anteriores a jornadaId. */
async function lastAttendedBefore(db, jornadaId) {
  const row = await db
    .prepare(
      "SELECT technician_id FROM assignments WHERE jornada_id < ? ORDER BY jornada_id DESC, seq DESC LIMIT 1"
    )
    .bind(jornadaId)
    .first();
  return row ? row.technician_id : null;
}

/** Por dónde debe arrancar la jornada: el "siguiente" que dejó la jornada anterior. */
async function startFromPrevious(db, jornadaId, activeIds) {
  const prev = await db
    .prepare("SELECT * FROM jornadas WHERE id < ? ORDER BY id DESC LIMIT 1")
    .bind(jornadaId)
    .first();
  if (!prev) return null;
  const assignments = await getAssignments(db, prev.id);
  return nextFor(parseOrder(prev.order_json), assignments, activeIds);
}

async function insertJornada(db, order, manual, valid, guardMaxId = null) {
  const now = new Date().toISOString();
  const sql =
    guardMaxId === null
      ? "INSERT INTO jornadas (started_at, order_json, manual, valid) VALUES (?, ?, ?, ?)"
      : // solo inserta si nadie creó otra jornada mientras tanto (evita doble "Nuevo día")
        "INSERT INTO jornadas (started_at, order_json, manual, valid) " +
        "SELECT ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(id), 0) FROM jornadas) = ?";
  const stmt = db.prepare(sql);
  const bound =
    guardMaxId === null
      ? stmt.bind(now, JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0)
      : stmt.bind(now, JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0, guardMaxId);
  return bound.run();
}

async function ensureJornada(db) {
  let j = await db.prepare("SELECT * FROM jornadas ORDER BY id DESC LIMIT 1").first();
  if (!j) {
    const techs = await getTechs(db);
    const order = buildOrder(techs, null);
    const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
    await insertJornada(db, order, false, isValid(order, activeIds, null));
    j = await db.prepare("SELECT * FROM jornadas ORDER BY id DESC LIMIT 1").first();
  }
  return j;
}

async function saveOrder(db, jornadaId, order, manual) {
  const techs = await getTechs(db);
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
  const valid = isValid(order, activeIds, await lastAttendedBefore(db, jornadaId));
  await db
    .prepare("UPDATE jornadas SET order_json = ?, manual = ?, valid = ? WHERE id = ?")
    .bind(JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0, jornadaId)
    .run();
}

/** Estado completo que consume el frontend. */
async function loadState(db) {
  const jornada = await ensureJornada(db);
  const [techs, assignments] = await Promise.all([getTechs(db), getAssignments(db, jornada.id)]);
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
  const order = parseOrder(jornada.order_json);
  const nextId = nextFor(order, assignments, activeIds);
  const prevLast = await lastAttendedBefore(db, jornada.id);
  return {
    jornada: { id: jornada.id, started_at: jornada.started_at },
    order,
    next: nextId === null ? null : { technician_id: nextId },
    technicians: techs,
    assignments,
    valid: isValid(order, activeIds, prevLast),
    manual: !!jornada.manual,
    locked: assignments.length > 0,
  };
}

/** Recoloca el orden de la jornada actual tras añadir, borrar o activar/desactivar técnicos. */
async function syncOrder(db) {
  const j = await ensureJornada(db);
  const [techs, assignments] = await Promise.all([getTechs(db), getAssignments(db, j.id)]);
  const exists = new Set(techs.map((t) => t.id));
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));

  if (assignments.length === 0 && !j.manual) {
    const startId = await startFromPrevious(db, j.id, activeIds);
    await saveOrder(db, j.id, buildOrder(techs, startId), false);
    return;
  }

  let order = parseOrder(j.order_json).filter((id) => exists.has(id));
  if (assignments.length === 0) order = order.filter((id) => activeIds.has(id));
  for (const id of buildOrder(techs, null)) if (!order.includes(id)) order.push(id);
  await saveOrder(db, j.id, order, !!j.manual);
}

// ---------------------------------------------------------------------------
// Validación de entrada
// ---------------------------------------------------------------------------

function toId(value, label = "id") {
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, `${label} no válido`);
  return value;
}

function toText(value, { max, required = false, label }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new HttpError(400, `${label} no puede estar vacío`);
  if (text.length > max) throw new HttpError(400, `${label} no puede superar ${max} caracteres`);
  return text;
}

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

async function addIncident(db, note) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const st = await loadState(db);
    if (!st.next) throw new HttpError(409, "No hay técnicos disponibles para asignar la incidencia.");
    const lastSeq = st.assignments.length ? st.assignments[st.assignments.length - 1].seq : 0;
    // Inserción condicionada: solo entra si nadie asignó otra incidencia entre la lectura y la escritura.
    const res = await db
      .prepare(
        `INSERT INTO assignments (jornada_id, seq, technician_id, note, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COALESCE(MAX(seq), 0) FROM assignments WHERE jornada_id = ?) = ?`
      )
      .bind(
        st.jornada.id, lastSeq + 1, st.next.technician_id, note, new Date().toISOString(),
        st.jornada.id, lastSeq
      )
      .run();
    if (res.meta.changes === 1) return loadState(db);
  }
  throw new HttpError(409, "Se asignaron incidencias a la vez. Inténtalo de nuevo.");
}

async function undoIncident(db) {
  const j = await ensureJornada(db);
  const res = await db
    .prepare(
      `DELETE FROM assignments WHERE id = (
         SELECT id FROM assignments WHERE jornada_id = ? ORDER BY seq DESC LIMIT 1)`
    )
    .bind(j.id)
    .run();
  if (res.meta.changes === 0) throw new HttpError(409, "No hay incidencias que deshacer.");
  return loadState(db);
}

async function advanceDay(db) {
  const st = await loadState(db);
  const activeIds = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
  const order = buildOrder(st.technicians, st.next ? st.next.technician_id : null);
  const lastId = st.assignments.length
    ? st.assignments[st.assignments.length - 1].technician_id
    : await lastAttendedBefore(db, st.jornada.id);
  await insertJornada(db, order, false, isValid(order, activeIds, lastId), st.jornada.id);
  return loadState(db);
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

const RANGE_DAYS = { week: 7, month: 30, all: null };

const routes = {
  "GET /api/state": (db) => loadState(db),

  "POST /api/incidents": async (db, req) => {
    const body = await readBody(req);
    return addIncident(db, toText(body.note, { max: 120, label: "La nota" }));
  },

  "POST /api/incidents/undo": (db) => undoIncident(db),

  "POST /api/incidents/note": async (db, req) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const note = toText(body.note, { max: 120, label: "La nota" });
    const j = await ensureJornada(db);
    const res = await db
      .prepare("UPDATE assignments SET note = ? WHERE id = ? AND jornada_id = ?")
      .bind(note, id, j.id)
      .run();
    if (res.meta.changes === 0) throw new HttpError(404, "Incidencia no encontrada");
    return loadState(db);
  },

  "POST /api/jornada/advance": (db) => advanceDay(db),

  "POST /api/jornada/regenerate": async (db) => {
    const st = await loadState(db);
    if (st.locked) throw new HttpError(409, "El orden está fijado: ya hay incidencias asignadas.");
    const activeIds = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
    const startId = await startFromPrevious(db, st.jornada.id, activeIds);
    await saveOrder(db, st.jornada.id, buildOrder(st.technicians, startId), false);
    return loadState(db);
  },

  "POST /api/jornada/order": async (db, req) => {
    const body = await readBody(req);
    const st = await loadState(db);
    if (st.locked) throw new HttpError(409, "El orden está fijado: ya hay incidencias asignadas.");
    if (!Array.isArray(body.order)) throw new HttpError(400, "Orden no válido");
    const ids = body.order.map((v) => toId(v, "Técnico"));
    const active = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
    if (ids.length !== active.size || new Set(ids).size !== ids.length || !ids.every((i) => active.has(i))) {
      throw new HttpError(400, "El orden debe incluir exactamente a los técnicos disponibles.");
    }
    await saveOrder(db, st.jornada.id, ids, true);
    return loadState(db);
  },

  "POST /api/technicians/add": async (db, req) => {
    const body = await readBody(req);
    const name = toText(body.name, { max: 40, required: true, label: "El nombre" });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM technicians").first();
    if (count.n >= 50) throw new HttpError(400, "Se alcanzó el máximo de técnicos (50).");
    await db
      .prepare(
        "INSERT INTO technicians (name, base_pos, active) " +
          "SELECT ?, COALESCE(MAX(base_pos), 0) + 1, 1 FROM technicians"
      )
      .bind(name)
      .run();
    await syncOrder(db);
    return loadState(db);
  },

  "POST /api/technicians/toggle": async (db, req) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const res = await db
      .prepare("UPDATE technicians SET active = ? WHERE id = ?")
      .bind(body.active ? 1 : 0, id)
      .run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    await syncOrder(db);
    return loadState(db);
  },

  "POST /api/technicians/rename": async (db, req) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const name = toText(body.name, { max: 40, required: true, label: "El nombre" });
    const res = await db.prepare("UPDATE technicians SET name = ? WHERE id = ?").bind(name, id).run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    return loadState(db);
  },

  "POST /api/technicians/delete": async (db, req) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const res = await db.prepare("DELETE FROM technicians WHERE id = ?").bind(id).run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    await syncOrder(db);
    return loadState(db);
  },

  "GET /api/ranking": async (db, req, url) => {
    const range = url.searchParams.get("range") || "week";
    if (!(range in RANGE_DAYS)) throw new HttpError(400, "Periodo no válido");
    const days = RANGE_DAYS[range];
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
    const { results } = await db
      .prepare(
        `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, COUNT(*) AS count
         FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
         ${since ? "WHERE a.created_at >= ?" : ""}
         GROUP BY a.technician_id ORDER BY count DESC, name ASC`
      )
      .bind(...(since ? [since] : []))
      .all();
    return { range, total: results.reduce((s, r) => s + r.count, 0), ranking: results };
  },

  "GET /api/history": async (db) => {
    const [techs, { results }] = await Promise.all([
      getTechs(db),
      db
        .prepare(
          `SELECT j.id, j.started_at, j.order_json,
                  (SELECT COUNT(*) FROM assignments a WHERE a.jornada_id = j.id) AS incidencias
           FROM jornadas j ORDER BY j.id DESC LIMIT 60`
        )
        .all(),
    ]);
    const names = new Map(techs.map((t) => [t.id, t.name]));
    return {
      history: results.map((j) => ({
        id: j.id,
        started_at: j.started_at,
        incidencias: j.incidencias,
        order: parseOrder(j.order_json).map((id) => names.get(id) || "(eliminado)"),
      })),
    };
  },

  "GET /api/jornada-detail": async (db, req, url) => {
    const id = toId(Number(url.searchParams.get("id")), "Jornada");
    const j = await db.prepare("SELECT id FROM jornadas WHERE id = ?").bind(id).first();
    if (!j) throw new HttpError(404, "Jornada no encontrada");
    const [{ results: breakdown }, { results: notes }] = await Promise.all([
      db
        .prepare(
          `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, COUNT(*) AS count
           FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
           WHERE a.jornada_id = ? GROUP BY a.technician_id ORDER BY count DESC, name ASC`
        )
        .bind(id)
        .all(),
      db
        .prepare(
          `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, a.note, a.created_at
           FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
           WHERE a.jornada_id = ? AND a.note IS NOT NULL AND a.note != '' ORDER BY a.seq ASC`
        )
        .bind(id)
        .all(),
    ]);
    return { total: breakdown.reduce((s, r) => s + r.count, 0), breakdown, notes };
  },
};

// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (!env.DB) throw new HttpError(500, "Base de datos D1 no vinculada (DB)");

      // Solo se aceptan escrituras desde esta misma web (no desde otros sitios).
      const origin = request.headers.get("Origin");
      if (request.method !== "GET" && origin && origin !== url.origin) {
        throw new HttpError(403, "Origen no permitido");
      }

      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, "Ruta no encontrada");
      return json(await handler(env.DB, request, url));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Error en la API:", err); // el detalle queda en los logs, no en la respuesta
      return json({ error: "Error interno del servidor" }, 500);
    }
  },
};
