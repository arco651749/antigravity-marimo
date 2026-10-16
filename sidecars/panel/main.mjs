import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));

// Convert file:// URI or raw path to clean local path
function toLocalPath(uriOrPath) {
  if (!uriOrPath) return null;
  const str = String(uriOrPath).trim();
  if (str.startsWith('file://')) {
    try {
      return fileURLToPath(str);
    } catch {
      return str.replace(/^file:\/\/\/?/, '');
    }
  }
  return resolve(str);
}

// Current active workspace root (dynamic)
let activeWorkspaceRoot = null;
const DEFAULT_PORT = 2718;

// Determine initial workspace root
function resolveInitialWorkspace() {
  const envRoot = process.env.ANTIGRAVITY_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
  if (envRoot && existsSync(envRoot)) {
    return resolve(envRoot);
  }
  return process.cwd();
}

activeWorkspaceRoot = resolveInitialWorkspace();

// Find Python / Marimo executable (prioritize workspace .venv / venv first)
function getMarimoExec(wsDir = activeWorkspaceRoot) {
  if (wsDir) {
    const venvMarimoCandidates = [
      join(wsDir, '.venv', 'Scripts', 'marimo.exe'),
      join(wsDir, 'venv', 'Scripts', 'marimo.exe'),
      join(wsDir, '.env', 'Scripts', 'marimo.exe')
    ];
    for (const candidate of venvMarimoCandidates) {
      if (existsSync(candidate)) {
        return { cmd: candidate, prefixArgs: [] };
      }
    }
  }
  const marimoCli = 'C:\\Python312\\Scripts\\marimo.exe';
  if (existsSync(marimoCli)) return { cmd: marimoCli, prefixArgs: [] };
  const pyExe = 'C:\\Python312\\python.exe';
  if (existsSync(pyExe)) return { cmd: pyExe, prefixArgs: ['-m', 'marimo'] };
  return { cmd: 'marimo', prefixArgs: [] };
}

// Check if Marimo server is answering HTTP requests
function checkServerAlive(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Kill any process currently listening on target port
function killPortListener(port = DEFAULT_PORT) {
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
      ]);
    } catch {
      // ignore
    }
  }
}

// Sanitize conversation ID (returns null if invalid, 'default', or '_new')
function sanitizeConvId(convId) {
  if (!convId) return null;
  const clean = String(convId).replace(/[^a-zA-Z0-9_-]/g, '');
  const lower = clean.toLowerCase();
  if (!clean || lower === 'default' || lower === '_new' || lower === 'null' || lower === 'undefined') {
    return null;
  }
  return clean;
}

