/* GezyBoard — SPA vanilla JS (tanpa CDN/library). */
"use strict";

const $ = (id) => document.getElementById(id);
const FOOTER_TEXT = ""; // footer sudah statis di index.html

const state = {
  me: null,            // {id, username} bila login sebagai pemilik
  board: null,         // info papan aktif {id, title, description, share_token, ...}
  isOwner: false,
  cards: [],           // terurut position ASC
  ws: null,
  wsRetry: null,
  editingId: null,     // id kartu yang sedang diubah (null = tambah baru)
  modalKind: "text",
  modalColor: "yellow",
  uploadedUrl: "",
};

/* ---------- util ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function showView(name) {
  for (const v of ["auth", "dashboard", "board"]) {
    $("view-" + v).classList.toggle("active", v === name);
  }
  $("presenceBadge").style.display = name === "board" ? "" : "none";
  $("nameInput").style.display = name === "board" ? "" : "none";
  $("logoutBtn").style.display = (name === "dashboard" && state.me) ? "" : "none";
}

/* ---------- auth & dashboard ---------- */
async function init() {
  $("nameInput").value = localStorage.getItem("gezyboard_name") || "";
  $("nameInput").addEventListener("change", (e) => {
    localStorage.setItem("gezyboard_name", e.target.value.trim());
  });

  const m = location.pathname.match(/^\/b\/([A-Za-z0-9]+)/);
  if (m) {
    await openBoardByToken(m[1]);
    return;
  }
  try {
    const { user } = await api("GET", "/api/me");
    state.me = user;
    await loadDashboard();
  } catch {
    state.me = null;
    showView("auth");
  }
}

async function loadDashboard() {
  showView("dashboard");
  const { boards } = await api("GET", "/api/boards");
  const list = $("boardList");
  list.innerHTML = "";
  $("boardEmpty").style.display = boards.length ? "none" : "";
  for (const b of boards) {
    const link = location.origin + "/b/" + b.share_token;
    const el = document.createElement("div");
    el.className = "board-card";
    el.innerHTML =
      "<h3>" + esc(b.title) + "</h3>" +
      (b.description ? "<p>" + esc(b.description) + "</p>" : "") +
      '<div class="share-link"><code>' + esc(link) + '</code>' +
      '<button class="btn btn-navy btn-small" data-act="copy">📋</button></div>' +
      '<div class="row">' +
      '<button class="btn btn-gold btn-small" data-act="open">Buka papan ➜</button>' +
      '<button class="btn btn-navy btn-small" data-act="mode">' + (b.share_mode === "private" ? "🔒 Privat" : "🔗 Tautan") + "</button>" +
      '<button class="btn btn-danger btn-small" data-act="del">🗑️</button>' +
      "</div>";
    el.querySelector('[data-act="open"]').onclick = () => location.href = "/b/" + b.share_token;
    el.querySelector('[data-act="copy"]').onclick = () => copyText(link);
    el.querySelector('[data-act="mode"]').onclick = async () => {
      const next = b.share_mode === "private" ? "link" : "private";
      await api("PATCH", "/api/boards/" + b.id, { share_mode: next });
      loadDashboard();
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm('Hapus papan "' + b.title + '" beserta semua kartunya?')) return;
      await api("DELETE", "/api/boards/" + b.id);
      loadDashboard();
    };
    list.appendChild(el);
  }
}

function copyText(t) {
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => alert("Tautan disalin! 🔗"));
  else { prompt("Salin tautan:", t); }
}

/* ---------- papan ---------- */
async function openBoardByToken(token) {
  let info;
  try {
    info = await api("GET", "/api/b/" + token);
  } catch (e) {
    document.querySelector("main").innerHTML =
      '<div class="panel"><h2>😢 Tautan tidak valid</h2><p class="hint">' + esc(e.message) +
      '</p><a href="/">← Kembali ke beranda</a></div>';
    return;
  }
  state.board = info.board;
  // cek apakah saya pemiliknya (untuk info saja)
  try {
    const full = await api("GET", "/api/boards/" + info.board.id + "?token=" + token);
    state.isOwner = !!full.isOwner;
  } catch { state.isOwner = false; }

  $("boardTitleView").textContent = "📌 " + state.board.title;
  $("boardDescView").textContent = state.board.description || "";
  showView("board");
  connectWs();
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/ws?board=" + state.board.id + "&token=" + state.board.share_token;
}

