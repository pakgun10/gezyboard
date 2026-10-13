import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT, "data");
const UPLOAD_DIR = join(ROOT, "uploads");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

export const UPLOAD_DIR_PATH = UPLOAD_DIR;

export const db = new Database(join(DATA_DIR, "gezyboard.db"), { create: true });

// WAJIB: WAL agar tulis konkuren dari banyak koneksi WebSocket tidak terkunci.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  share_token TEXT UNIQUE NOT NULL,
  share_mode TEXT DEFAULT 'link',
  layout TEXT DEFAULT 'wall',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  author_name TEXT DEFAULT 'Anonim',
  kind TEXT DEFAULT 'text',
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  media_url TEXT DEFAULT '',
  link_url TEXT DEFAULT '',
  color TEXT DEFAULT 'yellow',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id, position);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_name TEXT DEFAULT 'Anonim',
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id, created_at, id);

-- Penyimpangan kecil dari rancangan: tabel sessions agar login pemilik
-- tetap bertahan setelah server restart.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Fase 2: layout shelf — tabel sections (bagian/kolom per papan).
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sections_board ON sections(board_id, position);
`);

 // Migrasi Fase 2: kolom cards.section_id (NULL = mode wall, tetap kompatibel).
const cardCols = db.prepare("PRAGMA table_info(cards)").all() as { name: string }[];
if (!cardCols.some((c) => c.name === "section_id")) {
  db.exec("ALTER TABLE cards ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE");
}

export interface User { id: number; username: string; password_hash: string; created_at: string }
export interface Board {
  id: number; owner_id: number; title: string; description: string;
  share_token: string; share_mode: string; layout: string; created_at: string;
}
export interface Card {
  id: number; board_id: number; author_name: string; kind: string;
  title: string; body: string; media_url: string; link_url: string;
  color: string; position: number; section_id: number | null;
  created_at: string; updated_at: string; comments_count?: number;
}

export interface Section {
  id: number; board_id: number; title: string; position: number; created_at: string;
}
