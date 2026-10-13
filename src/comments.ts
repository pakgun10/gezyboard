import { db } from "./db";

export interface BoardComment {
  id: number;
  card_id: number;
  author_name: string;
  body: string;
  created_at: string;
}

export interface CommentInput {
  author_name?: string;
  body?: string;
}

function clean(input: CommentInput): { author_name: string; body: string } {
  return {
    author_name: String(input.author_name ?? "").trim().slice(0, 50) || "Anonim",
    body: String(input.body ?? "").trim().slice(0, 2000),
  };
}

export function listComments(cardId: number): BoardComment[] {
  return db
    .prepare("SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC, id ASC")
    .all(cardId) as BoardComment[];
}

export function countComments(cardId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM comments WHERE card_id = ?").get(cardId) as { n: number }).n;
}

export function createComment(cardId: number, input: CommentInput): BoardComment {
  const c = clean(input);
  if (!c.body) throw new Error("Komentar tidak boleh kosong.");
  return db
    .prepare("INSERT INTO comments (card_id, author_name, body) VALUES (?, ?, ?) RETURNING *")
    .get(cardId, c.author_name, c.body) as BoardComment;
}