// Ensure .marimo/shared_toolbox.py and (only when convId is valid) .marimo/<sessionId>/marimo_session.py
function ensureNotebooks(wsDir, convId = null) {
  if (!wsDir || !existsSync(wsDir)) {
    return { sessionRelPath: '', sharedRelPath: '' };
  }

  const marimoBaseDir = join(wsDir, '.marimo');
  if (!existsSync(marimoBaseDir)) {
    mkdirSync(marimoBaseDir, { recursive: true });
  }

  // Always ensure project-wide shared_toolbox.py exists
  const sharedFilename = 'shared_toolbox.py';
  const sharedFile = join(marimoBaseDir, sharedFilename);
  const sharedRelPath = `.marimo/${sharedFilename}`;

  if (!existsSync(sharedFile)) {
    const sharedTemplate = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Project Shared Toolbox")


@app.cell
def _():
    import marimo as mo
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # 📦 專案共用工具箱 (Shared Toolbox)
    > **跨會話活文檔 (Cross-Session Living Documentation)**  
    > 
    > 本筆記本為專案層級的共用資產庫，跨越所有對話視窗永久留存：
    > - 各會話中驗證成熟、高重用價值的核心 Python 工具與踩坑紀錄 (Gotchas) 可沉澱於此。
    > - 檔案路徑：\`.marimo/shared_toolbox.py\`
    """)
    return


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(sharedFile, sharedTemplate, 'utf8');
  }

  const sessionId = sanitizeConvId(convId);
  // Do NOT create a dummy 'default' or '_new' directory when convId is absent
  if (!sessionId) {
    return { sessionRelPath: sharedRelPath, sharedRelPath };
  }

  const sessionDir = join(marimoBaseDir, sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const sessionFilename = 'marimo_session.py';
  const sessionFile = join(sessionDir, sessionFilename);
  const sessionRelPath = `.marimo/${sessionId}/${sessionFilename}`;

  if (!existsSync(sessionFile)) {
    const shortId = sessionId.slice(0, 8);
    const sessionTemplate = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Marimo Session ${shortId}")


@app.cell
def _():
    import marimo as mo
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # 💬 會話專屬筆記本 (Session: ${shortId})
    > **會話識別碼**：\`${sessionId}\`  
    > 
    > 本筆記本由當前 Antigravity 對話視窗獨立持有：
    > - 變數、執行狀態與除錯過程與其他對話完全隔離，互不干擾。
    > - 檔案路徑：\`.marimo/${sessionId}/${sessionFilename}\`
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ---
    ## 📌 會話專屬程式碼與 Gotchas
    * 在此會話中產生的 Python 程式碼、踩坑點與互動控制面板皆記錄於此。
    """)
    return


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(sessionFile, sessionTemplate, 'utf8');
  }

  return { sessionRelPath, sharedRelPath };
}

// Find marimo notebooks belonging to current conversation session + project shared toolbox
function listNotebooks(wsDir, currentConvId = null) {
  const results = [];
  if (!wsDir || !existsSync(wsDir)) return results;

  const sessionId = sanitizeConvId(currentConvId);
  if (sessionId) {
    const sessionDir = join(wsDir, '.marimo', sessionId);
    if (existsSync(sessionDir)) {
      try {
        const entries = readdirSync(sessionDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.py')) {
            const fullPath = join(sessionDir, entry.name);
            try {
              const content = readFileSync(fullPath, 'utf8');
              if (content.includes('marimo.App(') || content.includes('import marimo')) {
                const relPath = relative(wsDir, fullPath).replace(/\\/g, '/');
                const isDefault = entry.name === 'marimo_session.py';
                const displayName = isDefault
                  ? `⭐️ 會話預設 (${entry.name})`
                  : `📄 ${entry.name}`;

                results.push({
                  absolutePath: fullPath,
                  relativePath: relPath,
                  name: entry.name,
                  displayName,
                  role: 'current_session',
                  isDefault,
                  size: statSync(fullPath).size
                });
              }
            } catch {
              // ignore unreadable
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Sort session notebooks: marimo_session.py first, then alphabetical
  results.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  // Append project-wide shared_toolbox.py so user & agent can access cross-session tools
  const sharedFull = join(wsDir, '.marimo', 'shared_toolbox.py');
  if (existsSync(sharedFull)) {
    try {
      results.push({
        absolutePath: sharedFull,
        relativePath: '.marimo/shared_toolbox.py',
        name: 'shared_toolbox.py',
        displayName: '📦 專案共用工具箱 (shared_toolbox.py)',
        role: 'shared_toolbox',
        isDefault: results.length === 0,
        size: statSync(sharedFull).size
      });
    } catch {
      // ignore
    }
  }

  return results;
}

// Workspace servers registry: wsDir -> { port, child, running }
const workspaceServers = new Map();
const startPromises = new Map();

// Map to track the currently active notebook per workspace + conversation
// key: `${cleanWs}:${sessionId}` -> relativePath (e.g. '.marimo/xxx/data_analysis.py')
const sessionActiveNotebooks = new Map();

// Deterministic port allocation per workspace (2718-2767)
function getPortForWorkspace(wsDir) {
  if (!wsDir) return DEFAULT_PORT;
  let hash = 0;
  const clean = wsDir.toLowerCase().replace(/\\/g, '/');
  for (let i = 0; i < clean.length; i++) {
    hash = ((hash << 5) - hash) + clean.charCodeAt(i);
    hash |= 0;
  }
  return DEFAULT_PORT + (Math.abs(hash) % 50);
}

// Persist server & session state to .marimo/server_state.json for instant AI Agent discovery
function writeServerState(wsDir, runningOverride = null) {
  if (!wsDir || !existsSync(wsDir)) return;
  try {
    const cleanWs = resolve(wsDir);
    const marimoBaseDir = join(cleanWs, '.marimo');
    if (!existsSync(marimoBaseDir)) {
      mkdirSync(marimoBaseDir, { recursive: true });
    }
    const port = getPortForWorkspace(cleanWs);
    const srvEntry = workspaceServers.get(cleanWs);
    const isRunning = runningOverride !== null ? runningOverride : Boolean(srvEntry?.running);
    const activeBySession = {};
    for (const [k, v] of sessionActiveNotebooks.entries()) {
      if (k.startsWith(`${cleanWs}:`)) {
        const sId = k.slice(cleanWs.length + 1);
        activeBySession[sId] = v;
      }
    }
    const { cmd, prefixArgs } = getMarimoExec(cleanWs);
    const statePayload = {
      workspaceRoot: cleanWs.replace(/\\/g, '/'),
      workspaceName: basename(cleanWs) || cleanWs,
      port,
      url: `http://127.0.0.1:${port}`,
      running: isRunning,
      pid: srvEntry?.child?.pid || null,
      marimoExec: { cmd, prefixArgs },
      sharedToolboxRel: '.marimo/shared_toolbox.py',
      activeNotebooksBySession: activeBySession,
      updatedAt: new Date().toISOString()
    };
    writeFileSync(join(marimoBaseDir, 'server_state.json'), JSON.stringify(statePayload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Marimo Sidecar] Failed to write server_state.json:', err);
  }
}

