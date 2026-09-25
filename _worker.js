// _worker.js — API de rotación de técnicos (Cloudflare Worker + D1)
//
// Multi-sede: cada jornada, técnico y asignación va asociada a una sede.
// Sedes soportadas por defecto:
// - ramirez: Consejeria de Eco. Hac. y Empleo - Ramirez de Prado, 5 BIS
// - octubre: H.U 12 de Octubre - Gta. Málaga, 11

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

const SITE_DEFS = {
  ramirez: "Consejeria de Eco. Hac. y Empleo - Ramirez de Prado, 5 BIS",
  octubre: "H.U 12 de Octubre - Gta. Málaga, 11",
};
const DEFAULT_SITE_CODE = "ramirez";

function normalizeSiteCode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_SITE_CODE;
  if (raw.includes("octubre") || raw.includes("malaga") || raw === "h.u") return "octubre";
  if (raw.includes("ramirez") || raw.includes("prado") || raw.includes("eco") || raw.includes("empleo")) return "ramirez";
  return DEFAULT_SITE_CODE;
}

// NOTA: el esquema (tablas sites/technicians/jornadas/assignments con site_id)
// ya está migrado en D1 a mano con reset-multisede.sql, así que aquí no se
// vuelve a crear. IMPORTANTE: nunca se usa db.exec() con SQL en varias líneas
// -- D1 lo rechaza con "D1_EXEC_ERROR: incomplete input" -- por eso todo lo
// de aquí en adelante usa sentencias preparadas (prepare/bind), una por línea.

async function getSiteByCode(db, code) {
  const normalized = normalizeSiteCode(code);
  let site = await db
    .prepare("SELECT id, code, name FROM sites WHERE code = ?")
    .bind(normalized)
    .first();

  if (!site) {
    const now = new Date().toISOString();
    const name = SITE_DEFS[normalized] || normalized;
    await db
      .prepare("INSERT INTO sites (code, name, active, created_at) VALUES (?, ?, 1, ?)")
      .bind(normalized, name, now)
      .run();
    site = await db.prepare("SELECT id, code, name FROM sites WHERE code = ?").bind(normalized).first();
  }

  return site;
}

async function getSites(db) {
  const { results } = await db.prepare("SELECT id, code, name FROM sites ORDER BY name ASC").all();
  return results || [];
}

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

async function getTechs(db, siteId) {
  const { results } = await db
    .prepare("SELECT id, name, base_pos, active FROM technicians WHERE site_id = ? ORDER BY base_pos ASC, id ASC")
    .bind(siteId)
    .all();
  return results.map((t) => ({ ...t, active: !!t.active }));
}

async function getAssignments(db, jornadaId, siteId) {
  const { results } = await db
    .prepare(
      "SELECT id, seq, technician_id, note, created_at FROM assignments WHERE jornada_id = ? AND site_id = ? ORDER BY seq ASC"
    )
    .bind(jornadaId, siteId)
    .all();
  return results.map((a) => ({ ...a, note: a.note || "" }));
}

/** Técnico que atendió la última incidencia registrada en jornadas anteriores a jornadaId. */
async function lastAttendedBefore(db, jornadaId, siteId) {
  const row = await db
    .prepare(
      "SELECT technician_id FROM assignments WHERE jornada_id < ? AND site_id = ? ORDER BY jornada_id DESC, seq DESC LIMIT 1"
    )
    .bind(jornadaId, siteId)
    .first();
  return row ? row.technician_id : null;
}

/** Por dónde debe arrancar la jornada: el "siguiente" que dejó la jornada anterior. */
async function startFromPrevious(db, jornadaId, activeIds, siteId) {
  const prev = await db
    .prepare("SELECT * FROM jornadas WHERE id < ? AND site_id = ? ORDER BY id DESC LIMIT 1")
    .bind(jornadaId, siteId)
    .first();
  if (!prev) return null;
  const assignments = await getAssignments(db, prev.id, siteId);
  return nextFor(parseOrder(prev.order_json), assignments, activeIds);
}

