import { DurableObject } from "cloudflare:workers";

export class ChatSession extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    return new Response("ChatSession DO stub");
  }
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ status: "ok", message: "ChatBridge API" });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
