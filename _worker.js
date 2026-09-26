// _worker.js — API de rotación de técnicos (Cloudflare Worker + D1)
//
// Multi-sede: cada jornada, técnico y asignación va asociada a una sede.
// Las sedes se crean y gestionan desde el panel de administración
// (/api/admin/sites*), no hay ninguna fija en el código.
//
// Acceso: cada sede tiene su propia contraseña (PBKDF2 + sal, en la tabla
// `sites`). Al hacer login se firma un token (HMAC-SHA256) válido 12h que
// hay que mandar como "Authorization: Bearer <token>" en cada llamada a
// /api/*. Hay un segundo login de administrador (contraseña en secrets de
// Cloudflare, no en D1) para /api/admin/*. Tras 3 fallos seguidos se
// bloquean los intentos 30s (por sede/admin + IP).

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

function normalizeSiteCode(value) {
  return String(value ?? "").trim().toLowerCase();
}

// NOTA: el esquema (tablas sites/technicians/jornadas/assignments con site_id)
// ya está migrado en D1 a mano con reset-multisede.sql, así que aquí no se
// vuelve a crear. IMPORTANTE: nunca se usa db.exec() con SQL en varias líneas
// -- D1 lo rechaza con "D1_EXEC_ERROR: incomplete input" -- por eso todo lo
// de aquí en adelante usa sentencias preparadas (prepare/bind), una por línea.

/** Busca una sede por código. Ya NO la crea si no existe: crearlas es cosa
 *  del panel de administración (ver adminRoutes.createSite). */
async function findSiteByCode(db, code) {
  const normalized = normalizeSiteCode(code);
  if (!normalized) return null;
  return db
    .prepare("SELECT id, code, name, active, password_hash, password_salt FROM sites WHERE code = ?")
    .bind(normalized)
    .first();
}

// ---------------------------------------------------------------------------
// Autenticación: contraseña por sede (PBKDF2) + token firmado (HMAC) + freno
// a fuerza bruta. Todo con Web Crypto, sin librerías externas.
// ---------------------------------------------------------------------------

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 horas
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_BLOCK_SECONDS = 30;
const PBKDF2_ITERATIONS = 100000;

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  return b64ToBytes(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
}
/** Comparación en tiempo constante para no filtrar por cuánto tarda la respuesta. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

/** Genera un hash + sal nuevos para una contraseña (al fijarla desde el panel de admin). */
async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, saltBytes);
  return { hash, salt: bytesToB64(saltBytes) };
}

