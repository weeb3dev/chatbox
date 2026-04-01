import type { ServerMessage } from "../../types";

export function formatSSEEvent(data: ServerMessage): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function createSSEResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
