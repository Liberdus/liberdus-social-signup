const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || "liberdus-social-signup-prod",
      cwd: repoRoot,
      script: path.join(repoRoot, "backend", "server.js"),
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    },
  ],
};