/** Comprueba una contraseña contra el hash+sal guardados. */
async function verifyPassword(password, saltB64, hashB64) {
  if (!saltB64 || !hashB64) return false;
  const computed = await pbkdf2(password, b64ToBytes(saltB64));
  return timingSafeEqual(computed, hashB64);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Token: base64url(payload JSON) + "." + base64url(firma HMAC). Sin dependencias tipo JWT. */
async function signToken(payload, secret) {
  const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/** Devuelve el payload si el token es válido y no ha caducado; si no, null. */
async function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expectedSig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  if (!timingSafeEqual(sig, b64url(new Uint8Array(expectedSig)))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(data)));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

/** Corta el paso si ya hay demasiados fallos recientes para esta sede/admin + IP. */
async function assertNotBlocked(db, scope, ipHash) {
  const row = await db
    .prepare("SELECT blocked_until FROM login_attempts WHERE scope = ? AND ip_hash = ?")
    .bind(scope, ipHash)
    .first();
  if (row?.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) {
    throw new HttpError(429, "Demasiados intentos. Espera unos segundos y vuelve a intentarlo.");
  }
}

/** Registra el resultado de un intento de login: limpia el contador si acierta,
 *  lo sube y bloquea unos segundos si encadena MAX_LOGIN_ATTEMPTS fallos. */
async function recordLoginAttempt(db, scope, ipHash, success) {
  if (success) {
    await db.prepare("DELETE FROM login_attempts WHERE scope = ? AND ip_hash = ?").bind(scope, ipHash).run();
    return;
  }
  const row = await db
    .prepare("SELECT attempts FROM login_attempts WHERE scope = ? AND ip_hash = ?")
    .bind(scope, ipHash)
    .first();
  const attempts = (row?.attempts || 0) + 1;
  const blockedUntil =
    attempts >= MAX_LOGIN_ATTEMPTS ? new Date(Date.now() + LOGIN_BLOCK_SECONDS * 1000).toISOString() : null;
  await db
    .prepare(
      `INSERT INTO login_attempts (scope, ip_hash, attempts, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, ip_hash) DO UPDATE SET attempts = excluded.attempts,
         blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`
    )
    .bind(scope, ipHash, attempts, blockedUntil, new Date().toISOString())
    .run();
  if (blockedUntil) throw new HttpError(429, "Demasiados intentos. Espera unos segundos y vuelve a intentarlo.");
}

/** GET /api/sites (público): nunca expone password_hash/password_salt. */
async function listPublicSites(db) {
  const { results } = await db
    .prepare(
      "SELECT code, name, (password_hash IS NOT NULL) AS has_password FROM sites WHERE active = 1 ORDER BY name ASC"
    )
    .all();
  return { sites: (results || []).map((s) => ({ ...s, has_password: !!s.has_password })) };
}

/** POST /api/auth/login: { site, password } -> { token, expires_at, site } */
async function siteLogin(env, request) {
  const body = await readBody(request);
  const code = normalizeSiteCode(body.site);
  if (!code) throw new HttpError(400, "Falta indicar la sede");
  const password = typeof body.password === "string" ? body.password : "";
  const ipHash = await sha256Hex(clientIp(request) + ":" + code);

  await assertNotBlocked(env.DB, code, ipHash);
  const site = await findSiteByCode(env.DB, code);
  const valid = site && site.active && (await verifyPassword(password, site.password_salt, site.password_hash));
  await recordLoginAttempt(env.DB, code, ipHash, !!valid);
  if (!valid) throw new HttpError(401, "Sede o contraseña incorrectas");

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signToken({ site: site.code, exp }, env.TOKEN_SECRET);
  return { token, expires_at: exp * 1000, site: { code: site.code, name: site.name } };
}

/** POST /api/auth/admin-login: { password } -> { token, expires_at } */
async function adminLogin(env, request) {
  const body = await readBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  const ipHash = await sha256Hex(clientIp(request) + ":admin");

  await assertNotBlocked(env.DB, "admin", ipHash);
  const valid =
    !!env.ADMIN_PASSWORD_HASH &&
    !!env.ADMIN_PASSWORD_SALT &&
    (await verifyPassword(password, env.ADMIN_PASSWORD_SALT, env.ADMIN_PASSWORD_HASH));
  await recordLoginAttempt(env.DB, "admin", ipHash, valid);
  if (!valid) throw new HttpError(401, "Contraseña de administrador incorrecta");

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signToken({ admin: true, exp }, env.TOKEN_SECRET);
  return { token, expires_at: exp * 1000 };
}

/** Rutas del panel de administración (requieren token con admin:true). */
const adminRoutes = {
  "GET /api/admin/sites": async (db) => {
    const { results } = await db
      .prepare("SELECT code, name, active, (password_hash IS NOT NULL) AS has_password, updated_at FROM sites ORDER BY name ASC")
      .all();
    return { sites: (results || []).map((s) => ({ ...s, active: !!s.active, has_password: !!s.has_password })) };
  },

  "POST /api/admin/sites": async (db, req) => {
    const body = await readBody(req);
    const code = normalizeSiteCode(body.code);
    if (!code || !/^[a-z0-9_-]{2,40}$/.test(code)) {
      throw new HttpError(400, "El código de sede solo puede tener letras, números, guiones y guion bajo");
    }
    const name = toText(body.name, { max: 120, required: true, label: "El nombre de la sede" });
    const now = new Date().toISOString();
    try {
      await db
        .prepare("INSERT INTO sites (code, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .bind(code, name, now, now)
        .run();
    } catch {
      throw new HttpError(409, "Ya existe una sede con ese código");
    }
    return { site: { code, name, active: true, has_password: false } };
  },

  "POST /api/admin/sites/password": async (db, req) => {
    const body = await readBody(req);
    const code = normalizeSiteCode(body.site);
    const site = await findSiteByCode(db, code);
    if (!site) throw new HttpError(404, "Sede no encontrada");
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 6) throw new HttpError(400, "La contraseña debe tener al menos 6 caracteres");
    const { hash, salt } = await hashPassword(password);
    await db
      .prepare("UPDATE sites SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .bind(hash, salt, new Date().toISOString(), site.id)
      .run();
    return { ok: true };
  },

  "POST /api/admin/sites/toggle": async (db, req) => {
    const body = await readBody(req);
    const code = normalizeSiteCode(body.site);
    const site = await findSiteByCode(db, code);
    if (!site) throw new HttpError(404, "Sede no encontrada");
    await db
      .prepare("UPDATE sites SET active = ?, updated_at = ? WHERE id = ?")
      .bind(body.active ? 1 : 0, new Date().toISOString(), site.id)
      .run();
    return { ok: true };
  },

  /** Solo permite borrar sedes que nunca han tenido técnicos, para no perder
   *  historial de verdad: una sede ya usada se desactiva, no se elimina. */
  "POST /api/admin/sites/delete": async (db, req) => {
    const body = await readBody(req);
    const code = normalizeSiteCode(body.site);
    const site = await findSiteByCode(db, code);
    if (!site) throw new HttpError(404, "Sede no encontrada");
    const techCount = await db.prepare("SELECT COUNT(*) AS n FROM technicians WHERE site_id = ?").bind(site.id).first();
    if (techCount.n > 0) {
      throw new HttpError(
        409,
        "Esta sede tiene técnicos y/o historial: desactívala en vez de eliminarla, para no perder los datos."
      );
    }
    await db.prepare("DELETE FROM sites WHERE id = ?").bind(site.id).run();
    return { ok: true };
  },

  /** Resumen de todas las sedes a la vez, para el panel de administración. */
  "GET /api/admin/overview": async (db) => {
    const { results: sites } = await db.prepare("SELECT id, code, name, active FROM sites ORDER BY name ASC").all();
    const overview = [];
    for (const s of sites || []) {
      const [techCount, current, lastIncident] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM technicians WHERE site_id = ? AND active = 1").bind(s.id).first(),
        db.prepare("SELECT * FROM jornadas WHERE site_id = ? ORDER BY id DESC LIMIT 1").bind(s.id).first(),
        db.prepare("SELECT created_at FROM assignments WHERE site_id = ? ORDER BY created_at DESC LIMIT 1").bind(s.id).first(),
      ]);
      let siguiente = null;
      let incidenciasTurno = 0;
      let ordenValido = null;
      if (current) {
        const [techs, assignments] = await Promise.all([getTechs(db, s.id), getAssignments(db, current.id, s.id)]);
        incidenciasTurno = assignments.length;
        const activeIds = new Set(techs.filter((t) => t.active).map((t) => t.id));
        const order = parseOrder(current.order_json);
        const nextId = nextFor(order, assignments, activeIds);
        const techMap = new Map(techs.map((t) => [t.id, t.name]));
        siguiente = nextId !== null ? techMap.get(nextId) || null : null;
        ordenValido = isValid(order, activeIds, await lastAttendedBefore(db, current.id, s.id));
      }
      overview.push({
        code: s.code,
        name: s.name,
        active: !!s.active,
        technicians_active: techCount.n,
        incidencias_turno_actual: incidenciasTurno,
        siguiente,
        orden_valido: ordenValido,
        ultima_incidencia: lastIncident ? lastIncident.created_at : null,
      });
    }
    return { overview };
  },
};

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
      "SELECT id, seq, technician_id, ticket, note, created_at FROM assignments WHERE jornada_id = ? AND site_id = ? ORDER BY seq ASC"
    )
    .bind(jornadaId, siteId)
    .all();
  return results.map((a) => ({ ...a, ticket: a.ticket || "", note: a.note || "" }));
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

