// index.mjs — Node.js reverse proxy for Bugsink on LiteSpeed/cPanel
// Based on the battle-tested Gitea proxy pattern.
import { spawn, execSync } from 'node:child_process';
import { createProxyServer } from 'http-proxy-3';
import { writeFile, readFile, unlink, access, stat, mkdir, appendFile } from 'node:fs/promises';
import { constants, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// File-based logging — stderr may be swallowed by LiteSpeed
const __dirname2 = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname2, 'bugsink.log');
const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(LOG_FILE, line); } catch {}
};

log('=== index.mjs loaded ===');

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const GUNICORN_PORT = 48199;
const APP_DIR = __dirname;
const TMP_DIR = `${APP_DIR}/tmp`;
const PID_FILE = `${APP_DIR}/gunicorn.pid`;
const SESSION_FILE = `${TMP_DIR}/.proxy_session`;
const RESTART_FILE = `${TMP_DIR}/restart.txt`;

// Python virtualenv — created by setup-python.sh (via uv from @manzt/uv)
const VENV_BIN = process.env.PYTHON_VENV_BIN || join(APP_DIR, '.pyenv', 'bin');
const GUNICORN_BIN = process.env.GUNICORN_BIN || join(VENV_BIN, 'gunicorn');

const ENV = {
    ...process.env,
    DJANGO_SETTINGS_MODULE: 'bugsink.settings.passenger',
};

// Ensure tmp directory exists
const ensureTmpDir = async () => {
    try {
        await mkdir(TMP_DIR, { recursive: true });
    } catch {}
};

// Get restart.txt modification time
const getRestartTime = async () => {
    try {
        const stats = await stat(RESTART_FILE);
        return stats.mtimeMs;
    } catch {
        return 0;
    }
};

// Check if file exists
const fileExists = async (path) => {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
};

// Check if process is running
const isProcessRunning = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// Check if gunicorn is running
const getGunicornPid = async () => {
    if (!(await fileExists(PID_FILE))) return null;
    try {
        const pid = parseInt(await readFile(PID_FILE, 'utf8'));
        return isProcessRunning(pid) ? pid : null;
    } catch {
        return null;
    }
};

// Kill gunicorn
const killGunicorn = async () => {
    const pid = await getGunicornPid();
    if (pid) {
        log(`[bugsink] Killing tracked process (PID: ${pid})`);
        try {
            process.kill(pid, 'SIGTERM');
            await new Promise(r => setTimeout(r, 2000));
            if (isProcessRunning(pid)) {
                process.kill(pid, 'SIGKILL');
            }
        } catch (e) {
            log('[bugsink] Kill error:', e.message);
        }
    }

    try {
        execSync('pkill -9 -f "gunicorn" 2>/dev/null || true', { stdio: 'ignore' });
        log('[bugsink] Ran pkill to clean up orphaned processes');
    } catch {}

    await unlink(PID_FILE).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
};

// Start gunicorn
const startGunicorn = async () => {
    log('[bugsink] Starting gunicorn...');
    log(`[bugsink] GUNICORN_BIN: ${GUNICORN_BIN}`);
    log(`[bugsink] BUGSINK_DOMAIN: ${ENV.BUGSINK_DOMAIN || 'NOT SET'}`);

    const child = spawn(GUNICORN_BIN, [
        '--bind', `127.0.0.1:${GUNICORN_PORT}`,
        '--workers', '2',
        '--access-logfile', '-',
        '--error-logfile', '-',
        'passenger_wsgi:application',
    ], {
        cwd: APP_DIR,
        stdio: 'ignore',
        detached: true,
        env: ENV,
    });

    await writeFile(PID_FILE, child.pid.toString());
    log(`[bugsink] Started with PID: ${child.pid}`);
    child.unref();

    await new Promise(r => setTimeout(r, 3000));
};

// Check if this is a fresh restart
const isFreshRestart = async () => {
    await ensureTmpDir();

    const currentRestartTime = await getRestartTime();
    log(`[session] restart.txt mtime: ${currentRestartTime}`);

    try {
        if (await fileExists(SESSION_FILE)) {
            const sessionData = await readFile(SESSION_FILE, 'utf8');
            const lastRestartTime = parseFloat(sessionData.trim());
            log(`[session] Last session mtime: ${lastRestartTime}`);

            if (currentRestartTime > lastRestartTime) {
                log('[session] Fresh restart detected (restart.txt is newer)');
                return true;
            }
            log('[session] Same session, not a fresh restart');
            return false;
        }
    } catch (e) {
        log('[session] Error reading session:', e.message);
    }

    log('[session] No previous session file');
    return true;
};

// Save session marker IMMEDIATELY
const saveSession = async () => {
    await ensureTmpDir();
    const restartTime = await getRestartTime();
    const timeToSave = restartTime || Date.now();
    await writeFile(SESSION_FILE, timeToSave.toString());
    log(`[session] Saved session marker: ${timeToSave}`);
};

// Error handlers
process.on('uncaughtException', (err) => log('[error] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => log('[error] Rejection:', reason));

// Main
const main = async () => {
    log(`[proxy] Starting (Node PID: ${process.pid}, PORT: ${PORT})`);

    const freshRestart = await isFreshRestart();

    // SAVE SESSION IMMEDIATELY after checking (before any async operations)
    if (freshRestart) {
        await saveSession();
        await killGunicorn();
    }

    // Ensure gunicorn is running
    const existingPid = await getGunicornPid();
    if (!existingPid) {
        await startGunicorn();
    } else {
        log(`[bugsink] Already running (PID: ${existingPid})`);
    }

    // Create proxy
    const proxy = createProxyServer({
        target: `http://127.0.0.1:${GUNICORN_PORT}`,
        ws: true,
        xfwd: false,
        changeOrigin: false,
    });

    proxy.on('error', (err, req, res) => {
        log('[proxy] Error:', err.message);
        if (res?.writeHead && !res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    proxy.listen(PORT, () => {
        log(`[proxy] Listening on ${PORT} -> ${GUNICORN_PORT}`);
    });
};

await main();
