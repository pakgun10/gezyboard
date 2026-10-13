import { db, type Board } from "./db";

const SHARE_MODES = ["private", "link", "public"] as const;

export function newShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function createBoard(ownerId: number, title: string, description = "", shareMode = "link"): Board {
  const mode = (SHARE_MODES as readonly string[]).includes(shareMode) ? shareMode : "link";
  const stmt = db.prepare(
    "INSERT INTO boards (owner_id, title, description, share_token, share_mode) VALUES (?, ?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(ownerId, title.trim() || "Papan Tanpa Judul", description.trim(), newShareToken(), mode) as Board;
}

export function getBoard(id: number): Board | null {
  return (db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as Board) ?? null;
}

export function getBoardByToken(token: string): Board | null {
  if (!token) return null;
  return (db.prepare("SELECT * FROM boards WHERE share_token = ?").get(token) as Board) ?? null;
}

export function listBoardsByOwner(ownerId: number): Board[] {
  return db.prepare("SELECT * FROM boards WHERE owner_id = ? ORDER BY id DESC").all(ownerId) as Board[];
}

export function updateBoard(id: number, fields: { title?: string; description?: string; share_mode?: string }): Board | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title.trim() || "Papan Tanpa Judul"); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description.trim()); }
  if (fields.share_mode !== undefined && (SHARE_MODES as readonly string[]).includes(fields.share_mode)) {
    sets.push("share_mode = ?"); vals.push(fields.share_mode);
  }
  if (sets.length === 0) return getBoard(id);
  vals.push(id);
  db.prepare(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getBoard(id);
}

export function deleteBoard(id: number): void {
  db.prepare("DELETE FROM boards WHERE id = ?").run(id);
}

// Boleh akses papan? Pemilik selalu boleh. Selain itu: token cocok DAN mode bukan 'private'.
export function canAccessBoard(board: Board, userId: number | null, token: string): boolean {
  if (userId !== null && board.owner_id === userId) return true;
  if (board.share_mode === "private") return false;
  return token !== "" && token === board.share_token;
}

export function boardPublicView(board: Board) {
  return {
    id: board.id,
    title: board.title,
    description: board.description,
    share_mode: board.share_mode,
    layout: board.layout,
    share_token: board.share_token,
    created_at: board.created_at,
  };
}
