import type { ServerWebSocket } from "bun";
import { getBoard, canAccessBoard } from "./boards";
import { getUserBySession, sessionTokenFromCookieHeader } from "./auth";
import { listCards, createCard, updateCard, moveCard, deleteCard, getCard } from "./cards";
import { listSections, createSection, updateSection, moveSection, deleteSection, getSection } from "./sections";

interface WsData {
  boardId: number;
  clientId: string;
  userId: number | null;
}

type RoomSocket = ServerWebSocket<WsData>;

// Satu room per papan: boardId -> sekumpulan koneksi.
const rooms = new Map<number, Set<RoomSocket>>();

function roomOf(boardId: number): Set<RoomSocket> {
  let r = rooms.get(boardId);
  if (!r) { r = new Set(); rooms.set(boardId, r); }
  return r;
}

export function roomSize(boardId: number): number {
  return rooms.get(boardId)?.size ?? 0;
}

export function broadcast(boardId: number, payload: unknown): void {
  const msg = JSON.stringify(payload);
  for (const ws of rooms.get(boardId) ?? []) {
    try { ws.send(msg); } catch { /* abaikan koneksi mati */ }
  }
}

export function joinRoom(ws: RoomSocket): void {
  const { boardId } = ws.data;
  roomOf(boardId).add(ws);
  // sync.full: seluruh bagian + kartu papan dikirim saat baru bergabung (sesuai rancangan §4).
  ws.send(JSON.stringify({ type: "sync.full", sections: listSections(boardId), cards: listCards(boardId) }));
  broadcast(boardId, { type: "presence", count: roomSize(boardId) });
}

export function leaveRoom(ws: RoomSocket): void {
  const { boardId } = ws.data;
  rooms.get(boardId)?.delete(ws);
  if (rooms.get(boardId)?.size === 0) rooms.delete(boardId);
  else broadcast(boardId, { type: "presence", count: roomSize(boardId) });
}

// Validasi akses sebelum upgrade WebSocket. Mengembalikan null bila ditolak.
export function checkWsAccess(boardId: number, token: string, cookieHeader: string): { userId: number | null } | null {
  const board = getBoard(boardId);
  if (!board) return null;
  const sessionToken = sessionTokenFromCookieHeader(cookieHeader);
  const user = getUserBySession(sessionToken);
  const userId = user ? user.id : null;
  if (!canAccessBoard(board, userId, token)) return null;
  return { userId };
}

function sendError(ws: RoomSocket, message: string): void {
  try { ws.send(JSON.stringify({ type: "error", message })); } catch { /* abaikan */ }
}

export function handleWsMessage(ws: RoomSocket, raw: string | Buffer): void {
  let msg: { type?: string; data?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    sendError(ws, "Pesan bukan JSON yang valid.");
    return;
  }
  const { boardId, clientId, userId } = ws.data;
  const board = getBoard(boardId);
  if (!board) { sendError(ws, "Papan tidak ditemukan."); return; }
  // Kelola bagian hanya boleh pemilik papan.
  const isOwner = userId !== null && board.owner_id === userId;
  const needOwner = () => {
    if (!isOwner) { sendError(ws, "Hanya pemilik papan yang boleh mengelola bagian."); return false; }
    return true;
  };

  // Aturan rancangan: tulis ke DB dulu, broadcast sesudahnya.
  try {
    switch (msg.type) {
      case "section.add": {
        if (!needOwner()) break;
        const section = createSection(boardId, String(msg.data?.title ?? ""));
        broadcast(boardId, { type: "section.added", section, by: clientId });
        break;
      }
      case "section.update": {
        if (!needOwner()) break;
        const id = Number(msg.data?.id);
        const existing = getSection(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Bagian tidak ditemukan."); break; }
        const section = updateSection(id, String(msg.data?.title ?? ""));
        broadcast(boardId, { type: "section.updated", section, by: clientId });
        break;
      }
      case "section.move": {
        if (!needOwner()) break;
        const id = Number(msg.data?.id);
        const existing = getSection(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Bagian tidak ditemukan."); break; }
        const section = moveSection(id, Number(msg.data?.position));
        broadcast(boardId, { type: "section.moved", section, by: clientId });
        break;
      }
      case "section.delete": {
        if (!needOwner()) break;
        const id = Number(msg.data?.id);
        const existing = getSection(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Bagian tidak ditemukan."); break; }
        const cardIds = deleteSection(id); // kartu di dalamnya ikut terhapus (CASCADE)
        broadcast(boardId, { type: "section.deleted", id, cardIds, by: clientId });
        break;
      }
      case "card.add": {
        const card = createCard(boardId, (msg.data ?? {}) as never);
        broadcast(boardId, { type: "card.added", card, by: clientId });
        break;
      }
      case "card.update": {
        const id = Number(msg.data?.id);
        const existing = getCard(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Kartu tidak ditemukan."); break; }
        const card = updateCard(id, (msg.data ?? {}) as never);
        broadcast(boardId, { type: "card.updated", card, by: clientId });
        break;
      }
      case "card.move": {
        const id = Number(msg.data?.id);
        const existing = getCard(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Kartu tidak ditemukan."); break; }
        const rawSec = msg.data?.section_id;
        const sectionId = rawSec === undefined ? undefined : rawSec === null ? null : Number(rawSec);
        const card = moveCard(id, Number(msg.data?.position), sectionId);
        broadcast(boardId, { type: "card.moved", card, by: clientId });
        break;
      }
      case "card.delete": {
        const id = Number(msg.data?.id);
        const existing = getCard(id);
        if (!existing || existing.board_id !== boardId) { sendError(ws, "Kartu tidak ditemukan."); break; }
        deleteCard(id);
        broadcast(boardId, { type: "card.deleted", id, by: clientId });
        break;
      }
      default:
        sendError(ws, "Tipe pesan tidak dikenal.");
    }
  } catch (e) {
    sendError(ws, "Gagal memproses: " + (e instanceof Error ? e.message : "kesalahan tak dikenal"));
  }
  void userId;
}
