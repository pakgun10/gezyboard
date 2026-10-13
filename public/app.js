/* GezyBoard — SPA vanilla JS (tanpa CDN/library). */
"use strict";

const $ = (id) => document.getElementById(id);
const FOOTER_TEXT = ""; // footer sudah statis di index.html

const state = {
  me: null,            // {id, username} bila login sebagai pemilik
  board: null,         // info papan aktif {id, title, description, share_token, layout, ...}
  isOwner: false,
  cards: [],           // terurut position ASC
  sections: [],        // bagian/kolom (mode shelf), terurut position ASC
  ws: null,
  wsRetry: null,
  editingId: null,     // id kartu yang sedang diubah (null = tambah baru)
  modalKind: "text",
  modalColor: "yellow",
  uploadedUrl: "",
  commentCardId: null,
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
  $("homeBtn").style.display = name === "board" ? "" : "none";
  $("printBtn").style.display = name === "board" ? "" : "none";
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
      (b.submission_deadline ? '<p class="board-deadline">🗓️ Bisa diisi sampai ' + formatDateOnly(b.submission_deadline) + "</p>" : '<p class="board-deadline">🟢 Terbuka tanpa batas</p>') +
      '<div class="share-link"><code>' + esc(link) + '</code>' +
      '<button class="btn btn-navy btn-small" data-act="copy">📋</button></div>' +
      '<div class="row">' +
      '<button class="btn btn-gold btn-small" data-act="open">Buka papan ➜</button>' +
      '<button class="btn btn-navy btn-small" data-act="layout">' + (b.layout === "shelf" ? "📑 Kolom" : "🧱 Wall") + "</button>" +
      '<button class="btn btn-navy btn-small" data-act="mode">' + (b.share_mode === "private" ? "🔒 Privat" : "🔗 Tautan") + "</button>" +
      '<button class="btn btn-danger btn-small" data-act="del">🗑️</button>' +
      "</div>";
    el.querySelector('[data-act="open"]').onclick = () => location.href = "/b/" + b.share_token;
    el.querySelector('[data-act="copy"]').onclick = () => copyText(link);
    el.querySelector('[data-act="layout"]').onclick = async () => {
      const next = b.layout === "shelf" ? "wall" : "shelf";
      await api("PATCH", "/api/boards/" + b.id, { layout: next });
      loadDashboard();
    };
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
  syncSubmissionState();
  setupLayoutSwitch();
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
      state.sections = (msg.sections || []).slice().sort((a, b) => a.position - b.position || a.id - b.id);
      state.cards = (msg.cards || []).slice().sort((a, b) => a.position - b.position || a.id - b.id);
      renderBoard();
      break;
    case "section.added":
      state.sections.push(msg.section);
      sortSections(); renderBoard();
      break;
    case "section.updated":
    case "section.moved": {
      const i = state.sections.findIndex((s) => s.id === msg.section.id);
      if (i >= 0) state.sections[i] = msg.section; else state.sections.push(msg.section);
      sortSections(); renderBoard();
      break;
    }
    case "section.deleted": {
      state.sections = state.sections.filter((s) => s.id !== msg.id);
      const gone = new Set(msg.cardIds || []);
      state.cards = state.cards.filter((c) => !gone.has(c.id));
      renderBoard();
      break;
    }
    case "board.updated":
      if (state.board) {
        state.board = Object.assign({}, state.board, msg.board);
        syncLayoutSwitch();
        renderBoard();
      }
      break;
    case "card.added":
      state.cards.push(msg.card);
      sortCards(); renderBoard();
      break;
    case "card.updated":
    case "card.moved": {
      const i = state.cards.findIndex((c) => c.id === msg.card.id);
      if (i >= 0) state.cards[i] = msg.card; else state.cards.push(msg.card);
      sortCards(); renderBoard();
      break;
    }
    case "card.deleted":
      state.cards = state.cards.filter((c) => c.id !== msg.id);
      renderBoard();
      break;
    case "comment.added": {
      const card = state.cards.find((c) => c.id === msg.comment?.card_id);
      if (card) {
        card.comments_count = msg.comments_count ?? Number(card.comments_count || 0) + 1;
        renderBoard();
      }
      if (state.commentCardId === msg.comment?.card_id) loadComments();
      break;
    }
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

function formatDateOnly(value) {
  const parts = String(value || "").split("-");
  return parts.length === 3 ? parts[2] + "-" + parts[1] + "-" + parts[0] : String(value || "");
}

function canSubmitClient() {
  return !!state.isOwner || !state.board || state.board.submission_open !== false;
}

function syncSubmissionState() {
  if (!state.board) return;
  const deadline = state.board.submission_deadline;
  const open = canSubmitClient();
  const deadlineView = $("boardDeadlineView");
  if (!deadline) deadlineView.textContent = "🟢 Dibuka sejak dibuat · Terbuka tanpa batas";
  else if (state.board.submission_open === false) {
    deadlineView.textContent = "🔒 Dibuka sejak dibuat · Masa pengisian berakhir pada " + formatDateOnly(deadline) +
      (state.isOwner ? " · Pemilik masih dapat mengelola" : "");
  } else {
    deadlineView.textContent = "🟢 Dibuka sejak dibuat · Bisa diisi sampai " + formatDateOnly(deadline);
  }
  $("addCardBtn").disabled = !open;
  $("addCardBtn").title = open ? "Tempel kartu" : "Masa pengisian sudah berakhir";
  $("fabPost").disabled = !open;
}

function sortSections() {
  state.sections.sort((a, b) => a.position - b.position || a.id - b.id);
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
  inner += '<div class="card-footer"><button class="comment-link" data-act="comment">💬 ' +
    Number(c.comments_count || 0) + ' · Tambah komentar</button></div>';
  if (canSubmitClient()) {
    inner += '<div class="actions"><button data-act="edit" title="Ubah">✏️</button>' +
      '<button data-act="del" title="Hapus">🗑️</button></div>';
  }
  return inner;
}

/* ---------- render papan: dispatcher wall / shelf ---------- */
function renderBoard() {
  if (state.board && state.board.layout === "shelf") renderShelf();
  else renderWall();
  syncSubmissionState();
}

function renderWall() {
  $("shelf").style.display = "none";
  $("fabPost").style.display = "none";
  $("addCardBtn").style.display = "";
  const wall = $("wall");
  wall.style.display = "";
  wall.innerHTML = "";
  $("wallEmpty").style.display = state.cards.length ? "none" : "";
  for (const c of state.cards) {
    const el = document.createElement("div");
    el.className = "stickynote note-" + (c.color || "yellow");
    el.draggable = canSubmitClient();
    el.dataset.id = c.id;
    el.innerHTML = cardHtml(c);
    const editBtn = el.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openCardModal(c); };
    el.querySelector('[data-act="comment"]').onclick = (e) => { e.stopPropagation(); openCommentModal(c); };
    const deleteBtn = el.querySelector('[data-act="del"]');
    if (deleteBtn) deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Hapus kartu ini?")) return;
      // optimistis: hapus dulu di layar, server menyiarkan card.deleted sesudahnya
      state.cards = state.cards.filter((x) => x.id !== c.id);
      renderBoard();
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
  sortCards(); renderBoard();          // optimistis
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
  sortCards(); renderBoard();
  wsSend("card.move", { id: moved.id, position: newPos });
});

