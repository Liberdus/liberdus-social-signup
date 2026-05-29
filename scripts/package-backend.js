const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const defaultOutDir = path.join(repoRoot, "dist", "backend-deploy");

const args = process.argv.slice(2);
const options = {
  outDir: defaultOutDir,
  archive: false,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--archive") {
    options.archive = true;
  } else if (arg === "--out") {
    const value = args[index + 1];
    if (!value) usage("Missing value for --out.");
    options.outDir = path.resolve(repoRoot, value);
    index += 1;
  } else if (arg.startsWith("--out=")) {
    options.outDir = path.resolve(repoRoot, arg.slice("--out=".length));
  } else if (arg === "--help" || arg === "-h") {
    usage(null, 0);
  } else {
    usage(`Unknown option: ${arg}`);
  }
}

const outDir = options.outDir;

if (outDir === repoRoot || !outDir.startsWith(`${repoRoot}${path.sep}`)) {
  throw new Error(`Refusing to write outside the repo: ${outDir}`);
}

const requiredEntries = [
  "backend",
  "package.json",
  "package-lock.json",
  ".env.production.example",
];

const forbiddenTopLevelEntries = [
  ".env",
  ".git",
  "cache",
  "data",
  "frontend",
  "node_modules",
  "test",
  "vendor",
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const entry of requiredEntries) {
  copyEntry(path.join(repoRoot, entry), path.join(outDir, entry));
}

validatePackage(outDir);

if (options.archive) {
  createArchive(outDir);
}

console.log(`Backend deploy package written to ${path.relative(repoRoot, outDir)}`);
console.log("Included:");
for (const entry of requiredEntries) {
  console.log(`- ${entry}`);
}

function usage(message, exitCode = 1) {
  if (message) console.error(message);
  console.error("Usage: node scripts/package-backend.js [--out dist/backend-deploy] [--archive]");
  process.exit(exitCode);
}

function copyEntry(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required deploy entry is missing: ${path.relative(repoRoot, source)}`);
  }
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, {
      recursive: true,
      filter: (candidate) => {
        const basename = path.basename(candidate);
        return basename !== ".DS_Store";
      },
    });
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function validatePackage(packageDir) {
  for (const entry of requiredEntries) {
    if (!fs.existsSync(path.join(packageDir, entry))) {
      throw new Error(`Deploy package validation failed; missing ${entry}`);
    }
  }

  for (const entry of forbiddenTopLevelEntries) {
    if (fs.existsSync(path.join(packageDir, entry))) {
      throw new Error(`Deploy package validation failed; forbidden entry copied: ${entry}`);
    }
  }

  const backendServer = path.join(packageDir, "backend", "server.js");
  const pm2Config = path.join(packageDir, "backend", "pm2.config.cjs");
  if (!fs.existsSync(backendServer) || !fs.existsSync(pm2Config)) {
    throw new Error("Deploy package validation failed; backend entrypoints are missing.");
  }
}

function createArchive(packageDir) {
  const archivePath = `${packageDir}.tar.gz`;
  fs.rmSync(archivePath, { force: true });
  spawnSync("xattr", ["-cr", packageDir], { stdio: "ignore" });
  const result = spawnSync("tar", [
    "-czf",
    archivePath,
    "-C",
    path.dirname(packageDir),
    path.basename(packageDir),
  ], {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to create archive: ${archivePath}`);
  }
  console.log(`Archive written to ${path.relative(repoRoot, archivePath)}`);
}
