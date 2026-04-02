import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { authMiddleware } from "./middleware/auth";
import authRoutes from "./routes/auth";
import conversationRoutes from "./routes/conversations";
import chatRoutes from "./routes/chat";
import appRoutes from "./routes/apps";
import appSessionRoutes from "./routes/app-sessions";
import spotifyOAuthRoutes from "./routes/oauth-spotify";
import wsRoutes from "./routes/ws-chat";

export { ChatSession } from "./chat-session";

type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const app = new Hono<AppEnv>();

app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.route("/api/auth", authRoutes);
app.route("/api/oauth/spotify", spotifyOAuthRoutes);

app.use("/api/conversations/*", authMiddleware);
app.use("/api/chat/*", authMiddleware);
app.use("/api/apps/*", authMiddleware);
app.use("/api/app-sessions/*", authMiddleware);

app.route("/api/conversations", conversationRoutes);
app.route("/api/chat", chatRoutes);
app.route("/ws", wsRoutes);
app.route("/api/apps", appRoutes);
app.route("/api/app-sessions", appSessionRoutes);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
