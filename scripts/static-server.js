const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const host = process.env.STATIC_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.STATIC_PORT || "5503", 10);
const root = path.join(__dirname, "..", "frontend");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function isE2ETestMode() {
  return /^(1|true|yes)$/iu.test(String(process.env.E2E_TEST_MODE || "").trim());
}

function getE2EConfig() {
  const apiBaseUrl = String(process.env.E2E_API_BASE_URL || "http://127.0.0.1:8789").replace(/\/+$/u, "");
  return {
    apiBaseUrl,
    xAuth: {
      enabled: false,
      backendUrl: apiBaseUrl,
      redirectUri: ""
    },
    discordAuth: {
      enabled: true,
      membershipConfigured: true
    },
    telegramAuth: { enabled: false, botUsername: "", botId: "", membershipConfigured: false },
    linkedinAuth: { enabled: false },
    githubAuth: { enabled: false, targetRepo: "Liberdus/web-client-v2", targetOrg: "Liberdus" },
    youtubeAuth: {
      enabled: false,
      targetChannelHandle: "Liberdus",
      targetChannelId: "",
      targetChannelUrl: "https://www.youtube.com/@Liberdus"
    },
    socialLinks: {
      x: "https://x.com/liberdus",
      discord: "https://liberdus.com/discord",
      telegram: "https://t.me/LiberdusOfficial",
      linkedin: "https://www.linkedin.com/company/liberdus",
      github: "https://github.com/Liberdus",
      githubOrg: "https://github.com/Liberdus",
      githubRepo: "https://github.com/Liberdus/web-client-v2",
      youtube: "https://www.youtube.com/@Liberdus",
      coinMarketCap: "https://coinmarketcap.com/community/profile/Liberdus/"
    }
  };
}

function getFilePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, `http://${host}:${port}`).pathname);
  } catch {
    return null;
  }

  let publicPath = pathname;
  if (publicPath === "/frontend") {
    publicPath = "/";
  } else if (publicPath.startsWith("/frontend/")) {
    publicPath = publicPath.slice("/frontend".length);
  }

  const relative = publicPath === "/" || publicPath.endsWith("/")
    ? `${publicPath.replace(/^\/+/u, "")}index.html`
    : publicPath.replace(/^\/+/u, "");
  const resolved = path.resolve(root, relative);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) return null;
  if (relativeToRoot.split(path.sep).some((segment) => segment.startsWith("."))) return null;
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
      if (error.code === "ENOENT" && filePath === path.join(root, "config.local.json")) {
        if (isE2ETestMode()) {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
          });
          response.end(`${JSON.stringify(getE2EConfig())}\n`);
          return;
        }
        response.writeHead(204, {
          "Cache-Control": "no-store"
        });
        response.end();
        return;
      }
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
