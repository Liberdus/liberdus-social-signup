const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const host = process.env.STATIC_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.STATIC_PORT || "5503", 10);
const root = path.join(__dirname, "..");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function getFilePath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, `http://${host}:${port}`).pathname);
  const relative = pathname === "/" || pathname.endsWith("/")
    ? `${pathname.replace(/^\/+/u, "")}index.html`
    : pathname.replace(/^\/+/u, "");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

http.createServer((request, response) => {
  const filePath = getFilePath(request.url);
  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  });
}).listen(port, host, () => {
  console.log(`Static server listening at http://${host}:${port}/frontend/`);
});
