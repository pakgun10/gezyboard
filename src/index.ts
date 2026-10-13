import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";

import { type Board } from "./db";
import {
  SESSION_COOKIE, hashPassword, verifyPassword, createUser, countUsers,
  getUserByUsername, getUserById, createSession, getUserBySession, destroySession,
} from "./auth";
import {
  createBoard, getBoard, getBoardByToken, listBoardsByOwner,
  updateBoard, deleteBoard, canAccessBoard, boardPublicView,
} from "./boards";
import { listCards, createCard, updateCard, moveCard, deleteCard, getCard } from "./cards";
import { listComments, countComments, createComment } from "./comments";
import { listSections, createSection, updateSection, moveSection, deleteSection, getSection } from "./sections";
import { saveUpload } from "./uploads";
import { checkWsAccess, joinRoom, leaveRoom, handleWsMessage, broadcast } from "./ws";

const PORT = Number(process.env.PORT || 3100);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const FOOTER = "© 2026 GezyTech App · Dikembangkan oleh PakGun · Dilarang menyalin/menduplikat kode tanpa izin tertulis.";

const app = new Hono();

// ---------- helper ----------

function currentUser(c: Context): { id: number; username: string } | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const u = getUserBySession(token);
  return u ? { id: u.id, username: u.username } : null;
}

function requireLogin(c: any) {
  const u = currentUser(c);
  if (!u) return c.json({ ok: false, error: "Silakan login dulu." }, 401);
  return u;
}

// Pemilik papan saja (untuk kelola bagian & ganti layout).
function requireOwner(c: any, board: Board) {
  const u = requireLogin(c);
  if (u instanceof Response) return u;
  if (board.owner_id !== u.id) return c.json({ ok: false, error: "Hanya pemilik papan." }, 403);
  return u;
}

// Akses papan: pemilik (login) atau token berbagi yang cocok + mode bukan private.
function boardAccess(c: any, board: Board): { id: number; username: string } | "link" | null {
  const u = currentUser(c);
  const token = c.req.query("token") || "";
  if (u && board.owner_id === u.id) return u;
  if (canAccessBoard(board, u ? u.id : null, token)) return u ?? "link";
  return null;
}

async function servePublicFile(path: string, contentType: string) {
  const file = Bun.file(join(PUBLIC_DIR, path));
  if (!(await file.exists())) return new Response("Tidak ditemukan", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}

// ---------- auth ----------

app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = getUserByUsername(String(username || "").trim());
  if (!user || !(await verifyPassword(String(password || ""), user.password_hash))) {
    return c.json({ ok: false, error: "Username atau password salah." }, 401);
  }
  const token = createSession(user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, path: "/", sameSite: "Lax", maxAge: 30 * 24 * 3600,
  });
  return c.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.post("/api/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const u = currentUser(c);
  if (!u) return c.json({ ok: false }, 401);
  return c.json({ ok: true, user: u });
});

// ---------- boards ----------

app.get("/api/boards", (c) => {
  const u = requireLogin(c);
  if (u instanceof Response) return u;
  return c.json({ ok: true, boards: listBoardsByOwner(u.id) });
});

app.post("/api/boards", async (c) => {
  const u = requireLogin(c);
  if (u instanceof Response) return u;
  const { title, description, share_mode } = await c.req.json().catch(() => ({}));
  if (!String(title || "").trim()) return c.json({ ok: false, error: "Judul papan wajib diisi." }, 400);
  const board = createBoard(u.id, String(title), String(description || ""), String(share_mode || "link"));
  return c.json({ ok: true, board });
});

app.get("/api/boards/:id", (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  const access = boardAccess(c, board);
  if (!access) return c.json({ ok: false, error: "Tidak punya akses ke papan ini." }, 403);
  const u = currentUser(c);
  const isOwner = !!u && board.owner_id === u.id;
  return c.json({ ok: true, board: boardPublicView(board), isOwner });
});

// Resolve tautan berbagi /b/<token> -> info papan.
app.get("/api/b/:token", (c) => {
  const board = getBoardByToken(c.req.param("token"));
  if (!board || board.share_mode === "private") {
    return c.json({ ok: false, error: "Tautan tidak valid atau papan bersifat privat." }, 404);
  }
  return c.json({ ok: true, board: boardPublicView(board) });
});

app.patch("/api/boards/:id", async (c) => {
  const u = requireLogin(c);
  if (u instanceof Response) return u;
  const board = getBoard(Number(c.req.param("id")));
  if (!board || board.owner_id !== u.id) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  const { title, description, share_mode, layout } = await c.req.json().catch(() => ({}));
  const updated = updateBoard(board.id, { title, description, share_mode, layout });
  if (updated && updated.layout !== board.layout) {
    broadcast(board.id, { type: "board.updated", board: boardPublicView(updated) });
  }
  return c.json({ ok: true, board: updated });
});

