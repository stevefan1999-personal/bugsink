// app.mjs — Node.js reverse proxy for Bugsink on LiteSpeed/cPanel
//
// LiteSpeed doesn't support Passenger Python WSGI. This script spawns gunicorn
// as a child process and proxies all HTTP requests to it via http-proxy-3.
//
// cPanel "Setup Node.js App":
//   - Application root:         repositories/bugsink
//   - Application startup file: app.mjs
//   - Run NPM Install (installs http-proxy-3)

import { spawn, execFileSync } from 'node:child_process';
import { createProxyServer } from 'http-proxy-3';
import { writeFile, readFile, unlink, access, stat, mkdir } from 'node:fs/promises';
import { readdirSync, constants } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GUNICORN_PORT = 48199 + Math.floor(Math.random() * 1000);
const APP_DIR = __dirname;
const TMP_DIR = join(APP_DIR, 'tmp');
const PID_FILE = join(TMP_DIR, 'gunicorn.pid');
const SESSION_FILE = join(TMP_DIR, '.proxy_session');
const RESTART_FILE = join(TMP_DIR, 'restart.txt');

// Python virtualenv — created by setup-python.sh (via uv from @manzt/uv)
const VENV_BIN = process.env.PYTHON_VENV_BIN || join(APP_DIR, '.pyenv', 'bin');
const PYTHON = process.env.PYTHON_BIN || join(VENV_BIN, 'python');
const GUNICORN = process.env.GUNICORN_BIN || join(VENV_BIN, 'gunicorn');
console.error(`[bugsink] PYTHON: ${PYTHON}`);

const ENV = {
    ...process.env,
    DJANGO_SETTINGS_MODULE: 'bugsink.settings.passenger',
};

// --- Utilities (from your Gitea proxy pattern) ---

const ensureTmpDir = async () => {
    try { await mkdir(TMP_DIR, { recursive: true }); } catch {}
};

const getRestartTime = async () => {
    try { return (await stat(RESTART_FILE)).mtimeMs; } catch { return 0; }
};

const fileExists = async (path) => {
    try { await access(path, constants.F_OK); return true; } catch { return false; }
};

const isProcessRunning = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

const getGunicornPid = async () => {
    if (!(await fileExists(PID_FILE))) return null;
    try {
        const pid = parseInt(await readFile(PID_FILE, 'utf8'));
        return isProcessRunning(pid) ? pid : null;
    } catch { return null; }
};

const killGunicorn = async () => {
    const pid = await getGunicornPid();
    if (pid) {
        console.error(`[bugsink] Killing gunicorn (PID: ${pid})`);
        try {
            process.kill(pid, 'SIGTERM');
            await new Promise(r => setTimeout(r, 2000));
            if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
        } catch (e) {
            console.error('[bugsink] Kill error:', e.message);
        }
    }
    await unlink(PID_FILE).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
};

const isFreshRestart = async () => {
    await ensureTmpDir();
    const currentRestartTime = await getRestartTime();
    try {
        if (await fileExists(SESSION_FILE)) {
            const lastRestartTime = parseFloat(await readFile(SESSION_FILE, 'utf8'));
            if (currentRestartTime > lastRestartTime) {
                console.error('[bugsink] Fresh restart detected');
                return true;
            }
            return false;
        }
    } catch {}
    return true;
};

const saveSession = async () => {
    await ensureTmpDir();
    const timeToSave = (await getRestartTime()) || Date.now();
    await writeFile(SESSION_FILE, timeToSave.toString());
};

// --- Step 1: Auto-init (migrations + superuser) ---

const autoInit = () => {
    console.error('[bugsink] Running auto-init...');
    try {
        execFileSync(PYTHON, ['manage.py', 'migrate', '--no-color'], {
            cwd: APP_DIR, env: ENV, stdio: 'inherit', timeout: 120000,
        });
        execFileSync(PYTHON, ['manage.py', 'migrate', 'snappea', '--database=snappea', '--no-color'], {
            cwd: APP_DIR, env: ENV, stdio: 'inherit', timeout: 60000,
        });
        execFileSync(PYTHON, ['manage.py', 'prestart'], {
            cwd: APP_DIR, env: ENV, stdio: 'inherit', timeout: 30000,
        });
        console.error('[bugsink] Auto-init complete.');
    } catch (err) {
        console.error('[bugsink] Auto-init failed:', err.message);
    }
};

// --- Step 2: Start gunicorn ---

const startGunicorn = async () => {
    console.error(`[bugsink] Starting gunicorn on 127.0.0.1:${GUNICORN_PORT}...`);

    const child = spawn(GUNICORN, [
        '--bind', `127.0.0.1:${GUNICORN_PORT}`,
        '--workers', '2',
        '--access-logfile', '-',
        '--error-logfile', '-',
        'bugsink.wsgi:application',
    ], {
        cwd: APP_DIR,
        env: ENV,
        stdio: 'inherit',
        detached: true,
    });

    await writeFile(PID_FILE, child.pid.toString());
    console.error(`[bugsink] gunicorn started (PID: ${child.pid})`);
    child.unref();

    // Wait for gunicorn to be ready
    await new Promise(r => setTimeout(r, 3000));
};

// --- Step 3: Proxy ---

const main = async () => {
    console.error(`[bugsink] Starting (Node PID: ${process.pid}, PORT: ${PORT})`);

    const freshRestart = await isFreshRestart();

    if (freshRestart) {
        await saveSession();
        await killGunicorn();
        autoInit();
    }

    const existingPid = await getGunicornPid();
    if (!existingPid) {
        await startGunicorn();
    } else {
        console.error(`[bugsink] gunicorn already running (PID: ${existingPid})`);
    }

    const proxy = createProxyServer({
        target: `http://127.0.0.1:${GUNICORN_PORT}`,
        ws: true,
        xfwd: true,
        changeOrigin: false,
        headers: {
            'X-Forwarded-Proto': 'https',
        },
    });

    proxy.on('error', (err, req, res) => {
        console.error('[bugsink] Proxy error:', err.message);
        if (res?.writeHead && !res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    proxy.listen(PORT, () => {
        console.error(`[bugsink] Proxy :${PORT} -> gunicorn :${GUNICORN_PORT}`);
    });
};

process.on('uncaughtException', (err) => console.error('[bugsink] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[bugsink] Rejection:', reason));

await main();
