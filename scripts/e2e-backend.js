const fs = require("node:fs");
const path = require("node:path");

const dbPath = process.env.SIGNUP_DB_PATH || path.join("data", "e2e-signup.sqlite");
process.env.SIGNUP_DB_PATH = dbPath;
process.env.E2E_TEST_MODE = "true";

for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(path.resolve(dbPath + suffix), { force: true });
}

require("../backend/server");
