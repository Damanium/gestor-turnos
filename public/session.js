// session.js — sesión guardada en localStorage. La usan index.html (puente),
// admin.html y app.html, para no repetir esta lógica en cada uno.

const KEY_SITE = "turnos_session";
const KEY_ADMIN = "turnos_admin_session";
const KEY_LAST_SITE = "turnos_last_site";

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Sesión de una sede concreta: { site, siteName, token, expires_at } o null
 *  si no hay ninguna guardada o ya caducó. */
export function getSiteSession() {
  const s = readJSON(KEY_SITE);
  if (!s || !s.token || !s.site || !s.expires_at) return null;
  if (s.expires_at <= Date.now()) {
    localStorage.removeItem(KEY_SITE);
    return null;
  }
  return s;
}

export function setSiteSession(site, siteName, token, expiresAt) {
  localStorage.setItem(KEY_SITE, JSON.stringify({ site, siteName, token, expires_at: expiresAt }));
  setLastSite(site);
}

export function clearSiteSession() {
  localStorage.removeItem(KEY_SITE);
}

/** Sesión de administrador: { token, expires_at } o null. */
export function getAdminSession() {
  const s = readJSON(KEY_ADMIN);
  if (!s || !s.token || !s.expires_at) return null;
  if (s.expires_at <= Date.now()) {
    localStorage.removeItem(KEY_ADMIN);
    return null;
  }
  return s;
}

export function setAdminSession(token, expiresAt) {
  localStorage.setItem(KEY_ADMIN, JSON.stringify({ token, expires_at: expiresAt }));
}

export function clearAdminSession() {
  localStorage.removeItem(KEY_ADMIN);
}

export function getLastSite() {
  return localStorage.getItem(KEY_LAST_SITE) || "";
}

export function setLastSite(code) {
  if (code) localStorage.setItem(KEY_LAST_SITE, code);
}
