// Estado en memoria + render. Todo va contra /api/*.

import { getSiteSession, clearSiteSession } from "/session.js";

const $ = (sel) => document.querySelector(sel);

// Sesión obligatoria: sin token válido para la sede pedida en la URL,
// se vuelve a la página puente a iniciar sesión.
const urlSite = new URLSearchParams(window.location.search).get("site");
const session = getSiteSession();
if (!session || (urlSite && urlSite !== session.site)) {
  window.location.href = "/index.html";
  throw new Error("Sin sesión válida, redirigiendo…"); // corta el resto del módulo
}
const currentSite = session.site;

let state = null;
let editing = false;
let draftOrder = null; // array de ids mientras se edita
let lastShownId = null; // para animar solo cuando cambia la última asignada
let renamingId = null; // técnico que se está renombrando en línea
let currentRange = "week"; // rango activo del ranking
let editingNoteId = null; // incidencia cuya nota se está editando en línea

function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function goToLogin() {
  clearSiteSession();
  window.location.href = "/index.html";
}

async function api(path, opts) {
  const separator = path.includes("?") ? "&" : "?";
  const res = await fetch("/api" + path + separator + "site=" + encodeURIComponent(currentSite), {
    method: opts?.method || "GET",
    headers: {
      Authorization: "Bearer " + session.token,
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    goToLogin();
    throw new Error("Sesión no válida");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Error " + res.status);
  return data;
}

function initHeader() {
  const badge = $("#site-badge");
  if (badge) badge.textContent = session.siteName || currentSite;
  const logoutBtn = $("#logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", goToLogin);
}

function nombre(id) {
  const t = state.technicians.find((x) => x.id === id);
  return t ? t.name : "(eliminado)";
}

// color e iniciales por técnico (identidad visual)
const COLORS = { 1: "#2f6fed", 2: "#0f9d63", 3: "#e08600", 4: "#8b5cf6" };
function colorFor(id) {
  if (COLORS[id]) return COLORS[id];
  const h = (id * 47) % 360; // color estable para técnicos nuevos
  return `hsl(${h} 65% 58%)`;
}
function initials(name) {
  const p = name.trim().split(/\s+/);
  return (p[0][0] + (p[1] ? p[1][0] : "")).toUpperCase();
}
function dot(id) {
  const s = document.createElement("span");
  s.className = "dot";
  s.style.background = colorFor(id);
  return s;
}

const ICONS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
};
function iconBtn(icon, title, onClick, extraClass = "") {
  const b = document.createElement("button");
  b.className = "icon-btn" + (extraClass ? " " + extraClass : "");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`;
  b.onclick = onClick;
  return b;
}

// Modal de confirmación propio (reemplaza window.confirm)
function confirmModal(msg, { title = "¿Seguro?", ok = "Confirmar" } = {}) {
  return new Promise((resolve) => {
    const overlay = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-msg").textContent = msg;
    $("#modal-ok").textContent = ok;
    overlay.hidden = false;
    const done = (val) => {
      overlay.hidden = true;
      $("#modal-ok").onclick = null;
      $("#modal-cancel").onclick = null;
      overlay.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") done(true);
    };
    $("#modal-ok").onclick = () => done(true);
    $("#modal-cancel").onclick = () => done(false);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
    document.addEventListener("keydown", onKey);
  });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2200);
}

// ---------- render ----------

function render() {
  if (!state) return;

  const d = new Date(state.jornada.started_at);
  $("#fecha-txt").textContent = d.toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long",
  });

  const av = $("#next-avatar");
  if (state.next) {
    av.textContent = initials(nombre(state.next.technician_id));
    av.style.background = colorFor(state.next.technician_id);
  } else {
    av.textContent = "—";
    av.style.background = "";
  }
  $("#next-nombre").textContent = state.next ? nombre(state.next.technician_id) : "—";
  $("#btn-incidencia").disabled = !state.next;
  $("#btn-undo").disabled = state.assignments.length === 0;

  const last = state.assignments[state.assignments.length - 1];
  const hl = $("#hero-last");
  if (last) {
    const hora = new Date(last.created_at).toLocaleTimeString("es-ES", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
    });
    hl.innerHTML =
      `<span class="hl-dot"></span>` +
      `<span class="hl-txt">Última incidencia atendida por <b>${escapeHtml(nombre(last.technician_id))}</b> · ${hora}</span>`;
    hl.hidden = false;
    if (last.id !== lastShownId) {
      hl.classList.remove("pulse");
      void hl.offsetWidth;
      hl.classList.add("pulse");
    }
  } else {
    hl.hidden = true;
  }
  lastShownId = last ? last.id : null;

  const aviso = $("#aviso");
  if (!state.valid) {
    aviso.hidden = false;
    aviso.textContent =
      "⚠ Con los técnicos activos de hoy no se puede cumplir del todo la regla del primero/último. Revisa el orden o ajústalo a mano.";
  } else {
    aviso.hidden = true;
  }

  renderOrden();
  renderTecnicos();
  renderIncidencias();
}

function renderOrden() {
  const ol = $("#orden");
  ol.innerHTML = "";
  const order = editing ? draftOrder : state.order;
  const nextId = state.next ? state.next.technician_id : null;

  order.forEach((id, i) => {
    const li = document.createElement("li");
    if (!editing && id === nextId) li.classList.add("is-next");

    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = i + 1;
    li.appendChild(pos);
    li.appendChild(dot(id));

    const nom = document.createElement("span");
    nom.className = "nombre";
    nom.textContent = nombre(id);
    li.appendChild(nom);

    if (editing) {
      const mover = document.createElement("span");
      mover.className = "mover";
      const up = document.createElement("button");
      up.textContent = "↑";
      up.disabled = i === 0;
      up.onclick = () => moveDraft(i, -1);
      const down = document.createElement("button");
      down.textContent = "↓";
      down.disabled = i === order.length - 1;
      down.onclick = () => moveDraft(i, 1);
      mover.append(up, down);
      li.appendChild(mover);
    } else {
      if (i === 0)
        li.appendChild(tag("Primero", "tag-first",
          "Primero del día: recibe la primera incidencia. La rotación viene de donde quedó la jornada anterior."));
      if (i === order.length - 1 && order.length > 1)
        li.appendChild(tag("Último", "tag-last",
          "Último del orden del día."));
      if (id === nextId)
        li.appendChild(tag("Siguiente", "tag-next",
          "Le toca la próxima incidencia. Si empiezas un nuevo día ahora, arrancará por él."));
    }
    ol.appendChild(li);
  });

  $("#btn-regenerar").hidden = editing;
  $("#btn-regenerar").disabled = state.locked;
  $("#btn-editar").textContent = editing ? "Guardar orden" : "Editar";
  const nota = $("#orden-nota");
  if (state.locked) {
    nota.textContent = "El orden queda fijado al haber incidencias asignadas. Reinicia el día para cambiarlo.";
  } else if (editing) {
    nota.textContent = "Reordena con las flechas y pulsa «Guardar orden».";
  } else if (state.manual) {
    nota.textContent = "Orden ajustado a mano.";
  } else {
    nota.textContent = "";
  }
  $("#btn-editar").disabled = state.locked && !editing;
}

function tag(text, cls, tip) {
  const s = document.createElement("span");
  s.className = "tag " + cls;
  s.textContent = text;
  if (tip) {
    s.dataset.tip = tip;
    s.tabIndex = 0;
    s.setAttribute("aria-label", `${text}: ${tip}`);
  }
  return s;
}

function moveDraft(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= draftOrder.length) return;
  [draftOrder[i], draftOrder[j]] = [draftOrder[j], draftOrder[i]];
  renderOrden();
}

function renderTecnicos() {
  const ul = $("#tecnicos");
  ul.innerHTML = "";
  state.technicians.forEach((t) => {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.className = "who";
    left.appendChild(dot(t.id));

    if (t.id === renamingId) {
      const input = document.createElement("input");
      input.className = "tec-input";
      input.value = t.name;
      input.maxLength = 40;
      input.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); commitRename(t.id, input.value); }
        if (e.key === "Escape") { renamingId = null; render(); }
      };
      input.onblur = () => commitRename(t.id, input.value);
      left.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      const txt = document.createElement("span");
      txt.innerHTML = `<strong>${escapeHtml(t.name)}</strong> <span class="estado">${
        t.active ? "disponible" : "ausente"
      }</span>`;
      left.appendChild(txt);
    }

    const actions = document.createElement("div");
    actions.className = "tec-actions";
    actions.appendChild(iconBtn("edit", "Renombrar", () => { renamingId = t.id; render(); }));
    actions.appendChild(iconBtn("trash", "Eliminar", () => deleteTecnico(t.id), "danger"));

    const label = document.createElement("label");
    label.className = "switch";
    label.title = "Disponible / ausente";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = t.active;
    input.onchange = () => toggleTecnico(t.id, input.checked);
    const slider = document.createElement("span");
    slider.className = "slider";
    label.append(input, slider);
    actions.appendChild(label);

    li.append(left, actions);
    ul.appendChild(li);
  });
}

function renderIncidencias() {
  $("#contador").textContent = state.assignments.length;
  const ol = $("#incidencias");
  ol.innerHTML = "";
  state.assignments.forEach((a) => {
    const li = document.createElement("li");
    const hora = new Date(a.created_at).toLocaleTimeString("es-ES", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
    });

    const seq = document.createElement("span");
    seq.className = "seq";
    seq.textContent = a.seq;
    li.append(seq, dot(a.technician_id));

    const quien = document.createElement("span");
    quien.className = "quien";
    quien.textContent = nombre(a.technician_id);

    const ticketSpan = document.createElement("span");
    ticketSpan.className = "inc-ticket";
    ticketSpan.textContent = a.ticket ? "#" + a.ticket : "(sin nº)";
    quien.append(" ", ticketSpan);

    if (a.id === editingNoteId) {
      const input = document.createElement("input");
      input.className = "inc-note-input";
      input.value = a.note || "";
      input.maxLength = 300;
      input.placeholder = "Comentario…";
      input.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); commitNote(a.id, input.value); }
        if (e.key === "Escape") { editingNoteId = null; render(); }
      };
      input.onblur = () => commitNote(a.id, input.value);
      quien.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      li.appendChild(quien);
    } else {
      if (a.note) {
        const noteSpan = document.createElement("span");
        noteSpan.className = "inc-note";
        noteSpan.textContent = "— " + a.note;
        quien.append(" ", noteSpan);
      }
      li.appendChild(quien);
      li.appendChild(
        iconBtn("edit", a.note ? "Editar comentario" : "Añadir comentario",
          () => { editingNoteId = a.id; render(); }, "icon-btn-sm")
      );
    }

    const horaEl = document.createElement("span");
    horaEl.className = "hora";
    horaEl.textContent = hora;
    li.appendChild(horaEl);

    ol.appendChild(li);
  });
}

// ---------- acciones ----------

async function load() {
  state = await api("/state");
  render();
}

async function nuevaIncidencia() {
  if (editing) return;
  const ticketEl = $("#ticket-inc");
  const ticket = ticketEl.value.trim();
  if (!ticket) {
    toast("Escribe el nº de ticket / despliegue / retirada");
    ticketEl.focus();
    return;
  }
  try {
    const who = state.next ? nombre(state.next.technician_id) : null;
    state = await api("/incidents", { method: "POST", body: { ticket } });
    ticketEl.value = "";
    render();
    loadRanking(currentRange);
    if (who) toast("Asignada a " + who);
  } catch (e) { toast(e.message); }
}

async function deshacer() {
  try { state = await api("/incidents/undo", { method: "POST" }); render(); loadRanking(currentRange); toast("Última incidencia deshecha"); }
  catch (e) { toast(e.message); }
}

async function commitNote(id, value) {
  if (editingNoteId !== id) return;
  editingNoteId = null;
  const note = value.trim();
  const current = (state.assignments.find((a) => a.id === id)?.note) || "";
  if (note === current) { render(); return; }
  try {
    state = await api("/incidents/note", { method: "POST", body: { id, note } });
    render();
    toast(note ? "Nota guardada" : "Nota borrada");
  } catch (e) { toast(e.message); render(); }
}

async function regenerar() {
  try { state = await api("/jornada/regenerate", { method: "POST" }); render(); toast("Orden recalculado"); }
  catch (e) { toast(e.message); }
}

async function toggleEdicion() {
  if (!editing) {
    editing = true;
    draftOrder = [...state.order];
    renderOrden();
  } else {
    try {
      state = await api("/jornada/order", { method: "POST", body: { order: draftOrder } });
      editing = false;
      draftOrder = null;
      render();
      toast("Orden guardado");
    } catch (e) { toast(e.message); }
  }
}

async function toggleTecnico(id, active) {
  try { state = await api("/technicians/toggle", { method: "POST", body: { id, active } }); render(); }
  catch (e) { toast(e.message); load(); }
}

async function commitRename(id, value) {
  if (renamingId !== id) return;
  renamingId = null;
  const name = value.trim();
  const actual = state.technicians.find((t) => t.id === id)?.name;
  if (!name || name === actual) { render(); return; }
  try { state = await api("/technicians/rename", { method: "POST", body: { id, name } }); render(); toast("Técnico renombrado"); }
  catch (e) { toast(e.message); render(); }
}

async function deleteTecnico(id) {
  const t = state.technicians.find((x) => x.id === id);
  const ok = await confirmModal(
    `Se eliminará a ${t ? t.name : "este técnico"} de forma permanente. Las incidencias ya registradas se conservan en el historial.`,
    { title: "¿Eliminar técnico?", ok: "Eliminar" }
  );
  if (!ok) return;
  try { state = await api("/technicians/delete", { method: "POST", body: { id } }); renamingId = null; render(); toast("Técnico eliminado"); }
  catch (e) { toast(e.message); }
}

async function addTecnico() {
  const input = $("#tec-nuevo");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  try { state = await api("/technicians/add", { method: "POST", body: { name } }); input.value = ""; render(); toast("Técnico añadido"); }
  catch (e) { toast(e.message); }
}

async function nuevoDia() {
  const ok = await confirmModal(
    "Empieza un turno nuevo. La rotación continúa donde quedó: arranca por quien está de «Siguiente».",
    { title: "¿Empezar un nuevo turno?", ok: "Empezar nuevo turno" }
  );
  if (!ok) return;
  try { state = await api("/jornada/advance", { method: "POST" }); editing = false; render(); toast("Nuevo turno — orden rotado"); }
  catch (e) { toast(e.message); }
}

async function loadRanking(range = currentRange) {
  currentRange = range;
  document.querySelectorAll(".rank-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.range === range)
  );
  const cont = $("#ranking");
  try {
    const d = await api(`/ranking?range=${range}`);
    if (!d.ranking.length) {
      cont.innerHTML = `<div class="bd-title">Sin incidencias en este periodo.</div>`;
      return;
    }
    const etiqueta = range === "week" ? "los últimos 7 días"
      : range === "month" ? "los últimos 30 días" : "el total histórico";
    const seg = d.ranking.map((b) =>
      `<span style="width:${(b.count / d.total) * 100}%;background:${colorFor(b.technician_id)}" title="${escapeHtml(b.name)}: ${b.count}"></span>`
    ).join("");
    cont.innerHTML =
      `<div class="bd-title">${d.total} incidencia${d.total === 1 ? "" : "s"} en ${etiqueta}:</div>` +
      `<div class="bd-stack">${seg}</div>` +
      d.ranking.map((b, i) =>
        `<div class="bd-row">` +
        `<span class="rank-pos">${i + 1}</span>` +
        `<span class="dot" style="background:${colorFor(b.technician_id)}"></span>` +
        `<span class="bd-name">${escapeHtml(b.name)}</span>` +
        `<span class="bd-count">${b.count}</span>` +
        `<span class="bd-pct">${Math.round((b.count / d.total) * 100)}%</span>` +
        `</div>`
      ).join("");
  } catch (e) { cont.textContent = e.message; }
}

async function verHistorial() {
  const cont = $("#historial");
  cont.textContent = "Cargando…";
  try {
    const { history } = await api("/history");
    if (!history.length) { cont.textContent = "Sin historial todavía."; return; }
    cont.innerHTML = "";
    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th></th><th>Fecha</th><th>Orden</th><th>Inc.</th></tr></thead>";
    const tbody = document.createElement("tbody");
    history.forEach((h) => {
      const f = new Date(h.started_at).toLocaleDateString("es-ES", {
        day: "2-digit", month: "2-digit", year: "2-digit",
      });
      const hora = new Date(h.started_at).toLocaleTimeString("es-ES", {
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
      });
      const tr = document.createElement("tr");
      tr.className = "hist-row";
      tr.innerHTML =
        `<td class="hist-caret">▸</td>` +
        `<td>${f} <span class="hist-hora">${hora}</span></td>` +
        `<td class="hist-orden">${h.order.join(" → ")}</td>` +
        `<td>${h.incidencias}</td>`;
      const detail = document.createElement("tr");
      detail.className = "hist-detail";
      detail.hidden = true;
      detail.innerHTML = `<td colspan="4"><div class="hist-detail-body">Cargando…</div></td>`;
      tr.onclick = () => toggleHistDetail(h, tr, detail);
      tbody.append(tr, detail);
    });
    table.appendChild(tbody);
    cont.appendChild(table);
  } catch (e) { cont.textContent = e.message; }
}

async function toggleHistDetail(h, tr, detail) {
  const caret = tr.querySelector(".hist-caret");
  if (!detail.hidden) { detail.hidden = true; caret.textContent = "▸"; return; }
  detail.hidden = false;
  caret.textContent = "▾";
  if (detail.dataset.loaded) return;
  const body = detail.querySelector(".hist-detail-body");
  body.textContent = "Cargando…";
  try {
    const d = await api(`/jornada-detail?id=${h.id}`);
    detail.dataset.loaded = "1";
    if (!d.breakdown.length) { body.textContent = "Sin incidencias este día."; return; }
    const seg = d.breakdown.map((b) =>
      `<span style="width:${(b.count / d.total) * 100}%;background:${colorFor(b.technician_id)}" title="${escapeHtml(b.name)}: ${b.count}"></span>`
    ).join("");
    body.innerHTML =
      `<div class="bd-title">${d.total} incidencia${d.total === 1 ? "" : "s"} — reparto del día:</div>` +
      `<div class="bd-stack">${seg}</div>` +
      d.breakdown.map((b) =>
        `<div class="bd-row">` +
        `<span class="dot" style="background:${colorFor(b.technician_id)}"></span>` +
        `<span class="bd-name">${escapeHtml(b.name)}</span>` +
        `<span class="bd-count">${b.count}</span>` +
        `<span class="bd-pct">${Math.round((b.count / d.total) * 100)}%</span>` +
        `</div>`
      ).join("") +
      (d.notes && d.notes.length
        ? `<div class="bd-title" style="margin-top:12px">Comentarios (${d.notes.length}):</div>` +
          `<div class="hist-notes">` +
          d.notes.map((n) => {
            const hora = new Date(n.created_at).toLocaleTimeString("es-ES", {
              hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
            });
            return `<div class="hist-note">` +
              `<span class="dot" style="background:${colorFor(n.technician_id)}"></span>` +
              `<span class="hn-who">${escapeHtml(n.name)}</span>` +
              `<span class="hn-text">${escapeHtml(n.note)}</span>` +
              `<span class="hn-hora">${hora}</span>` +
              `</div>`;
          }).join("") +
          `</div>`
        : "");
  } catch (e) { body.textContent = e.message; }
}

async function buscarIncidencia(e) {
  e.preventDefault();
  const input = $("#buscar-input");
  const q = input.value.trim();
  const cont = $("#buscar-resultados");
  if (!q) { cont.innerHTML = ""; return; }
  cont.textContent = "Buscando…";
  try {
    const { results } = await api("/incidents/search?q=" + encodeURIComponent(q));
    if (!results.length) { cont.innerHTML = `<p class="nota">Sin resultados para «${escapeHtml(q)}».</p>`; return; }
    cont.innerHTML = results.map((r) => {
      const fecha = new Date(r.created_at).toLocaleString("es-ES", {
        day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
        timeZone: "Europe/Madrid",
      });
      return `<div class="buscar-item">` +
        `<span class="inc-ticket">#${escapeHtml(r.ticket || "(sin nº)")}</span>` +
        `<span class="buscar-quien">${escapeHtml(r.technician_name)}</span>` +
        `<span class="buscar-fecha">${fecha}</span>` +
        (r.note ? `<span class="inc-note">— ${escapeHtml(r.note)}</span>` : "") +
        `</div>`;
    }).join("");
  } catch (err) { cont.textContent = err.message; }
}

