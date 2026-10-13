import { db, type User } from "./db";

export const SESSION_COOKIE = "gezyboard_session";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function createUser(username: string, passwordHash: string): User {
  const stmt = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING *");
  return stmt.get(username, passwordHash) as User;
}

export function getUserByUsername(username: string): User | null {
  return (db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User) ?? null;
}

export function getUserById(id: number): User | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User) ?? null;
}

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function createSession(userId: number): string {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires);
  return token;
}

export function getUserBySession(token: string): User | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')")
    .get(token) as User | null;
  return row ?? null;
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// Ambil token sesi dari header Cookie mentah (dipakai saat upgrade WebSocket).
export function sessionTokenFromCookieHeader(cookieHeader: string): string {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}
