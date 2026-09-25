import { getAdminSession, setAdminSession, clearAdminSession } from "/session.js";

const loginCard = document.getElementById("admin-login-card");
const panel = document.getElementById("admin-panel");
const loginForm = document.getElementById("admin-login-form");
const loginError = document.getElementById("admin-login-error");
const loginBtn = document.getElementById("admin-login-btn");
const passwordInput = document.getElementById("admin-password");

const panelError = document.getElementById("admin-panel-error");
const panelOk = document.getElementById("admin-panel-ok");
const sitesList = document.getElementById("sites-list");
const rowTemplate = document.getElementById("site-row-template");
const newSiteForm = document.getElementById("new-site-form");

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.hidden = false;
}
function showPanelError(msg) {
  panelOk.hidden = true;
  panelError.textContent = msg;
  panelError.hidden = false;
  setTimeout(() => (panelError.hidden = true), 5000);
}
function showPanelOk(msg) {
  panelError.hidden = true;
  panelOk.textContent = msg;
  panelOk.hidden = false;
  setTimeout(() => (panelOk.hidden = true), 3000);
}

/** Llama a la API de administración con el token guardado. Si caducó, vuelve al login. */
async function adminApi(path, opts) {
  const session = getAdminSession();
  if (!session) {
    showLogin();
    throw new Error("Sesión de administrador caducada");
  }
  const res = await fetch("/api" + path, {
    method: opts?.method || "GET",
    headers: {
      Authorization: "Bearer " + session.token,
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    clearAdminSession();
    showLogin();
    throw new Error(data.error || "Sesión no válida");
  }
  if (!res.ok) throw new Error(data.error || "Error " + res.status);
  return data;
}

function showLogin() {
  panel.hidden = true;
  loginCard.hidden = false;
  passwordInput.value = "";
  passwordInput.focus();
}

function showPanel() {
  loginCard.hidden = true;
  panel.hidden = false;
  loadSites();
}

function renderSites(sites) {
  sitesList.innerHTML = "";
  for (const site of sites) {
    const node = rowTemplate.content.cloneNode(true);
    node.querySelector(".site-row-name").textContent = site.name;
    node.querySelector(".site-row-code").textContent = site.code;

    const badge = node.querySelector(".site-row-badge");
    if (!site.active) {
      badge.textContent = "Desactivada";
      badge.classList.add("badge-off");
    } else if (!site.has_password) {
      badge.textContent = "Sin contraseña";
      badge.classList.add("badge-warn");
    } else {
      badge.textContent = "Activa";
      badge.classList.add("badge-on");
    }

    const toggleBtn = node.querySelector(".btn-toggle");
    toggleBtn.textContent = site.active ? "Desactivar" : "Activar";
    toggleBtn.addEventListener("click", async () => {
      toggleBtn.disabled = true;
      try {
        await adminApi("/admin/sites/toggle", { method: "POST", body: { site: site.code, active: !site.active } });
        showPanelOk(site.active ? `${site.name} desactivada.` : `${site.name} activada.`);
        loadSites();
      } catch (err) {
        showPanelError(err.message);
        toggleBtn.disabled = false;
      }
    });

    const passForm = node.querySelector(".site-row-password-form");
    const passInput = node.querySelector(".site-row-password");
    passForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (passInput.value.length < 6) {
        showPanelError("La contraseña debe tener al menos 6 caracteres.");
        return;
      }
      const btn = passForm.querySelector("button");
      btn.disabled = true;
      try {
        await adminApi("/admin/sites/password", { method: "POST", body: { site: site.code, password: passInput.value } });
        passInput.value = "";
        showPanelOk(`Contraseña de ${site.name} actualizada.`);
        loadSites();
      } catch (err) {
        showPanelError(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    sitesList.appendChild(node);
  }
}

async function loadSites() {
  try {
    const { sites } = await adminApi("/admin/sites");
    renderSites(sites || []);
  } catch (err) {
    if (err.message) showPanelError(err.message);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const password = passwordInput.value;
  if (!password) return;

  loginBtn.disabled = true;
  loginBtn.textContent = "Comprobando…";
  try {
    const res = await fetch("/api/auth/admin-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showLoginError(data.error || "No se pudo iniciar sesión.");
      return;
    }
    setAdminSession(data.token, data.expires_at);
    showPanel();
  } catch {
    showLoginError("No se pudo conectar con el servidor.");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Entrar";
  }
});

newSiteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("new-site-code").value.trim().toLowerCase();
  const name = document.getElementById("new-site-name").value.trim();
  if (!code || !name) return;
  const btn = newSiteForm.querySelector("button");
  btn.disabled = true;
  try {
    await adminApi("/admin/sites", { method: "POST", body: { code, name } });
    newSiteForm.reset();
    showPanelOk(`Sede "${name}" creada. Ahora ponle una contraseña.`);
    loadSites();
  } catch (err) {
    showPanelError(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("admin-logout").addEventListener("click", () => {
  clearAdminSession();
  showLogin();
});

// Arranque: si ya hay sesión de admin vigente, directo al panel.
if (getAdminSession()) showPanel();
else showLogin();