/* ---------- layout shelf (kolom/bagian) ---------- */
function timeAgo(iso) {
  const d = new Date(String(iso || "").replace(" ", "T") + "Z"); // datetime('now') SQLite = UTC
  if (isNaN(d.getTime())) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "baru saja";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " mnt lalu";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " jam lalu";
  const dd = Math.floor(h / 24);
  if (dd < 30) return dd + " hari lalu";
  return Math.floor(dd / 30) + " bln lalu";
}

function sortedSections() {
  return state.sections.slice().sort((a, b) => a.position - b.position || a.id - b.id);
}

function normSectionId(s) {
  return (s === undefined || s === null) ? null : s;
}

function cardsInSection(sectionId) {
  const n = normSectionId(sectionId);
  return state.cards
    .filter((c) => normSectionId(c.section_id) === n)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

function shelfCardHtml(c) {
  const initial = esc(((c.author_name || "A").trim().charAt(0) || "A").toUpperCase());
  let inner = '<div class="card-author"><div class="avatar">' + initial + "</div>" +
    '<div><div class="name">' + esc(c.author_name) + '</div><div class="time">' + esc(timeAgo(c.created_at)) + "</div></div></div>";
  if (c.title) inner += "<h3>" + esc(c.title) + "</h3>";
  if (c.kind === "image" && c.media_url) {
    inner += '<img src="' + esc(c.media_url) + '" alt="gambar" loading="lazy">';
  }
  if (c.kind === "link" && c.link_url) {
    inner += '<div>🔗 <a class="link-card" href="' + esc(c.link_url) + '" target="_blank" rel="noopener">' +
      esc(c.link_url) + "</a></div>";
  }
  if (c.body) inner += "<p>" + esc(c.body) + "</p>";
  inner += '<div class="card-footer"><button class="comment-link" data-act="comment">💬 ' +
    Number(c.comments_count || 0) + ' · Tambah komentar</button></div>';
  if (canSubmitClient()) {
    inner += '<div class="actions"><button data-act="edit" title="Ubah">✏️</button>' +
      '<button data-act="del" title="Hapus">🗑️</button></div>';
  }
  return inner;
}

function renderShelf() {
  $("wall").style.display = "none";
  $("wallEmpty").style.display = "none";
  $("addCardBtn").style.display = "none";
  $("fabPost").style.display = "";
  const shelf = $("shelf");
  shelf.style.display = "";
  shelf.innerHTML = "";

  const cols = [];
  if (cardsInSection(null).length) cols.push({ id: null, title: "📥 Tanpa bagian", pseudo: true });
  for (const s of sortedSections()) cols.push(s);

  for (const col of cols) {
    const secEl = document.createElement("div");
    secEl.className = "section";
    const secKey = col.id === null ? "" : String(col.id);
    secEl.dataset.sectionId = secKey;

    const header = document.createElement("div");
    header.className = "section-header";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = col.title;
    header.appendChild(titleSpan);
    if (state.isOwner && !col.pseudo) {
      const acts = document.createElement("span");
      acts.className = "sec-actions";
      acts.innerHTML = '<button data-act="left" title="Geser kiri">◀</button>' +
        '<button data-act="right" title="Geser kanan">▶</button>' +
        '<button data-act="rename" title="Ubah nama bagian">✏️</button>' +
        '<button data-act="del" title="Hapus bagian">🗑️</button>';
      acts.querySelector('[data-act="left"]').onclick = () => moveSectionLR(col.id, -1);
      acts.querySelector('[data-act="right"]').onclick = () => moveSectionLR(col.id, 1);
      acts.querySelector('[data-act="rename"]').onclick = () => renameSection(col);
      acts.querySelector('[data-act="del"]').onclick = () => delSection(col);
      header.appendChild(acts);
    }
    secEl.appendChild(header);

    const addBtn = document.createElement("button");
    addBtn.className = "add-card-btn";
    addBtn.textContent = "＋";
    addBtn.title = "Tempel kartu di bagian ini";
    addBtn.disabled = !canSubmitClient();
    addBtn.onclick = () => openCardModal(null, col.id);
    secEl.appendChild(addBtn);

    const list = document.createElement("div");
    list.className = "section-cards";
    list.dataset.sectionId = secKey;
    for (const c of cardsInSection(col.id)) {
      const el = document.createElement("div");
      el.className = "shelf-card note-" + (c.color || "yellow");
      el.draggable = canSubmitClient();
      el.dataset.id = c.id;
      el.dataset.sectionId = c.section_id == null ? "" : String(c.section_id);
      el.innerHTML = shelfCardHtml(c);
      const editBtn = el.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openCardModal(c); };
      el.querySelector('[data-act="comment"]').onclick = (e) => { e.stopPropagation(); openCommentModal(c); };
      const deleteBtn = el.querySelector('[data-act="del"]');
      if (deleteBtn) deleteBtn.onclick = (e) => {
        e.stopPropagation();
        if (!confirm("Hapus kartu ini?")) return;
        state.cards = state.cards.filter((x) => x.id !== c.id);
        renderBoard();
        wsSend("card.delete", { id: c.id });
      };
      el.addEventListener("dragstart", onShelfDragStart);
      el.addEventListener("dragend", onShelfDragEnd);
      el.addEventListener("dragover", onShelfDragOver);
      el.addEventListener("dragleave", onShelfDragLeave);
      el.addEventListener("drop", onShelfDropOnCard);
      list.appendChild(el);
    }
    list.addEventListener("dragover", (e) => e.preventDefault());
    list.addEventListener("drop", onShelfDropOnColumn);
    secEl.appendChild(list);
    shelf.appendChild(secEl);
  }

  if (state.isOwner) {
    const addSec = document.createElement("button");
    addSec.className = "add-section";
    addSec.textContent = "＋ Tambah bagian";
    addSec.onclick = addSectionPrompt;
    shelf.appendChild(addSec);
  } else if (!cols.length) {
    const p = document.createElement("div");
    p.className = "shelf-hint";
    p.textContent = "Belum ada bagian. Menunggu pemilik menambahkan bagian… 🙂";
    shelf.appendChild(p);
  }
}

