/**
 * Node.js reverse proxy shim for LiteSpeed/cPanel hosting.
 *
 * LiteSpeed does not support Passenger Python WSGI — only Node.js apps work.
 * This script starts gunicorn and proxies all requests to it.
 *
 * cPanel "Setup Node.js App":
 *   - Application root:    repositories/bugsink
 *   - Application startup file: app.js
 */

const http = require("http");
const { execFileSync, spawn } = require("child_process");
const path = require("path");

const APP_DIR = __dirname;

// Detect virtualenv path — cPanel creates it at ~/virtualenv/<app_root>/<version>/
const VENV_BIN = (function () {
  // Try to find the virtualenv by scanning the expected cPanel path
  const fs = require("fs");
  const home = process.env.HOME || "/home/" + process.env.USER;
  const relPath = path.relative(home, APP_DIR);
  const venvBase = path.join(home, "virtualenv", relPath);
  try {
    const versions = fs.readdirSync(venvBase).sort().reverse();
    if (versions.length > 0) {
      return path.join(venvBase, versions[0], "bin");
    }
  } catch (_) {}
  // Fallback: assume Python virtualenv is alongside the app
  return path.join(APP_DIR, "venv", "bin");
})();

const PYTHON = path.join(VENV_BIN, "python");
const GUNICORN = path.join(VENV_BIN, "gunicorn");
const INTERNAL_PORT = 40000 + Math.floor(Math.random() * 10000);
const LISTEN_PORT = process.env.PORT || 3000;

const ENV = Object.assign({}, process.env, {
  DJANGO_SETTINGS_MODULE: "bugsink.settings.passenger",
});

// --- Step 1: Auto-init (migrations + superuser) ---
console.log("[bugsink] Running auto-init...");
try {
  execFileSync(PYTHON, ["manage.py", "migrate", "--no-color"], {
    cwd: APP_DIR,
    env: ENV,
    stdio: "inherit",
    timeout: 120000,
  });
  execFileSync(
    PYTHON,
    ["manage.py", "migrate", "snappea", "--database=snappea", "--no-color"],
    { cwd: APP_DIR, env: ENV, stdio: "inherit", timeout: 60000 }
  );
  execFileSync(PYTHON, ["manage.py", "prestart"], {
    cwd: APP_DIR,
    env: ENV,
    stdio: "inherit",
    timeout: 30000,
  });
  console.log("[bugsink] Auto-init complete.");
} catch (err) {
  console.error("[bugsink] Auto-init failed:", err.message);
}

// --- Step 2: Start gunicorn ---
console.log("[bugsink] Starting gunicorn on 127.0.0.1:" + INTERNAL_PORT);
var gunicorn = spawn(
  GUNICORN,
  [
    "--bind",
    "127.0.0.1:" + INTERNAL_PORT,
    "--workers",
    "2",
    "--access-logfile",
    "-",
    "--error-logfile",
    "-",
    "bugsink.wsgi:application",
  ],
  { cwd: APP_DIR, env: ENV, stdio: "inherit" }
);

gunicorn.on("error", function (err) {
  console.error("[bugsink] Failed to start gunicorn:", err.message);
  process.exit(1);
});

gunicorn.on("exit", function (code) {
  console.error("[bugsink] gunicorn exited with code " + code);
  process.exit(code || 1);
});

// --- Step 3: Reverse proxy ---
// Wait for gunicorn to start accepting connections
setTimeout(function () {
  var server = http.createServer(function (clientReq, clientRes) {
    var proxyOpts = {
      hostname: "127.0.0.1",
      port: INTERNAL_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    };

    var proxyReq = http.request(proxyOpts, function (proxyRes) {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on("error", function (err) {
      console.error("[bugsink] Proxy error:", err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end("Bad Gateway - gunicorn may still be starting");
      }
    });

    clientReq.pipe(proxyReq, { end: true });
  });

  server.listen(LISTEN_PORT, function () {
    console.log(
      "[bugsink] Proxy :"+LISTEN_PORT+" -> gunicorn :"+INTERNAL_PORT
    );
  });
}, 3000);

// Cleanup
process.on("SIGTERM", function () {
  gunicorn.kill("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", function () {
  gunicorn.kill("SIGTERM");
  process.exit(0);
});