/** Escapa % y _ para que una búsqueda LIKE no los trate como comodines. */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
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

/** El número de ticket se fija al crear la incidencia y ya no se puede tocar
 *  (solo el comentario, vía /api/incidents/note, es editable después). */
async function addIncident(db, ticket, note, siteId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const st = await loadState(db, siteId);
    if (!st.next) throw new HttpError(409, "No hay técnicos disponibles para asignar la incidencia.");
    const lastSeq = st.assignments.length ? st.assignments[st.assignments.length - 1].seq : 0;
    const res = await db
      .prepare(
        `INSERT INTO assignments (site_id, jornada_id, seq, technician_id, ticket, note, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COALESCE(MAX(seq), 0) FROM assignments WHERE jornada_id = ? AND site_id = ?) = ?`
      )
      .bind(
        siteId,
        st.jornada.id,
        lastSeq + 1,
        st.next.technician_id,
        ticket,
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
  "GET /api/state": (db, req, url, site) => loadState(db, site.id),


  "POST /api/incidents": async (db, req, url, site) => {
    const body = await readBody(req);
    const ticket = toText(body.ticket, { max: 60, required: true, label: "El nº de ticket / Despliegue / Retirada" });
    const note = toText(body.note, { max: 300, label: "El comentario" });
    return addIncident(db, ticket, note, site.id);
  },

  "POST /api/incidents/undo": (db, req, url, site) => undoIncident(db, site.id),

  "POST /api/incidents/note": async (db, req, url, site) => {
    const body = await readBody(req);
    const id = toId(body.id);
    const note = toText(body.note, { max: 300, label: "El comentario" });
    const j = await ensureJornada(db, site.id);
    const res = await db
      .prepare("UPDATE assignments SET note = ? WHERE id = ? AND jornada_id = ? AND site_id = ?")
      .bind(note, id, j.id, site.id)
      .run();
    if (res.meta.changes === 0) throw new HttpError(404, "Incidencia no encontrada");
    return loadState(db, site.id);
  },

  "GET /api/incidents/search": async (db, req, url, site) => {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) throw new HttpError(400, "Escribe un nº de ticket / despliegue / retirada para buscar");
    if (q.length > 60) throw new HttpError(400, "La búsqueda es demasiado larga");
    const { results } = await db
      .prepare(
        `SELECT a.id, a.ticket, a.note, a.created_at, a.jornada_id,
                COALESCE(t.name, '(eliminado)') AS technician_name
          FROM assignments a LEFT JOIN technicians t ON t.id = a.technician_id
          WHERE a.site_id = ? AND a.ticket LIKE ? ESCAPE '\\'
          ORDER BY a.created_at DESC LIMIT 30`
      )
      .bind(site.id, "%" + escapeLike(q) + "%")
      .all();
    return { query: q, results: results || [] };
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

// Rutas que no requieren token: el login en sí, y la lista pública de sedes
// (sin contraseñas) que rellena el desplegable de la página puente.
const PUBLIC_ROUTES = new Set(["GET /api/sites", "POST /api/auth/login", "POST /api/auth/admin-login"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (!env.DB) throw new HttpError(500, "Base de datos D1 no vinculada (DB)");

      const routeKeyEarly = `${request.method} ${url.pathname}`;
      // Esta ruta es pública y no necesita TOKEN_SECRET: solo lee D1.
      if (routeKeyEarly === "GET /api/sites") return json(await listPublicSites(env.DB));

      if (!env.TOKEN_SECRET) throw new HttpError(500, "Falta configurar el secreto TOKEN_SECRET");

      // Solo se aceptan escrituras desde esta misma web (no desde otros sitios).
      const origin = request.headers.get("Origin");
      if (request.method !== "GET" && origin && origin !== url.origin) {
        throw new HttpError(403, "Origen no permitido");
      }

      const routeKey = routeKeyEarly;

      // 1) Rutas públicas: login de sede y login de admin (necesitan TOKEN_SECRET
      //    para firmar el token, por eso van después de la comprobación de arriba).
      if (routeKey === "POST /api/auth/login") return json(await siteLogin(env, request));
      if (routeKey === "POST /api/auth/admin-login") return json(await adminLogin(env, request));

      // A partir de aquí hace falta un token válido (Authorization: Bearer <token>).
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) throw new HttpError(401, "Falta iniciar sesión");
      const payload = await verifyToken(token, env.TOKEN_SECRET);
      if (!payload) throw new HttpError(401, "La sesión no es válida o ha caducado");

      // 2) Rutas de administración: el token tiene que llevar admin:true.
      if (url.pathname.startsWith("/api/admin/")) {
        if (!payload.admin) throw new HttpError(403, "Se requiere acceso de administrador");
        const handler = adminRoutes[routeKey];
        if (!handler) throw new HttpError(404, "Ruta no encontrada");
        return json(await handler(env.DB, request, url));
      }

      // 3) Rutas de una sede: el token tiene que ser exactamente el de esa sede.
      const siteCode = normalizeSiteCode(url.searchParams.get("site") || url.searchParams.get("sede") || "");
      if (!siteCode) throw new HttpError(400, "Falta indicar la sede");
      if (payload.site !== siteCode) throw new HttpError(403, "El token no corresponde a esta sede");
      const site = await findSiteByCode(env.DB, siteCode);
      if (!site || !site.active) throw new HttpError(404, "Sede no encontrada");

      const handler = routes[routeKey];
      if (!handler) throw new HttpError(404, "Ruta no encontrada");
      return json(await handler(env.DB, request, url, site));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Error en la API:", err);
      return json({ error: "Error interno del servidor" }, 500);
    }
  },
};