app.delete("/api/boards/:id", (c) => {
  const u = requireLogin(c);
  if (u instanceof Response) return u;
  const board = getBoard(Number(c.req.param("id")));
  if (!board || board.owner_id !== u.id) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  broadcast(board.id, { type: "board.deleted", id: board.id });
  deleteBoard(board.id);
  return c.json({ ok: true });
});

// ---------- sections (bagian/kolom; kelola hanya pemilik, tiap perubahan disiarkan) ----------

function boardAndSection(c: any) {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return { err: c.json({ ok: false, error: "Papan tidak ditemukan." }, 404) };
  const section = getSection(Number(c.req.param("sectionId")));
  if (!section || section.board_id !== board.id) {
    return { err: c.json({ ok: false, error: "Bagian tidak ditemukan." }, 404) };
  }
  return { board, section };
}

app.get("/api/boards/:id/sections", (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  return c.json({ ok: true, sections: listSections(board.id) });
});

app.post("/api/boards/:id/sections", async (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  const owner = requireOwner(c, board);
  if (owner instanceof Response) return owner;
  const { title } = await c.req.json().catch(() => ({}));
  const section = createSection(board.id, String(title || ""));
  broadcast(board.id, { type: "section.added", section, by: "rest" });
  return c.json({ ok: true, section });
});

app.patch("/api/boards/:id/sections/:sectionId", async (c) => {
  const r = boardAndSection(c);
  if (r.err) return r.err;
  const owner = requireOwner(c, r.board!);
  if (owner instanceof Response) return owner;
  const { title } = await c.req.json().catch(() => ({}));
  const section = updateSection(r.section!.id, String(title || ""));
  broadcast(r.board!.id, { type: "section.updated", section, by: "rest" });
  return c.json({ ok: true, section });
});

app.post("/api/boards/:id/sections/:sectionId/move", async (c) => {
  const r = boardAndSection(c);
  if (r.err) return r.err;
  const owner = requireOwner(c, r.board!);
  if (owner instanceof Response) return owner;
  const { position } = await c.req.json().catch(() => ({}));
  const section = moveSection(r.section!.id, Number(position));
  broadcast(r.board!.id, { type: "section.moved", section, by: "rest" });
  return c.json({ ok: true, section });
});

app.delete("/api/boards/:id/sections/:sectionId", (c) => {
  const r = boardAndSection(c);
  if (r.err) return r.err;
  const owner = requireOwner(c, r.board!);
  if (owner instanceof Response) return owner;
  const cardIds = deleteSection(r.section!.id);
  broadcast(r.board!.id, { type: "section.deleted", id: r.section!.id, cardIds, by: "rest" });
  return c.json({ ok: true });
});

// ---------- cards (REST; tiap perubahan juga disiarkan ke room WS) ----------

app.get("/api/boards/:id/cards", (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  return c.json({ ok: true, cards: listCards(board.id) });
});

app.post("/api/boards/:id/cards", async (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  const data = await c.req.json().catch(() => ({}));
  const card = createCard(board.id, data);
  broadcast(board.id, { type: "card.added", card, by: "rest" });
  return c.json({ ok: true, card });
});

app.patch("/api/boards/:id/cards/:cardId", async (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  const existing = getCard(Number(c.req.param("cardId")));
  if (!existing || existing.board_id !== board.id) return c.json({ ok: false, error: "Kartu tidak ditemukan." }, 404);
  const data = await c.req.json().catch(() => ({}));
  const card = updateCard(existing.id, data);
  broadcast(board.id, { type: "card.updated", card, by: "rest" });
  return c.json({ ok: true, card });
});

app.post("/api/boards/:id/cards/:cardId/move", async (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  const existing = getCard(Number(c.req.param("cardId")));
  if (!existing || existing.board_id !== board.id) return c.json({ ok: false, error: "Kartu tidak ditemukan." }, 404);
  const { position, section_id } = await c.req.json().catch(() => ({}));
  const sec = section_id === undefined ? undefined : section_id === null ? null : Number(section_id);
  const card = moveCard(existing.id, Number(position), sec);
  broadcast(board.id, { type: "card.moved", card, by: "rest" });
  return c.json({ ok: true, card });
});

