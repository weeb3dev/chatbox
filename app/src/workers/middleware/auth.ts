import { createMiddleware } from "hono/factory";
import type { Env } from "../../types";
import { verifyJWT } from "../lib/crypto";

type AuthEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    // 403 instead of 401: miniflare/undici bug crashes POST+401 in local dev
    return c.json({ error: "Missing or invalid Authorization header" }, 403);
  }

  const token = header.slice(7);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 403);
  }

  c.set("userId", payload.userId);
  c.set("email", payload.email);
  await next();
});