function getActiveNotebook(wsDir, convId) {
  const cleanWs = resolve(wsDir);
  const sessionId = sanitizeConvId(convId) || 'shared';
  const sessionKey = `${cleanWs}:${sessionId}`;
  let activeRel = sessionActiveNotebooks.get(sessionKey);
  if (activeRel && existsSync(join(cleanWs, activeRel))) {
    return activeRel;
  }
  const { sessionRelPath } = ensureNotebooks(cleanWs, convId);
  sessionActiveNotebooks.set(sessionKey, sessionRelPath);
  writeServerState(cleanWs);
  return sessionRelPath;
}

function setActiveNotebook(wsDir, convId, relPath) {
  if (!relPath) return;
  const cleanWs = resolve(wsDir);
  const sessionId = sanitizeConvId(convId) || 'shared';
  const sessionKey = `${cleanWs}:${sessionId}`;
  sessionActiveNotebooks.set(sessionKey, relPath.replace(/\\/g, '/'));
  writeServerState(cleanWs);
}

// Start Marimo for a specific workspace directory on its own dedicated port
async function startMarimo(wsDir = activeWorkspaceRoot) {
  const cleanWs = resolve(wsDir);
  ensureNotebooks(cleanWs, null);
  const port = getPortForWorkspace(cleanWs);

  // Return existing in-flight startup promise if already booting
  if (startPromises.has(cleanWs)) {
    return await startPromises.get(cleanWs);
  }

  const promise = (async () => {
    // Check if server is already running on its port
    const isAlive = await checkServerAlive(port);
    if (isAlive) {
      const existing = workspaceServers.get(cleanWs);
      if (existing && existing.port === port && existing.running) {
        writeServerState(cleanWs, true);
        console.log(`[Marimo Sidecar] Server already running on port ${port} for ${cleanWs}`);
        return { port, wsDir: cleanWs, running: true };
      }
      // If alive but not tracked, verify or reclaim port
      console.log(`[Marimo Sidecar] Reclaiming port ${port} for ${cleanWs}`);
      killPortListener(port);
      await new Promise(r => setTimeout(r, 400));
    }

    const { cmd, prefixArgs } = getMarimoExec(cleanWs);
    const args = [
      ...prefixArgs,
      'edit',
      '.',
      '--headless',
      '--no-token',
      '--watch',
      '--allow-origins', '*',
      '-p', String(port)
    ];

    console.log(`[Marimo Sidecar] Spawning Marimo for ${cleanWs} on port ${port}`);
    
    const child = spawn(cmd, args, {
      cwd: cleanWs,
      env: { ...process.env, PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    const entry = { port, child, running: false, wsDir: cleanWs };
    workspaceServers.set(cleanWs, entry);

    child.stdout?.on('data', (d) => console.log(`[Marimo ${port} stdout] ${d}`));
    child.stderr?.on('data', (d) => console.error(`[Marimo ${port} stderr] ${d}`));

    child.on('exit', (code) => {
      console.log(`[Marimo Sidecar] Process for ${cleanWs} (port ${port}) exited with code ${code}`);
      workspaceServers.delete(cleanWs);
      writeServerState(cleanWs, false);
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await checkServerAlive(port)) {
        console.log(`[Marimo Sidecar] Server is ready on port ${port} in ${cleanWs}`);
        entry.running = true;
        writeServerState(cleanWs, true);
        return { port, wsDir: cleanWs, running: true };
      }
    }

    writeServerState(cleanWs, false);
    return { port, wsDir: cleanWs, running: false };
  })();

  startPromises.set(cleanWs, promise);
  try {
    return await promise;
  } finally {
    startPromises.delete(cleanWs);
  }
}

// Stop all workspace Marimo servers on sidecar shutdown
function stopAllMarimo() {
  for (const [ws, entry] of workspaceServers.entries()) {
    if (entry.child) {
      try { entry.child.kill('SIGTERM'); } catch {}
    }
    if (entry.port) {
      killPortListener(entry.port);
    }
    writeServerState(ws, false);
  }
  workspaceServers.clear();
}

process.on('exit', stopAllMarimo);
process.on('SIGINT', stopAllMarimo);
process.on('SIGTERM', stopAllMarimo);

// Initialize sidecar app
const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

// Page routes
app.page('/', () => readLocal('index.html'));

// Helper to resolve workspace and port for request
function resolveRequestWorkspace(data) {
  const reqPath = toLocalPath(data?.workspaceUri || data?.uri || data?.path);
  const targetWs = (reqPath && existsSync(reqPath)) ? resolve(reqPath) : activeWorkspaceRoot;
  const port = getPortForWorkspace(targetWs);
  return { ws: targetWs, port };
}

// API routes
const handleStatus = async (data) => {
  const { ws, port } = resolveRequestWorkspace(data);
  const isAlive = await checkServerAlive(port);
  const convId = data?.conversationId || null;
  ensureNotebooks(ws, convId);
  const activeRel = getActiveNotebook(ws, convId);
  const notebooks = listNotebooks(ws, convId);
  writeServerState(ws, isAlive);

  return {
    running: isAlive,
    port,
    url: `http://127.0.0.1:${port}`,
    notebookUrl: `http://127.0.0.1:${port}/?file=${encodeURIComponent(activeRel)}`,
    activeNotebook: resolve(ws, activeRel),
    activeNotebookRel: activeRel,
    workspaceRoot: ws.replace(/\\/g, '/'),
    workspaceName: basename(ws) || ws,
    conversationId: convId,
    notebooks
  };
};

app.api('/api/status', handleStatus, 'POST');
app.api('/api/status', handleStatus, 'GET');

// Dynamically sync active workspace & conversation from Antigravity IDE
app.api('/api/workspace', async (data) => {
  const targetPath = toLocalPath(data?.uri || data?.path || data?.workspaceUri);
  const convId = data?.conversationId || null;

  if (targetPath && existsSync(targetPath)) {
    activeWorkspaceRoot = resolve(targetPath);
    await startMarimo(activeWorkspaceRoot);
  }

  const port = getPortForWorkspace(activeWorkspaceRoot);
  const isAlive = await checkServerAlive(port);
  ensureNotebooks(activeWorkspaceRoot, convId);
  const activeRel = getActiveNotebook(activeWorkspaceRoot, convId);
  const notebooks = listNotebooks(activeWorkspaceRoot, convId);
  writeServerState(activeWorkspaceRoot, isAlive);

  return {
    running: isAlive,
    port,
    url: `http://127.0.0.1:${port}`,
    notebookUrl: `http://127.0.0.1:${port}/?file=${encodeURIComponent(activeRel)}`,
    workspaceRoot: activeWorkspaceRoot.replace(/\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
    conversationId: convId,
    activeNotebookRel: activeRel,
    notebooks
  };
});

app.api('/api/start', async (data) => {
  const { ws } = resolveRequestWorkspace(data);
  const res = await startMarimo(ws);
  return { success: res.running, port: res.port, url: `http://127.0.0.1:${res.port}` };
});

app.api('/api/restart', async (data) => {
  const { ws, port } = resolveRequestWorkspace(data);
  const entry = workspaceServers.get(ws);
  if (entry) {
    if (entry.child) try { entry.child.kill('SIGTERM'); } catch {}
    killPortListener(port);
    workspaceServers.delete(ws);
  }
  await new Promise((r) => setTimeout(r, 500));
  const res = await startMarimo(ws);
  return { success: res.running, port: res.port, url: `http://127.0.0.1:${res.port}` };
});

app.api('/api/switch-notebook', async (data) => {
  if (!data?.notebook) return { error: 'Missing notebook path' };
  const { ws, port } = resolveRequestWorkspace(data);
  const convId = data?.conversationId || null;
  const notebookRel = data.notebook.replace(/\\/g, '/');
  
  setActiveNotebook(ws, convId, notebookRel);

  return { 
    success: true, 
    activeNotebookRel: notebookRel,
    port,
    url: `http://127.0.0.1:${port}/?file=${encodeURIComponent(notebookRel)}`
  };
});

app.api('/api/new-notebook', async (data) => {
  const { ws, port } = resolveRequestWorkspace(data);
  const convId = data?.conversationId || null;
  const rawName = data?.name || 'notebook.py';
  let cleanName = basename(rawName).endsWith('.py') ? basename(rawName) : `${basename(rawName)}.py`;
  if (cleanName.toLowerCase() === 'marimo.py') {
    cleanName = 'session_tool.py';
  }
  const sessionId = sanitizeConvId(convId);
  const targetDir = sessionId ? join(ws, '.marimo', sessionId) : join(ws, '.marimo');
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  const targetFile = join(targetDir, cleanName);
  const targetRel = sessionId ? `.marimo/${sessionId}/${cleanName}` : `.marimo/${cleanName}`;
  if (!existsSync(targetFile)) {
    const template = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="${cleanName}")


@app.cell
def _():
    import marimo as mo
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(targetFile, template, 'utf8');
  }

  setActiveNotebook(ws, convId, targetRel);
  const notebooks = listNotebooks(ws, convId);
  return {
    success: true,
    activeNotebookRel: targetRel,
    port,
    url: `http://127.0.0.1:${port}/?file=${encodeURIComponent(targetRel)}`,
    notebooks
  };
});

// Auto-start Marimo for initial workspace on launch
startMarimo(activeWorkspaceRoot).catch(console.error);

app.run();
