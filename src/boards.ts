import { db, type Board } from "./db";

const SHARE_MODES = ["private", "link", "public"] as const;
const LAYOUTS = ["wall", "shelf"] as const;
const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function newShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function todayInJakarta(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function normalizeDeadline(value: unknown): string | null {
  const deadline = String(value ?? "").trim();
  if (!DEADLINE_PATTERN.test(deadline)) return null;
  const [year, month, day] = deadline.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return deadline;
}

export function isSubmissionOpen(board: Board): boolean {
  return !board.submission_deadline || board.submission_deadline >= todayInJakarta();
}

export function canSubmitToBoard(board: Board, userId: number | null, token: string): boolean {
  if (!canAccessBoard(board, userId, token)) return false;
  if (userId !== null && board.owner_id === userId) return true;
  return isSubmissionOpen(board);
}

export function createBoard(ownerId: number, title: string, description = "", shareMode = "link", submissionDeadline: string | null = null): Board {
  const mode = (SHARE_MODES as readonly string[]).includes(shareMode) ? shareMode : "link";
  const stmt = db.prepare(
    "INSERT INTO boards (owner_id, title, description, share_token, share_mode, submission_deadline) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(ownerId, title.trim() || "Papan Tanpa Judul", description.trim(), newShareToken(), mode, submissionDeadline) as Board;
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

export function updateBoard(id: number, fields: { title?: string; description?: string; share_mode?: string; layout?: string; submission_deadline?: string | null }): Board | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); vals.push(fields.title.trim() || "Papan Tanpa Judul"); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description.trim()); }
  if (fields.share_mode !== undefined && (SHARE_MODES as readonly string[]).includes(fields.share_mode)) {
    sets.push("share_mode = ?"); vals.push(fields.share_mode);
  }
  if (fields.layout !== undefined && (LAYOUTS as readonly string[]).includes(fields.layout)) {
    sets.push("layout = ?"); vals.push(fields.layout);
  }
  if (fields.submission_deadline === null) {
    sets.push("submission_deadline = ?"); vals.push(fields.submission_deadline);
  } else if (fields.submission_deadline !== undefined && DEADLINE_PATTERN.test(fields.submission_deadline)) {
    sets.push("submission_deadline = ?"); vals.push(fields.submission_deadline);
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
    submission_deadline: board.submission_deadline,
    submission_open: isSubmissionOpen(board),
  };
}