async function insertJornada(db, order, manual, valid, siteId, guardMaxId = null) {
  const now = new Date().toISOString();
  const sql =
    guardMaxId === null
      ? "INSERT INTO jornadas (site_id, started_at, order_json, manual, valid) VALUES (?, ?, ?, ?, ?)"
      : "INSERT INTO jornadas (site_id, started_at, order_json, manual, valid) " +
        "SELECT ?, ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(id), 0) FROM jornadas WHERE site_id = ?) = ?";
  const stmt = db.prepare(sql);
  const bound =
    guardMaxId === null
      ? stmt.bind(siteId, now, JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0)
      : stmt.bind(siteId, now, JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0, siteId, guardMaxId);
  return bound.run();
}

async function ensureJornada(db, siteId) {
  let j = await db.prepare("SELECT * FROM jornadas WHERE site_id = ? ORDER BY id DESC LIMIT 1").bind(siteId).first();
  if (!j) {
    const techs = await getTechs(db, siteId);
    const order = buildOrder(techs, null);
    const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
    await insertJornada(db, order, false, isValid(order, activeIds, null), siteId);
    j = await db.prepare("SELECT * FROM jornadas WHERE site_id = ? ORDER BY id DESC LIMIT 1").bind(siteId).first();
  }
  return j;
}

async function saveOrder(db, jornadaId, order, manual, siteId) {
  const techs = await getTechs(db, siteId);
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
  const valid = isValid(order, activeIds, await lastAttendedBefore(db, jornadaId, siteId));
  await db
    .prepare("UPDATE jornadas SET order_json = ?, manual = ?, valid = ? WHERE id = ? AND site_id = ?")
    .bind(JSON.stringify(order), manual ? 1 : 0, valid ? 1 : 0, jornadaId, siteId)
    .run();
}

/** Estado completo que consume el frontend. */
async function loadState(db, siteId) {
  const jornada = await ensureJornada(db, siteId);
  const [techs, assignments] = await Promise.all([getTechs(db, siteId), getAssignments(db, jornada.id, siteId)]);
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
  const order = parseOrder(jornada.order_json);
  const nextId = nextFor(order, assignments, activeIds);
  const prevLast = await lastAttendedBefore(db, jornada.id, siteId);
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
async function syncOrder(db, siteId) {
  const j = await ensureJornada(db, siteId);
  const [techs, assignments] = await Promise.all([getTechs(db, siteId), getAssignments(db, j.id, siteId)]);
  const exists = new Set(techs.map((t) => t.id));
  const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));

  if (assignments.length === 0 && !j.manual) {
    const startId = await startFromPrevious(db, j.id, activeIds, siteId);
    await saveOrder(db, j.id, buildOrder(techs, startId), false, siteId);
    return;
  }

  let order = parseOrder(j.order_json).filter((id) => exists.has(id));
  if (assignments.length === 0) order = order.filter((id) => activeIds.has(id));
  for (const id of buildOrder(techs, null)) if (!order.includes(id)) order.push(id);
  await saveOrder(db, j.id, order, !!j.manual, siteId);
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

async function addIncident(db, note, siteId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const st = await loadState(db, siteId);
    if (!st.next) throw new HttpError(409, "No hay técnicos disponibles para asignar la incidencia.");
    const lastSeq = st.assignments.length ? st.assignments[st.assignments.length - 1].seq : 0;
    const res = await db
      .prepare(
        `INSERT INTO assignments (site_id, jornada_id, seq, technician_id, note, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE (SELECT COALESCE(MAX(seq), 0) FROM assignments WHERE jornada_id = ? AND site_id = ?) = ?`
      )
      .bind(
        siteId,
        st.jornada.id,
        lastSeq + 1,
        st.next.technician_id,
        note,
        new Date().toISOString(),
        st.jornada.id,
        siteId,
        lastSeq
      )
      .run();
    if (res.meta.changes === 1) return loadState(db, siteId);
  }
  throw new HttpError(409, "Se asignaron incidencias a la vez. Inténtalo de nuevo.");
}