app.delete("/api/boards/:id/cards/:cardId", (c) => {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return c.json({ ok: false, error: "Papan tidak ditemukan." }, 404);
  if (!boardAccess(c, board)) return c.json({ ok: false, error: "Tidak punya akses." }, 403);
  const existing = getCard(Number(c.req.param("cardId")));
  if (!existing || existing.board_id !== board.id) return c.json({ ok: false, error: "Kartu tidak ditemukan." }, 404);
  deleteCard(existing.id);
  broadcast(board.id, { type: "card.deleted", id: existing.id, by: "rest" });
  return c.json({ ok: true });
});

// ---------- komentar kartu ----------

function getAccessibleCard(c: any): { board: Board; card: NonNullable<ReturnType<typeof getCard>> } | { err: Response } {
  const board = getBoard(Number(c.req.param("id")));
  if (!board) return { err: c.json({ ok: false, error: "Papan tidak ditemukan." }, 404) };
  if (!boardAccess(c, board)) return { err: c.json({ ok: false, error: "Tidak punya akses." }, 403) };
  const card = getCard(Number(c.req.param("cardId")));
  if (!card || card.board_id !== board.id) return { err: c.json({ ok: false, error: "Kartu tidak ditemukan." }, 404) };
  return { board, card };
}

app.get("/api/boards/:id/cards/:cardId/comments", (c) => {
  const result = getAccessibleCard(c);
  if ("err" in result) return result.err;
  return c.json({ ok: true, comments: listComments(result.card.id), comments_count: countComments(result.card.id) });
});

app.post("/api/boards/:id/cards/:cardId/comments", async (c) => {
  const result = getAccessibleCard(c);
  if ("err" in result) return result.err;
  const data = await c.req.json().catch(() => ({}));
  const body = String(data.body ?? "").trim();
  if (!body) return c.json({ ok: false, error: "Komentar tidak boleh kosong." }, 400);
  if (body.length > 2000) return c.json({ ok: false, error: "Komentar maksimal 2.000 karakter." }, 400);
  const comment = createComment(result.card.id, { author_name: data.author_name, body });
  const comments_count = countComments(result.card.id);
  broadcast(result.board.id, { type: "comment.added", comment, comments_count });
  return c.json({ ok: true, comment, comments_count });
});

// ---------- upload ----------

app.post("/api/upload", async (c) => {
  const u = currentUser(c);
  const boardId = Number(c.req.query("board") || 0);
  const token = c.req.query("token") || "";
  const board = boardId ? getBoard(boardId) : null;
  const allowed = u || (board && canAccessBoard(board, null, token));
  if (!allowed) return c.json({ ok: false, error: "Tidak punya akses mengunggah." }, 403);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ ok: false, error: "Tidak ada file." }, 400);
  const result = await saveUpload(file);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true, url: result.url });
});

// ---------- halaman & file statis ----------

app.get("/app.js", (c) => servePublicFile("app.js", "text/javascript; charset=utf-8"));
app.get("/style.css", (c) => servePublicFile("style.css", "text/css; charset=utf-8"));
app.get("/uploads/:name", async (c) => {
  const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "");
  const file = Bun.file(join(import.meta.dir, "..", "uploads", name));
  if (!(await file.exists())) return c.notFound();
  return new Response(file);
});
// SPA: / dan /b/<token> -> index.html
app.get("/", (c) => servePublicFile("index.html", "text/html; charset=utf-8"));
app.get("/b/:token", (c) => servePublicFile("index.html", "text/html; charset=utf-8"));

// ---------- server: HTTP via Hono, WS via Bun native ----------

interface WsData { boardId: number; clientId: string; userId: number | null }

const server = Bun.serve<WsData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const boardId = Number(url.searchParams.get("board") || 0);
      const token = url.searchParams.get("token") || "";
      const access = checkWsAccess(boardId, token, req.headers.get("cookie") || "");
      if (!access) return new Response("Akses ditolak.", { status: 403 });
      const upgraded = server.upgrade(req, {
        data: { boardId, clientId: crypto.randomUUID(), userId: access.userId },
      });
      if (!upgraded) return new Response("Gagal upgrade WebSocket.", { status: 500 });
      return undefined as unknown as Response;
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) { joinRoom(ws); },
    message(ws: ServerWebSocket<WsData>, message) { handleWsMessage(ws, message as string); },
    close(ws: ServerWebSocket<WsData>) { leaveRoom(ws); },
  },
});

// Jaga: tabel users kosong -> ingatkan buat user via skrip.
if (countUsers() === 0) {
  console.log("[GezyBoard] Belum ada user. Buat pemilik dengan: bun run scripts/create-user.ts <username> <password>");
}
console.log(`[GezyBoard] Berjalan di http://localhost:${PORT}`);
console.log(`[GezyBoard] ${FOOTER}`);
