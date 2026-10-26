// Serves web/ on http://localhost (a secure context, so WebAuthn works) plus the local ethers bundle.
// Also serves /relay, the lab's testnet relayer, when a relayer key is configured (see scripts/relay.js).
// Usage: node scripts/serve.js [port]
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createRelay } = require("./relay");

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const WEB = path.join(__dirname, "..", "web");
const VENDOR = { "/vendor/ethers.umd.min.js": path.join(__dirname, "..", "node_modules", "ethers", "dist", "ethers.umd.min.js") };
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const relay = createRelay(`http://localhost:${PORT}`);

function resolve(pathname) {
  if (VENDOR[pathname]) return VENDOR[pathname];
  // A path ending in / (/, /lab/, /blog/, /blog/<slug>/) serves that directory's index.html.
  const file = path.join(WEB, pathname.endsWith("/") ? decodeURIComponent(pathname) + "index.html" : decodeURIComponent(pathname));
  return file.startsWith(WEB + path.sep) ? file : null;
}

http
  .createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/relay") {
      if (relay) return relay.handle(req, res);
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "No relayer key: set LAB_RELAYER_KEY or SEPOLIA_ETH_KEY in .env" }));
    }
    const file = resolve(pathname);
    // A folder without its trailing slash (/lab, /blog): redirect, as static hosts do, so relative links resolve.
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      res.writeHead(301, { Location: pathname + "/" });
      return res.end();
    }
    const type = file && TYPES[path.extname(file)];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(pathname === "/deployment.json" ? "Not deployed yet: run npm run deploy" : "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Vestige lab: http://localhost:${PORT}`);
    console.log(relay ? `Testnet relayer: ${relay.address}` : "Testnet relayer: none (no key in .env)");
  });