async function undoIncident(db, siteId) {
  const j = await ensureJornada(db, siteId);
  const res = await db
    .prepare(
      `DELETE FROM assignments WHERE id = (
          SELECT id FROM assignments WHERE jornada_id = ? AND site_id = ? ORDER BY seq DESC LIMIT 1)`
    )
    .bind(j.id, siteId)
    .run();
  if (res.meta.changes === 0) throw new HttpError(409, "No hay incidencias que deshacer.");
  return loadState(db, siteId);
}

async function advanceDay(db, siteId) {
  const st = await loadState(db, siteId);
  const activeIds = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
  const order = buildOrder(st.technicians, st.next ? st.next.technician_id : null);
  const lastId = st.assignments.length
    ? st.assignments[st.assignments.length - 1].technician_id
    : await lastAttendedBefore(db, st.jornada.id, siteId);
  await insertJornada(db, order, false, isValid(order, activeIds, lastId), siteId, st.jornada.id);
  return loadState(db, siteId);
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

const RANGE_DAYS = { week: 7, month: 30, all: null };

const routes = {
  "GET /api/sites": async (db) => {
    const sites = await getSites(db);
    return { sites };
  },

  "GET /api/state": (db, req, url, site) => loadState(db, site.id),

  "POST /api/incidents": async (db, req, url, site) => {
    const body = await readBody(req);
    return addIncident(db, toText(body.note, { max: 120, label: "La nota" }), site.id);
  },

  "POST /api/incidents/undo": (db, req, url, site) => undoIncident(db, site.id),

  "POST /api/incidents/note": async (db, req, url, site) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const note = toText(body.note, { max: 120, label: "La nota" });
    const j = await ensureJornada(db, site.id);
    const res = await db
      .prepare("UPDATE assignments SET note = ? WHERE id = ? AND jornada_id = ? AND site_id = ?")
      .bind(note, id, j.id, site.id)
      .run();
    if (res.meta.changes === 0) throw new HttpError(404, "Incidencia no encontrada");
    return loadState(db, site.id);
  },

  "POST /api/jornada/advance": (db, req, url, site) => advanceDay(db, site.id),

  "POST /api/jornada/regenerate": async (db, req, url, site) => {
    const st = await loadState(db, site.id);
    if (st.locked) throw new HttpError(409, "El orden está fijado: ya hay incidencias asignadas.");
    const activeIds = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
    const startId = await startFromPrevious(db, st.jornada.id, activeIds, site.id);
    await saveOrder(db, st.jornada.id, buildOrder(st.technicians, startId), false, site.id);
    return loadState(db, site.id);
  },

  "POST /api/jornada/order": async (db, req, url, site) => {
    const body = await readBody(req);
    const st = await loadState(db, site.id);
    if (st.locked) throw new HttpError(409, "El orden está fijado: ya hay incidencias asignadas.");
    if (!Array.isArray(body.order)) throw new HttpError(400, "Orden no válido");
    const ids = body.order.map((v) => toId(v, "Técnico"));
    const active = new Set(st.technicians.filter((t) => t.active).map((t) => t.id));
    if (ids.length !== active.size || new Set(ids).size !== ids.length || !ids.every((i) => active.has(i))) {
      throw new HttpError(400, "El orden debe incluir exactamente a los técnicos disponibles.");
    }
    await saveOrder(db, st.jornada.id, ids, true, site.id);
    return loadState(db, site.id);
  },

  "POST /api/technicians/add": async (db, req, url, site) => {
    const body = await readBody(req);
    const name = toText(body.name, { max: 40, required: true, label: "El nombre" });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM technicians WHERE site_id = ?").bind(site.id).first();
    if (count.n >= 50) throw new HttpError(400, "Se alcanzó el máximo de técnicos (50).");
    await db
      .prepare(
        "INSERT INTO technicians (site_id, name, base_pos, active) " +
          "SELECT ?, ?, COALESCE(MAX(base_pos), 0) + 1, 1 FROM technicians WHERE site_id = ?"
      )
      .bind(site.id, name, site.id)
      .run();
    await syncOrder(db, site.id);
    return loadState(db, site.id);
  },

  "POST /api/technicians/toggle": async (db, req, url, site) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const res = await db
      .prepare("UPDATE technicians SET active = ? WHERE id = ? AND site_id = ?")
      .bind(body.active ? 1 : 0, id, site.id)
      .run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    await syncOrder(db, site.id);
    return loadState(db, site.id);
  },

  "POST /api/technicians/rename": async (db, req, url, site) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const name = toText(body.name, { max: 40, required: true, label: "El nombre" });
    const res = await db.prepare("UPDATE technicians SET name = ? WHERE id = ? AND site_id = ?").bind(name, id, site.id).run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    return loadState(db, site.id);
  },

  "POST /api/technicians/delete": async (db, req, url, site) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const res = await db.prepare("DELETE FROM technicians WHERE id = ? AND site_id = ?").bind(id, site.id).run();
    if (res.meta.changes === 0) throw new HttpError(404, "Técnico no encontrado");
    await syncOrder(db, site.id);
    return loadState(db, site.id);
  },

  "GET /api/ranking": async (db, req, url, site) => {
    const range = url.searchParams.get("range") || "week";
    if (!(range in RANGE_DAYS)) throw new HttpError(400, "Periodo no válido");
    const days = RANGE_DAYS[range];
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
    const { results } = await db
      .prepare(
        `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, COUNT(*) AS count
          FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
          WHERE a.site_id = ? ${since ? "AND a.created_at >= ?" : ""}
          GROUP BY a.technician_id ORDER BY count DESC, name ASC`
      )
      .bind(site.id, ...(since ? [since] : []))
      .all();
    return { range, total: results.reduce((s, r) => s + r.count, 0), ranking: results };
  },

  "GET /api/history": async (db, req, url, site) => {
    const [techs, { results }] = await Promise.all([
      getTechs(db, site.id),
      db
        .prepare(
          `SELECT j.id, j.started_at, j.order_json,
                  (SELECT COUNT(*) FROM assignments a WHERE a.jornada_id = j.id AND a.site_id = j.site_id) AS incidencias
            FROM jornadas j
            WHERE j.site_id = ?
            ORDER BY j.id DESC LIMIT 60`
        )
        .bind(site.id)
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

  "GET /api/jornada-detail": async (db, req, url, site) => {
    const id = toId(Number(url.searchParams.get("id")), "Jornada");
    const j = await db.prepare("SELECT id FROM jornadas WHERE id = ? AND site_id = ?").bind(id, site.id).first();
    if (!j) throw new HttpError(404, "Jornada no encontrada");
    const [{ results: breakdown }, { results: notes }] = await Promise.all([
      db
        .prepare(
          `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, COUNT(*) AS count
            FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
            WHERE a.jornada_id = ? AND a.site_id = ? GROUP BY a.technician_id ORDER BY count DESC, name ASC`
        )
        .bind(id, site.id)
        .all(),
      db
        .prepare(
          `SELECT a.technician_id, COALESCE(t.name, '(eliminado)') AS name, a.note, a.created_at
            FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
            WHERE a.jornada_id = ? AND a.site_id = ? AND a.note IS NOT NULL AND a.note != '' ORDER BY a.seq ASC`
        )
        .bind(id, site.id)
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

      const siteCode = normalizeSiteCode(url.searchParams.get("site") || url.searchParams.get("sede") || DEFAULT_SITE_CODE);
      const site = await getSiteByCode(env.DB, siteCode);

      // Solo se aceptan escrituras desde esta misma web (no desde otros sitios).
      const origin = request.headers.get("Origin");
      if (request.method !== "GET" && origin && origin !== url.origin) {
        throw new HttpError(403, "Origen no permitido");
      }

      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, "Ruta no encontrada");
      return json(await handler(env.DB, request, url, site));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Error en la API:", err);
      return json({ error: "Error interno del servidor" }, 500);
    }
  },
};
