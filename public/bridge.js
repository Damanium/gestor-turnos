import { getSiteSession, setSiteSession, getLastSite } from "/session.js";

const form = document.getElementById("auth-form");
const select = document.getElementById("site-select");
const password = document.getElementById("password");
const errorBox = document.getElementById("auth-error");
const submitBtn = document.getElementById("submit-btn");
const loadingMsg = document.getElementById("auth-loading");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.hidden = true;
}
function goToApp(code) {
  window.location.href = "/app.html?site=" + encodeURIComponent(code);
}

async function init() {
  // Si ya hay una sesión de sede vigente, no hace falta pasar por aquí.
  const existing = getSiteSession();
  if (existing) {
    goToApp(existing.site);
    return;
  }

  let sites = [];
  try {
    const res = await fetch("/api/sites");
    const data = await res.json();
    sites = data.sites || [];
  } catch {
    // seguimos con la lista vacía; se informa más abajo.
  }
  loadingMsg.hidden = true;

  if (!sites.length) {
    showError("No se pudo cargar la lista de sedes. Recarga la página.");
    submitBtn.disabled = true;
    return;
  }

  const lastSite = getLastSite();
  for (const site of sites) {
    const option = document.createElement("option");
    option.value = site.code;
    option.textContent = site.name;
    if (site.code === lastSite) option.selected = true;
    select.appendChild(option);
  }
  password.focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  const code = select.value;
  const pass = password.value;
  if (!code || !pass) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Comprobando…";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: code, password: pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || "No se pudo iniciar sesión.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Entrar";
      password.value = "";
      password.focus();
      return;
    }
    setSiteSession(data.site.code, data.site.name, data.token, data.expires_at);
    goToApp(data.site.code);
  } catch {
    showError("No se pudo conectar con el servidor. Inténtalo de nuevo.");
    submitBtn.disabled = false;
    submitBtn.textContent = "Entrar";
  }
});

init();