// ---------- eventos ----------

$("#btn-incidencia").onclick = nuevaIncidencia;
$("#buscar-form").addEventListener("submit", buscarIncidencia);
$("#btn-undo").onclick = deshacer;
$("#btn-regenerar").onclick = regenerar;
$("#btn-editar").onclick = toggleEdicion;
$("#btn-nuevodia").onclick = nuevoDia;
$("#btn-add-tec").onclick = addTecnico;
$("#tec-nuevo").addEventListener("keydown", (e) => { if (e.key === "Enter") addTecnico(); });
$("#ticket-inc").addEventListener("keydown", (e) => { if (e.key === "Enter") nuevaIncidencia(); });
document.querySelectorAll(".rank-tab").forEach((b) => { b.onclick = () => loadRanking(b.dataset.range); });
document.querySelector("details").addEventListener("toggle", (e) => {
  if (e.target.open) verHistorial();
});

// ---------- actualización en tiempo real (polling cada 3s) ----------
async function refreshState() {
  if (editing || renamingId !== null || editingNoteId !== null) return;
  if (!$("#modal").hidden) return;
  if (document.activeElement === $("#tec-nuevo") && $("#tec-nuevo").value) return;
  if (document.hidden) return;
  try {
    const fresh = await api("/state");
    if (JSON.stringify(fresh) !== JSON.stringify(state)) {
      state = fresh;
      render();
      loadRanking(currentRange);
    }
  } catch (_) { /* silencioso: reintenta en el siguiente ciclo */ }
}

// refresco inmediato al volver a la pestaña
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshState(); });

initHeader();
load()
  .then(() => { loadRanking("week"); setInterval(refreshState, 3000); })
  .catch((e) => toast(e.message));

