import { Hono } from "hono";
import type { Env } from "../../types";

type ChatApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const chat = new Hono<ChatApp>();

chat.post("/", async (c) => {
  return c.json({ status: "ok", message: "Chat endpoint stub — Phase 2" });
});

chat.post("/tool-result", async (c) => {
  return c.json({
    status: "ok",
    message: "Tool result endpoint stub — Phase 2",
  });
});

export default chat;
