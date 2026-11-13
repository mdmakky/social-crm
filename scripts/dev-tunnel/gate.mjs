// Allow-list gate in front of the API for the public tunnel. Only the two Meta webhook paths are forwarded; everything else is 404,
// so signup, login and the whole /v1 API are never reachable through the tunnel. Development only.
import http from "node:http";

const PORT = Number(process.env.GATE_PORT ?? 8788);
const TARGET = new URL(process.env.GATE_TARGET ?? "http://127.0.0.1:8787");
const ALLOWED = /^\/webhooks\/meta\/(messenger|instagram)(\?[^\s]*)?$/;
const FORWARD_HEADERS = ["content-type", "content-length", "x-hub-signature-256", "x-hub-signature", "user-agent"];

http
  .createServer((req, res) => {
    if (!ALLOWED.test(req.url ?? "") || (req.method !== "GET" && req.method !== "POST")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const headers = Object.fromEntries(FORWARD_HEADERS.filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]]));
    const up = http.request({ host: TARGET.hostname, port: TARGET.port, path: req.url, method: req.method, headers, timeout: 8000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "text/plain" });
      r.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    req.pipe(up);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`gate on 127.0.0.1:${PORT} -> ${TARGET.origin} (webhook paths only)`));
