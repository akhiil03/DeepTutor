import { connection } from "next/server";
import { upgradeWebSocket, type WebSocketData } from "@vercel/functions";
import WebSocket from "ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The browser always talks to /ws on its own origin. On Vercel that request
// lands here instead of the (unsupported) Next rewrite to the API host, and we
// bridge it to the FastAPI WebSocket so cookies and messages keep flowing.
function upstreamUrl(request: Request): string | null {
  const base =
    process.env.DEEPTUTOR_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE ??
    "";
  if (!base) return null;

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, base);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

export async function GET(request: Request) {
  await connection();

  if (!process.env.VERCEL) {
    return new Response("WebSocket tunnel is only available on Vercel", {
      status: 501,
    });
  }

  const target = upstreamUrl(request);
  if (!target) {
    return new Response("DEEPTUTOR_API_BASE_URL is not configured", {
      status: 503,
    });
  }

  const cookie = request.headers.get("cookie") ?? "";
  const authorization = request.headers.get("authorization") ?? "";

  return upgradeWebSocket(
    (ws) => {
      const upstream = new WebSocket(target, {
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(authorization ? { authorization } : {}),
        },
      });

      const pending: WebSocketData[] = [];
      let open = false;

      const close = () => {
        try {
          ws.close();
        } catch {}
        try {
          upstream.terminate();
        } catch {}
      };

      upstream.on("open", () => {
        open = true;
        for (const message of pending) upstream.send(message as never);
        pending.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        try {
          ws.send(isBinary ? (data as WebSocketData) : data.toString());
        } catch {
          close();
        }
      });
      upstream.on("close", close);
      upstream.on("error", close);

      ws.on("message", (data: WebSocketData) => {
        if (open) {
          upstream.send(data as never);
        } else {
          pending.push(data);
        }
      });
      ws.on("close", close);
      ws.on("error", close);
    },
    // Chat attachments travel base64 inside one frame; mirror the proxy's body
    // budget so a single allowed upload is not severed here.
    { maxPayload: 210 * 1024 * 1024 },
  );
}