function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => { if (state.wsRetry) { clearTimeout(state.wsRetry); state.wsRetry = null; } };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMsg(msg);
  };
  ws.onclose = () => {
    // coba sambung ulang selama masih di tampilan papan
    if ($("view-board").classList.contains("active") && !state.wsRetry) {
      state.wsRetry = setTimeout(() => { state.wsRetry = null; connectWs(); }, 2000);
    }
  };
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case "sync.full":
      state.cards = (msg.cards || []).slice().sort((a, b) => a.position - b.position || a.id - b.id);
      renderWall();
      break;
    case "card.added":
      state.cards.push(msg.card);
      sortCards(); renderWall();
      break;
    case "card.updated":
    case "card.moved": {
      const i = state.cards.findIndex((c) => c.id === msg.card.id);
      if (i >= 0) state.cards[i] = msg.card; else state.cards.push(msg.card);
      sortCards(); renderWall();
      break;
    }
    case "card.deleted":
      state.cards = state.cards.filter((c) => c.id !== msg.id);
      renderWall();
      break;
    case "presence":
      $("presenceCount").textContent = msg.count;
      break;
    case "board.deleted":
      alert("Papan ini telah dihapus pemiliknya.");
      location.href = "/";
      break;
    case "error":
      console.error("[GezyBoard]", msg.message);
      break;
  }
}

function sortCards() {
  state.cards.sort((a, b) => a.position - b.position || a.id - b.id);
}

function wsSend(type, data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, data }));
  } else {
    alert("Koneksi terputus, mencoba menyambung ulang… 🔄");
  }
}

function authorName() {
  return ($("nameInput").value || "").trim() || "Anonim";
}

/* ---------- render kartu ---------- */
function cardHtml(c) {
  let inner = "";
  if (c.title) inner += "<h4>" + esc(c.title) + "</h4>";
  if (c.kind === "image" && c.media_url) {
    inner += '<img src="' + esc(c.media_url) + '" alt="gambar" loading="lazy">';
  }
  if (c.kind === "link" && c.link_url) {
    inner += '<div>🔗 <a class="link-card" href="' + esc(c.link_url) + '" target="_blank" rel="noopener">' +
      esc(c.link_url) + "</a></div>";
  }
  if (c.body) inner += "<p>" + esc(c.body) + "</p>";
  inner += '<div class="meta">✍️ ' + esc(c.author_name) + "</div>";
  inner += '<div class="actions"><button data-act="edit" title="Ubah">✏️</button>' +
    '<button data-act="del" title="Hapus">🗑️</button></div>';
  return inner;
}

function renderWall() {
  const wall = $("wall");
  wall.innerHTML = "";
  $("wallEmpty").style.display = state.cards.length ? "none" : "";
  for (const c of state.cards) {
    const el = document.createElement("div");
    el.className = "stickynote note-" + (c.color || "yellow");
    el.draggable = true;
    el.dataset.id = c.id;
    el.innerHTML = cardHtml(c);
    el.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openCardModal(c); };
    el.querySelector('[data-act="del"]').onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Hapus kartu ini?")) return;
      // optimistis: hapus dulu di layar, server menyiarkan card.deleted sesudahnya
      state.cards = state.cards.filter((x) => x.id !== c.id);
      renderWall();
      wsSend("card.delete", { id: c.id });
    };
    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("dragend", onDragEnd);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    wall.appendChild(el);
  }
}

/* ---------- drag & drop antar posisi ---------- */
let dragId = null;
function onDragStart(e) {
  dragId = Number(e.currentTarget.dataset.id);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}
