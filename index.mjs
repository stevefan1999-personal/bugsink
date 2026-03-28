// index.mjs — Node.js reverse proxy for Bugsink on LiteSpeed/cPanel
//
// LiteSpeed doesn't support Passenger Python WSGI. This script spawns gunicorn
// as a child process and proxies all HTTP requests to it via http-proxy-3.
// Gunicorn runs as a direct child — when Node.js dies, gunicorn dies too.
//
// cPanel "Setup Node.js App":
//   - Application root:         repositories/bugsink
//   - Application startup file: index.mjs
//   - Run NPM Install

import { spawn, execFileSync } from 'node:child_process';
import { createProxyServer } from 'http-proxy-3';
import { readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GUNICORN_PORT = 40000 + Math.floor(Math.random() * 10000);
const APP_DIR = __dirname;

// Python virtualenv — created by setup-python.sh (via uv from @manzt/uv)
const VENV_BIN = process.env.PYTHON_VENV_BIN || join(APP_DIR, '.pyenv', 'bin');
const GUNICORN = process.env.GUNICORN_BIN || join(VENV_BIN, 'gunicorn');

const ENV = {
    ...process.env,
    DJANGO_SETTINGS_MODULE: 'bugsink.settings.passenger',
};

// Kill any orphaned gunicorn from previous runs
try {
    execFileSync('pkill', ['-9', '-f', 'gunicorn'], { stdio: 'ignore' });
    console.error('[bugsink] Killed orphaned gunicorn processes');
} catch {
    // No gunicorn running — that's fine
}

// Debug
console.error(`[bugsink] Node PID: ${process.pid}, PORT: ${PORT}`);
console.error(`[bugsink] GUNICORN: ${GUNICORN}`);
console.error(`[bugsink] BUGSINK_DOMAIN: ${ENV.BUGSINK_DOMAIN || 'NOT SET'}`);

// --- Start gunicorn as a direct child ---
// Auto-init (migrations + superuser) is handled by passenger_wsgi.py
// at import time when gunicorn loads the WSGI application.

console.error(`[bugsink] Starting gunicorn on 127.0.0.1:${GUNICORN_PORT}...`);

const gunicorn = spawn(GUNICORN, [
    '--bind', `127.0.0.1:${GUNICORN_PORT}`,
    '--workers', '2',
    '--access-logfile', '-',
    '--error-logfile', '-',
    'passenger_wsgi:application',
], {
    cwd: APP_DIR,
    env: ENV,
    stdio: 'inherit',
});

gunicorn.on('error', (err) => {
    console.error('[bugsink] Failed to start gunicorn:', err.message);
    process.exit(1);
});

gunicorn.on('exit', (code) => {
    console.error(`[bugsink] gunicorn exited with code ${code}`);
    process.exit(code || 1);
});

// --- Start proxy after gunicorn has time to boot ---

setTimeout(() => {
    const proxy = createProxyServer({
        target: `http://127.0.0.1:${GUNICORN_PORT}`,
        ws: true,
        xfwd: false,
        changeOrigin: false,
    });

    proxy.on('error', (err, req, res) => {
        console.error('[bugsink] Proxy error:', err.message);
        if (res?.writeHead && !res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway — gunicorn may still be starting');
        }
    });

    proxy.listen(PORT, () => {
        console.error(`[bugsink] Proxy :${PORT} -> gunicorn :${GUNICORN_PORT}`);
    });
}, 3000);

// Cleanup: kill gunicorn when Node.js exits
process.on('SIGTERM', () => { gunicorn.kill('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { gunicorn.kill('SIGTERM'); process.exit(0); });
process.on('uncaughtException', (err) => console.error('[bugsink] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[bugsink] Rejection:', reason));
