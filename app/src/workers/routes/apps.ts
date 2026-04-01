import { Hono } from "hono";
import type { Env } from "../../types";

type AppsApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const apps = new Hono<AppsApp>();

apps.get("/", async (c) => {
  return c.json({ status: "ok", message: "Apps list stub — Phase 4" });
});

apps.post("/register", async (c) => {
  return c.json({
    status: "ok",
    message: "App registration stub — Phase 4",
  });
});

apps.get("/:id/manifest", async (c) => {
  return c.json({ status: "ok", message: "App manifest stub — Phase 4" });
});

export default apps;
