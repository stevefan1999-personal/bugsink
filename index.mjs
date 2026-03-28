// index.mjs — Node.js reverse proxy for Bugsink on LiteSpeed/cPanel
// Based on the battle-tested Gitea proxy pattern.
import { spawn, execSync } from 'node:child_process';
import { createProxyServer } from 'http-proxy-3';
import { writeFile, readFile, unlink, access, stat, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        console.error(`[bugsink] Killing tracked process (PID: ${pid})`);
        try {
            process.kill(pid, 'SIGTERM');
            await new Promise(r => setTimeout(r, 2000));
            if (isProcessRunning(pid)) {
                process.kill(pid, 'SIGKILL');
            }
        } catch (e) {
            console.error('[bugsink] Kill error:', e.message);
        }
    }

    try {
        execSync('pkill -9 -f "gunicorn" 2>/dev/null || true', { stdio: 'ignore' });
        console.error('[bugsink] Ran pkill to clean up orphaned processes');
    } catch {}

    await unlink(PID_FILE).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
};

// Start gunicorn
const startGunicorn = async () => {
    console.error('[bugsink] Starting gunicorn...');
    console.error(`[bugsink] GUNICORN_BIN: ${GUNICORN_BIN}`);
    console.error(`[bugsink] BUGSINK_DOMAIN: ${ENV.BUGSINK_DOMAIN || 'NOT SET'}`);

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
    console.error(`[bugsink] Started with PID: ${child.pid}`);
    child.unref();

    await new Promise(r => setTimeout(r, 3000));
};

// Check if this is a fresh restart
const isFreshRestart = async () => {
    await ensureTmpDir();

    const currentRestartTime = await getRestartTime();
    console.error(`[session] restart.txt mtime: ${currentRestartTime}`);

    try {
        if (await fileExists(SESSION_FILE)) {
            const sessionData = await readFile(SESSION_FILE, 'utf8');
            const lastRestartTime = parseFloat(sessionData.trim());
            console.error(`[session] Last session mtime: ${lastRestartTime}`);

            if (currentRestartTime > lastRestartTime) {
                console.error('[session] Fresh restart detected (restart.txt is newer)');
                return true;
            }
            console.error('[session] Same session, not a fresh restart');
            return false;
        }
    } catch (e) {
        console.error('[session] Error reading session:', e.message);
    }

    console.error('[session] No previous session file');
    return true;
};

// Save session marker IMMEDIATELY
const saveSession = async () => {
    await ensureTmpDir();
    const restartTime = await getRestartTime();
    const timeToSave = restartTime || Date.now();
    await writeFile(SESSION_FILE, timeToSave.toString());
    console.error(`[session] Saved session marker: ${timeToSave}`);
};

// Error handlers
process.on('uncaughtException', (err) => console.error('[error] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[error] Rejection:', reason));

// Main
const main = async () => {
    console.error(`[proxy] Starting (Node PID: ${process.pid}, PORT: ${PORT})`);

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
        console.error(`[bugsink] Already running (PID: ${existingPid})`);
    }

    // Create proxy
    const proxy = createProxyServer({
        target: `http://127.0.0.1:${GUNICORN_PORT}`,
        ws: true,
        xfwd: false,
        changeOrigin: false,
    });

    proxy.on('error', (err, req, res) => {
        console.error('[proxy] Error:', err.message);
        if (res?.writeHead && !res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    proxy.listen(PORT, () => {
        console.error(`[proxy] Listening on ${PORT} -> ${GUNICORN_PORT}`);
    });
};

await main();
