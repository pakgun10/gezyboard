import { db, type Section } from "./db";

export function listSections(boardId: number): Section[] {
  return db
    .prepare("SELECT * FROM sections WHERE board_id = ? ORDER BY position ASC, id ASC")
    .all(boardId) as Section[];
}

export function getSection(id: number): Section | null {
  return (db.prepare("SELECT * FROM sections WHERE id = ?").get(id) as Section) ?? null;
}

// position: kelipatan 1000. Bagian baru ditaruh paling kanan.
export function createSection(boardId: number, title: string): Section {
  const t = title.trim().slice(0, 200) || "Bagian Baru";
  const maxPos = db
    .prepare("SELECT COALESCE(MAX(position), 0) AS m FROM sections WHERE board_id = ?")
    .get(boardId) as { m: number };
  const position = Math.floor(maxPos.m / 1000) * 1000 + 1000;
  const stmt = db.prepare(
    "INSERT INTO sections (board_id, title, position) VALUES (?, ?, ?) RETURNING *"
  );
  return stmt.get(boardId, t, position) as Section;
}

export function updateSection(id: number, title: string): Section | null {
  const t = title.trim().slice(0, 200);
  if (!t) return getSection(id);
  db.prepare("UPDATE sections SET title = ? WHERE id = ?").run(t, id);
  return getSection(id);
}

export function moveSection(id: number, position: number): Section | null {
  const pos = Number.isFinite(position) ? position : 0;
  db.prepare("UPDATE sections SET position = ? WHERE id = ?").run(pos, id);
  return getSection(id);
}

// Hapus bagian; semua kartu di dalamnya ikut terhapus (CASCADE).
// Mengembalikan id kartu-kartu yang ikut terhapus agar bisa disiarkan.
export function deleteSection(id: number): number[] {
  const cards = db.prepare("SELECT id FROM cards WHERE section_id = ?").all(id) as { id: number }[];
  const cardIds = cards.map((c) => c.id);
  db.prepare("DELETE FROM cards WHERE section_id = ?").run(id);
  db.prepare("DELETE FROM sections WHERE id = ?").run(id);
  return cardIds;
}
