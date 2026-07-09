import { getDb } from "./database";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import bcrypt from "bcryptjs";

export interface User {
  id: string;
  name: string;
  email: string;
  token: string;
  password_hash: string | null;
  role: string;
  created_at: string;
}

function generateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function generatePassword(): string {
  return crypto.randomBytes(8).toString("base64url");
}

export function createUser(name: string, email: string, role = "viewer"): User {
  const db = getDb();
  const id = uuidv4();
  const token = generateToken();
  db.prepare("INSERT INTO users (id, name, email, token, role) VALUES (?, ?, ?, ?, ?)").run(id, name, email, token, role);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
}

export function createUserWithPassword(name: string, email: string, password: string, role = "viewer"): User {
  const db = getDb();
  const id = uuidv4();
  const token = generateToken();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (id, name, email, token, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, email, token, password_hash, role);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
}

export function verifyPassword(email: string, password: string): User | null {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
  if (!user) return null;
  // If user has no password_hash, fall back to token check (backward compat)
  if (!user.password_hash) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return user;
}

export function getUserByEmail(email: string): User | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
}

export function listUsers(): User[] {
  const db = getDb();
  return db.prepare("SELECT * FROM users ORDER BY created_at").all() as User[];
}

export function getUserByToken(token: string): User | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE token = ?").get(token) as User | undefined;
}

export function removeUserByEmail(email: string): void {
  const db = getDb();
  db.prepare("DELETE FROM users WHERE email = ?").run(email);
}

export function ensureAdminExists(adminToken: string): void {
  const db = getDb();
  const password_hash = bcrypt.hashSync(adminToken, 10);
  const existing = db.prepare("SELECT id, password_hash FROM users WHERE email = 'admin@afort.local'").get() as { id: string; password_hash: string | null } | undefined;

  if (!existing) {
    // No admin yet — create one
    const id = uuidv4();
    db.prepare("INSERT INTO users (id, name, email, token, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, "Admin", "admin@afort.local", adminToken, password_hash, "admin"
    );
  } else if (!existing.password_hash) {
    // Admin exists but has no password (created before password auth) — set it now
    db.prepare("UPDATE users SET password_hash = ?, token = ? WHERE id = ?").run(password_hash, adminToken, existing.id);
  }
}

export { generatePassword };
