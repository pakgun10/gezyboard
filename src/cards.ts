import { db, type Card } from "./db";
import { getSection } from "./sections";

const KINDS = ["text", "image", "link"] as const;
const COLORS = ["yellow", "pink", "green", "blue", "purple", "orange"] as const;

export interface CardInput {
  kind?: string;
  title?: string;
  body?: string;
  media_url?: string;
  link_url?: string;
  color?: string;
  author_name?: string;
  section_id?: number | null;
}

function clean(input: CardInput) {
  return {
    kind: (KINDS as readonly string[]).includes(input.kind ?? "") ? input.kind! : "text",
    title: (input.title ?? "").toString().slice(0, 200),
    body: (input.body ?? "").toString().slice(0, 5000),
    media_url: (input.media_url ?? "").toString().slice(0, 500),
    link_url: (input.link_url ?? "").toString().slice(0, 500),
    color: (COLORS as readonly string[]).includes(input.color ?? "") ? input.color! : "yellow",
    author_name: (input.author_name ?? "").toString().trim().slice(0, 50) || "Anonim",
  };
}

export function listCards(boardId: number): Card[] {
  return db
    .prepare("SELECT * FROM cards WHERE board_id = ? ORDER BY position ASC, id ASC")
    .all(boardId) as Card[];
}

export function getCard(id: number): Card | null {
  return (db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Card) ?? null;
}

// position: kelipatan 1000, dihitung PER BAGIAN (atau per papan untuk mode wall).
// Kartu baru ditaruh paling belakang di bagiannya.
export function createCard(boardId: number, input: CardInput): Card {
  const c = clean(input);
  let sectionId: number | null = null;
  if (input.section_id !== undefined && input.section_id !== null) {
    const sec = getSection(Number(input.section_id));
    if (!sec || sec.board_id !== boardId) throw new Error("Bagian tidak valid.");
    sectionId = sec.id;
  }
  const scope =
    sectionId === null
      ? { sql: "board_id = ? AND section_id IS NULL", params: [boardId] as unknown[] }
      : { sql: "board_id = ? AND section_id = ?", params: [boardId, sectionId] as unknown[] };
  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE ${scope.sql}`)
    .get(...scope.params) as { m: number };
  const position = Math.floor(maxPos.m / 1000) * 1000 + 1000;
  const stmt = db.prepare(
    "INSERT INTO cards (board_id, author_name, kind, title, body, media_url, link_url, color, position, section_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(boardId, c.author_name, c.kind, c.title, c.body, c.media_url, c.link_url, c.color, position, sectionId) as Card;
}

export function updateCard(id: number, input: CardInput): Card | null {
  const c = clean(input);
  db.prepare(
    "UPDATE cards SET kind = ?, title = ?, body = ?, media_url = ?, link_url = ?, color = ?, author_name = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(c.kind, c.title, c.body, c.media_url, c.link_url, c.color, c.author_name, id);
  return getCard(id);
}

export function moveCard(id: number, position: number, sectionId?: number | null): Card | null {
  const existing = getCard(id);
  if (!existing) return null;
  const pos = Number.isFinite(position) ? position : 0;
  if (sectionId === undefined) {
    // pindah posisi saja, bagian tidak berubah (kompatibel wall lama)
    db.prepare("UPDATE cards SET position = ?, updated_at = datetime('now') WHERE id = ?").run(pos, id);
  } else if (sectionId === null) {
    db.prepare("UPDATE cards SET position = ?, section_id = NULL, updated_at = datetime('now') WHERE id = ?").run(pos, id);
  } else {
    const sec = getSection(Number(sectionId));
    if (!sec || sec.board_id !== existing.board_id) throw new Error("Bagian tidak valid.");
    db.prepare("UPDATE cards SET position = ?, section_id = ?, updated_at = datetime('now') WHERE id = ?").run(pos, sec.id, id);
  }
  return getCard(id);
}

export function deleteCard(id: number): void {
  db.prepare("DELETE FROM cards WHERE id = ?").run(id);
}