/* ---------- drag & drop di shelf (dalam & antar bagian) ---------- */
function onShelfDragStart(e) {
  dragId = Number(e.currentTarget.dataset.id);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}
function onShelfDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  dragId = null;
  for (const el of document.querySelectorAll(".shelf-card.drop-before, .shelf-card.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}
function onShelfDragOver(e) {
  e.preventDefault();
  const el = e.currentTarget;
  if (Number(el.dataset.id) === dragId) return;
  const r = el.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  el.classList.toggle("drop-before", before);
  el.classList.toggle("drop-after", !before);
  e.dataTransfer.dropEffect = "move";
}
function onShelfDragLeave(e) {
  e.currentTarget.classList.remove("drop-before", "drop-after");
}
function onShelfDropOnCard(e) {
  e.preventDefault();
  e.stopPropagation();
  const targetEl = e.currentTarget;
  const targetId = Number(targetEl.dataset.id);
  if (targetId === dragId || dragId === null) return;
  const rawSec = targetEl.dataset.sectionId;
  const targetSec = rawSec === "" ? null : Number(rawSec);
  const r = targetEl.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  shelfMoveCard(dragId, targetSec, targetId, before);
}
function onShelfDropOnColumn(e) {
  e.preventDefault();
  if (dragId === null) return;
  const rawSec = e.currentTarget.dataset.sectionId;
  shelfMoveCard(dragId, rawSec === "" ? null : Number(rawSec), null, false);
}
function shelfMoveCard(cardId, targetSectionId, targetCardId, before) {
  const n = normSectionId(targetSectionId);
  const list = state.cards
    .filter((c) => normSectionId(c.section_id) === n && c.id !== cardId)
    .sort((a, b) => a.position - b.position || a.id - b.id);
  let idx = list.length;
  if (targetCardId != null) {
    idx = list.findIndex((c) => c.id === targetCardId);
    if (idx < 0) idx = list.length;
    else if (!before) idx += 1;
  }
  const prev = list[idx - 1], next = list[idx];
  let newPos;
  if (prev && next) newPos = (prev.position + next.position) / 2;
  else if (prev) newPos = prev.position + 1000;
  else if (next) newPos = next.position - 1000;
  else newPos = 1000;

  const moved = state.cards.find((c) => c.id === cardId);
  if (!moved) return;
  moved.section_id = n;
  moved.position = newPos;
  renderBoard(); // optimistis
  wsSend("card.move", { id: cardId, position: newPos, section_id: n });
}

/* ---------- kelola bagian (pemilik) ---------- */
function addSectionPrompt() {
  const title = prompt("Nama bagian baru:", "");
  if (title === null) return;
  if (!title.trim()) { alert("Nama bagian tidak boleh kosong ya. 😊"); return; }
  wsSend("section.add", { title: title.trim() });
}
function renameSection(col) {
  const title = prompt("Ubah nama bagian:", col.title);
  if (title === null || !title.trim() || title.trim() === col.title) return;
  wsSend("section.update", { id: col.id, title: title.trim() });
}
function delSection(col) {
  const n = cardsInSection(col.id).length;
  if (!confirm('Hapus bagian "' + col.title + '"' + (n ? " beserta " + n + " kartunya" : "") + "?")) return;
  // optimistis: hapus dulu di layar
  state.sections = state.sections.filter((s) => s.id !== col.id);
  state.cards = state.cards.filter((c) => normSectionId(c.section_id) !== col.id);
  renderBoard();
  wsSend("section.delete", { id: col.id });
}
function moveSectionLR(id, dir) {
  const secs = sortedSections();
  const i = secs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= secs.length) return;
  const a = secs[i], b = secs[j];
  const pa = a.position, pb = b.position;
  a.position = pb; b.position = pa; // optimistis: tukar
  renderBoard();
  wsSend("section.move", { id: a.id, position: pb });
  wsSend("section.move", { id: b.id, position: pa });
}

/* ---------- ganti layout (pemilik) ---------- */
function setupLayoutSwitch() {
  const sw = $("layoutSwitch");
  if (state.isOwner) { sw.style.display = ""; syncLayoutSwitch(); }
  else sw.style.display = "none";
}
function syncLayoutSwitch() {
  const cur = state.board ? state.board.layout : "wall";
  for (const b of document.querySelectorAll("#layoutSwitch button")) {
    b.classList.toggle("sel", b.dataset.layout === cur);
  }
}
async function setLayout(layout) {
  if (!state.board || state.board.layout === layout) return;
  try {
    const { board } = await api("PATCH", "/api/boards/" + state.board.id, { layout });
    state.board = Object.assign({}, state.board, { layout: board.layout });
    syncLayoutSwitch();
    renderBoard();
  } catch (e) { alert("Gagal mengganti layout: " + e.message); }
}

/* ---------- modal tambah/ubah kartu ---------- */
function openCardModal(existing, presetSectionId) {
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
  // Pilihan bagian hanya relevan di mode shelf.
  const shelfMode = state.board && state.board.layout === "shelf";
  $("sectionField").style.display = shelfMode ? "" : "none";
  if (shelfMode) {
    const sel = $("cardSection");
    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "📥 Tanpa bagian";
    sel.appendChild(opt0);
    for (const s of sortedSections()) {
      const o = document.createElement("option");
      o.value = String(s.id);
      o.textContent = s.title;
      sel.appendChild(o);
    }
    let cur;
    if (existing) cur = existing.section_id == null ? "" : String(existing.section_id);
    else if (presetSectionId === undefined) cur = sortedSections()[0] ? String(sortedSections()[0].id) : "";
    else cur = presetSectionId === null ? "" : String(presetSectionId);
    sel.value = cur;
  }
  syncModalKind(); syncModalColor();
  $("cardModal").classList.add("open");
}
function closeCardModal() { $("cardModal").classList.remove("open"); }

function commentPath(cardId) {
  return "/api/boards/" + state.board.id + "/cards/" + cardId + "/comments?token=" +
    encodeURIComponent(state.board.share_token);
}

function renderComments(comments) {
  const list = $("commentList");
  if (!comments.length) {
    list.innerHTML = '<div class="comment-empty">Belum ada komentar. Jadilah yang pertama! 🙂</div>';
    return;
  }
  list.innerHTML = comments.map((comment) =>
    '<article class="comment-item"><div class="comment-head"><strong>' + esc(comment.author_name) +
    '</strong><span>' + esc(timeAgo(comment.created_at)) + '</span></div><p>' + esc(comment.body) + '</p></article>'
  ).join("");
}

async function loadComments() {
  if (!state.commentCardId) return;
  try {
    const data = await api("GET", commentPath(state.commentCardId));
    renderComments(data.comments || []);
  } catch (e) {
    $("commentError").textContent = e.message;
  }
}

async function openCommentModal(card) {
  state.commentCardId = card.id;
  $("commentModalTitle").textContent = "💬 Komentar — " + (card.title || "Kartu");
  $("commentBody").value = "";
  $("commentError").textContent = "";
  $("commentList").innerHTML = '<div class="comment-empty">Memuat komentar…</div>';
  $("commentModal").classList.add("open");
  const canComment = canSubmitClient();
  $("commentComposer").style.display = canComment ? "" : "none";
  $("commentClosedHint").style.display = canComment ? "none" : "";
  await loadComments();
}

function closeCommentModal() {
  $("commentModal").classList.remove("open");
  state.commentCardId = null;
}

async function saveComment() {
  if (!canSubmitClient()) return;
  const body = $("commentBody").value.trim();
  if (!body) {
    $("commentError").textContent = "Tulis komentar dulu ya. 😊";
    return;
  }
  const button = $("addCommentBtn");
  button.disabled = true;
  $("commentError").textContent = "";
  try {
    const data = await api("POST", commentPath(state.commentCardId), {
      author_name: authorName(), body,
    });
    const card = state.cards.find((c) => c.id === state.commentCardId);
    if (card) card.comments_count = data.comments_count;
    $("commentBody").value = "";
    await loadComments();
    renderBoard();
  } catch (e) {
    $("commentError").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

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
  if (state.board && state.board.layout === "shelf") {
    const v = $("cardSection").value;
    data.section_id = v === "" ? null : Number(v);
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
  $("homeBtn").onclick = () => { location.href = "/"; };
  $("printBtn").onclick = () => window.print();
  $("boardDeadline").min = new Date().toISOString().slice(0, 10);

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
        submission_deadline: $("boardDeadline").value || null,
      });
      location.href = "/b/" + board.share_token;
    } catch (e) { $("boardError").textContent = e.message; }
  };

  $("addCardBtn").onclick = () => openCardModal(null);
  $("fabPost").onclick = () => openCardModal(null);
  for (const b of document.querySelectorAll("#layoutSwitch button")) {
    b.onclick = () => setLayout(b.dataset.layout);
  }
  $("cancelCardBtn").onclick = closeCardModal;
  $("saveCardBtn").onclick = saveCard;
  $("cardModal").addEventListener("click", (e) => { if (e.target.id === "cardModal") closeCardModal(); });
  $("cancelCommentBtn").onclick = closeCommentModal;
  $("addCommentBtn").onclick = saveComment;
  $("commentModal").addEventListener("click", (e) => { if (e.target.id === "commentModal") closeCommentModal(); });
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