function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  dragId = null;
  for (const el of document.querySelectorAll(".stickynote.drop-before, .stickynote.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}
function onDragOver(e) {
  e.preventDefault();
  const el = e.currentTarget;
  if (Number(el.dataset.id) === dragId) return;
  const r = el.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  el.classList.toggle("drop-before", before);
  el.classList.toggle("drop-after", !before);
  e.dataTransfer.dropEffect = "move";
}
function onDragLeave(e) {
  e.currentTarget.classList.remove("drop-before", "drop-after");
}
function onDrop(e) {
  e.preventDefault();
  const targetEl = e.currentTarget;
  const targetId = Number(targetEl.dataset.id);
  if (targetId === dragId || dragId === null) return;
  const r = targetEl.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;

  const order = state.cards.slice();
  const fromIdx = order.findIndex((c) => c.id === dragId);
  const [moved] = order.splice(fromIdx, 1);
  let toIdx = order.findIndex((c) => c.id === targetId);
  if (!before) toIdx += 1;
  order.splice(toIdx, 0, moved);

  // hitung position baru dari tetangga (kelipatan 1000, sisip = titik tengah)
  let newPos;
  const prev = order[toIdx - 1], next = order[toIdx + 1];
  if (prev && next) newPos = (prev.position + next.position) / 2;
  else if (prev) newPos = prev.position + 1000;
  else if (next) newPos = next.position - 1000;
  else newPos = 1000;

  moved.position = newPos;
  sortCards(); renderWall();          // optimistis
  wsSend("card.move", { id: moved.id, position: newPos });
}
// dijatuhkan di area kosong wall -> pindah ke paling belakang
$("wall").addEventListener("dragover", (e) => e.preventDefault());
$("wall").addEventListener("drop", (e) => {
  if (e.target.id !== "wall" || dragId === null) return;
  e.preventDefault();
  const moved = state.cards.find((c) => c.id === dragId);
  if (!moved) return;
  const last = state.cards[state.cards.length - 1];
  const newPos = last ? last.position + 1000 : 1000;
  if (moved.id === (last && last.id)) return;
  state.cards = state.cards.filter((c) => c.id !== moved.id);
  moved.position = newPos;
  state.cards.push(moved);
  sortCards(); renderWall();
  wsSend("card.move", { id: moved.id, position: newPos });
});

/* ---------- modal tambah/ubah kartu ---------- */
function openCardModal(existing) {
  state.editingId = existing ? existing.id : null;
  state.modalKind = existing ? existing.kind : "text";
  state.modalColor = existing ? existing.color : "yellow";
  state.uploadedUrl = existing ? existing.media_url : "";
  $("cardModalTitle").textContent = existing ? "✏️ Ubah kartu" : "✨ Kartu baru";
  $("cardTitle").value = existing ? existing.title : "";
  $("cardBody").value = existing ? existing.body : "";
  $("cardLink").value = existing ? existing.link_url : "";
  $("cardImage").value = "";
  $("imagePreview").style.display = "none";
  $("cardError").textContent = "";
  syncModalKind(); syncModalColor();
  $("cardModal").classList.add("open");
}
function closeCardModal() { $("cardModal").classList.remove("open"); }
function syncModalKind() {
  for (const b of document.querySelectorAll(".kind-tabs button")) {
    b.classList.toggle("sel", b.dataset.kind === state.modalKind);
  }
  $("bodyField").style.display = state.modalKind === "text" ? "" : "none";
  $("imageField").style.display = state.modalKind === "image" ? "" : "none";
  $("linkField").style.display = state.modalKind === "link" ? "" : "none";
}
function syncModalColor() {
  for (const b of document.querySelectorAll("#colorPick button")) {
    b.classList.toggle("sel", b.dataset.color === state.modalColor);
  }
}

async function saveCard() {
  const data = {
    kind: state.modalKind,
    title: $("cardTitle").value.trim(),
    body: $("cardBody").value.trim(),
    media_url: state.uploadedUrl,
    link_url: $("cardLink").value.trim(),
    color: state.modalColor,
    author_name: authorName(),
  };
  if (state.modalKind === "text" && !data.title && !data.body) {
    $("cardError").textContent = "Isi judul atau teks kartu dulu ya. 😊";
    return;
  }
  if (state.modalKind === "image" && !data.media_url) {
    $("cardError").textContent = "Pilih dan unggah gambar dulu ya. 🖼️";
    return;
  }
  if (state.modalKind === "link" && !data.link_url) {
    $("cardError").textContent = "Isi URL tautannya dulu ya. 🔗";
    return;
  }
  if (state.editingId) wsSend("card.update", Object.assign({ id: state.editingId }, data));
  else wsSend("card.add", data);
  closeCardModal();
}

/* ---------- wiring ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("loginBtn").onclick = async () => {
    $("loginError").textContent = "";
    try {
      const { user } = await api("POST", "/api/login", {
        username: $("loginUser").value.trim(),
        password: $("loginPass").value,
      });
      state.me = user;
      await loadDashboard();
    } catch (e) { $("loginError").textContent = e.message; }
  };
  $("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
  $("logoutBtn").onclick = async () => {
    await api("POST", "/api/logout");
    state.me = null;
    location.href = "/";
  };
  $("homeLink").onclick = (e) => { e.preventDefault(); location.href = "/"; };

  $("newBoardBtn").onclick = () => {
    const f = $("newBoardForm");
    f.style.display = f.style.display === "none" ? "" : "none";
  };
  $("createBoardBtn").onclick = async () => {
    $("boardError").textContent = "";
    try {
      const { board } = await api("POST", "/api/boards", {
        title: $("boardTitle").value,
        description: $("boardDesc").value,
        share_mode: $("boardMode").value,
      });
      location.href = "/b/" + board.share_token;
    } catch (e) { $("boardError").textContent = e.message; }
  };

  $("addCardBtn").onclick = () => openCardModal(null);
  $("cancelCardBtn").onclick = closeCardModal;
  $("saveCardBtn").onclick = saveCard;
  $("cardModal").addEventListener("click", (e) => { if (e.target.id === "cardModal") closeCardModal(); });
  for (const b of document.querySelectorAll(".kind-tabs button")) {
    b.onclick = () => { state.modalKind = b.dataset.kind; syncModalKind(); };
  }
  for (const b of document.querySelectorAll("#colorPick button")) {
    b.onclick = () => { state.modalColor = b.dataset.color; syncModalColor(); };
  }
  $("cardImage").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("cardError").textContent = "Mengunggah… ⏳";
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload?board=" + state.board.id + "&token=" + state.board.share_token, {
        method: "POST", body: form,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      state.uploadedUrl = data.url;
      $("imagePreview").src = data.url;
      $("imagePreview").style.display = "";
      $("cardError").textContent = "";
    } catch (err) { $("cardError").textContent = err.message; }
  });

  $("copyLinkBtn").onclick = () => copyText(location.origin + "/b/" + state.board.share_token);

  init();
});
void FOOTER_TEXT;
