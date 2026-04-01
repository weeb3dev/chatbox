import { Hono } from "hono";
import type { Env } from "../../types";
import { hashPassword, verifyPassword, signJWT } from "../lib/crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthApp = {
  Bindings: Env;
};

const auth = new Hono<AuthApp>();

auth.post("/register", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    displayName?: string;
  }>();

  const { email, password, displayName } = body;

  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format" }, 400);
  }
  if (!password || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE email = ?",
  )
    .bind(email)
    .first();

  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)",
  )
    .bind(id, email, passwordHash, displayName ?? null)
    .run();

  const token = await signJWT({ userId: id, email }, c.env.JWT_SECRET);

  return c.json(
    { token, user: { id, email, displayName: displayName ?? null } },
    201,
  );
});

auth.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const { email, password } = body;

  if (!email || !password) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, email, password_hash, display_name FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string | null;
    }>();

  if (!row) {
    // 403 instead of 401: miniflare/undici bug crashes POST+401 in local dev
    return c.json({ error: "Invalid credentials" }, 403);
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 403);
  }

  const token = await signJWT(
    { userId: row.id, email: row.email },
    c.env.JWT_SECRET,
  );

  return c.json({
    token,
    user: { id: row.id, email: row.email, displayName: row.display_name },
  });
});

export default auth;
