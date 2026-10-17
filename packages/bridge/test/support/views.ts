/**
 * Helpers for the viewer tests (LA-1): a raw GET that sends exactly the headers given (fetch adds its own), and a tiny
 * HTTP server for a fake upstream (the bridge for tb-views, an app for the bridge route).
 */
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RawResponse {
  status: number;
  /** every value of every header, lower-case names */
  headers: Record<string, string[]>;
  body: Buffer;
  text: string;
}

/** GET `url` (a full URL) with exactly `headers`, the path sent as given (no normalisation by the client). */
export function rawGet(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // `path` is passed raw so tests can send `..`, `%5F`, `//` as an attacker would
    const rawPath = url.slice(url.indexOf(u.host) + u.host.length) || "/";
    const req = request({ host: u.hostname, port: u.port, path: rawPath, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: { ...res.headersDistinct } as Record<string, string[]>, body, text: body.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export const first = (r: RawResponse, name: string): string | undefined => r.headers[name]?.[0];

export interface Fake {
  url: string;
  server: Server;
  /** every request received: method, raw url, headers */
  seen: { method: string; url: string; headers: IncomingMessage["headers"] }[];
  close(): Promise<void>;
}

/** A fake upstream on a free loopback port. */
export async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
