import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { SidecarApp, Response } from 'sidecar_sdk';

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
let runningWorkspaceDir = null;
const DEFAULT_PORT = 2718;
let marimoChild = null;

// Determine initial workspace root
function resolveInitialWorkspace() {
  const envRoot = process.env.ANTIGRAVITY_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
  if (envRoot && existsSync(envRoot)) {
    return resolve(envRoot);
  }
  return process.cwd();
}

activeWorkspaceRoot = resolveInitialWorkspace();

// Find Python / Marimo executable
function getMarimoExec() {
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
    } catch (e) {
      // ignore
    }
  }
}

// Ensure per-conversation session directory & marimo_session.py inside .marimo/<sessionId>/
function ensureNotebooks(wsDir, convId = null) {
  if (!wsDir || !existsSync(wsDir)) {
    return { sessionRelPath: '' };
  }

  const marimoBaseDir = join(wsDir, '.marimo');
  if (!existsSync(marimoBaseDir)) {
    mkdirSync(marimoBaseDir, { recursive: true });
  }

  // Use clean alphanumeric ID or 'default'
  const sessionId = convId ? convId.replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
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
    sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(
        r"""
        # 💬 會話專屬筆記本 (Session: ${shortId})
        > **會話識別碼**：\`${convId || sessionId}\`  
        > 
        > 本筆記本由當前 Antigravity 對話視窗獨立持有：
        > - 變數、執行狀態與除錯過程與其他對話完全隔離，互不干擾。
        > - 檔案路徑：\`.marimo/${sessionId}/${sessionFilename}\`
        """
    )
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ---
        ## 📌 會話專屬程式碼與 Gotchas
        * 在此會話中產生的 Python 程式碼、踩坑點與互動控制面板皆記錄於此。
        """
    )
    return


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(sessionFile, sessionTemplate, 'utf8');
  }

  return { sessionRelPath };
}

// Find all marimo notebooks belonging STRICTLY to the current conversation session
function listNotebooks(wsDir, currentConvId = null) {
  const results = [];
  if (!wsDir || !existsSync(wsDir)) return results;

  const sessionId = currentConvId ? currentConvId.replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
  const sessionDir = join(wsDir, '.marimo', sessionId);

  if (!existsSync(sessionDir)) {
    return results;
  }

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

  // Sort: marimo_session.py always first, then alphabetical
  results.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

// Workspace servers registry: wsDir -> { port, child, running }
const workspaceServers = new Map();
const startPromises = new Map();

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

// Start Marimo for a specific workspace directory on its own dedicated port
async function startMarimo(wsDir = activeWorkspaceRoot) {
  const cleanWs = resolve(wsDir);
  ensureNotebooks(cleanWs);
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
        console.log(`[Marimo Sidecar] Server already running on port ${port} for ${cleanWs}`);
        return { port, wsDir: cleanWs, running: true };
      }
      // If alive but not tracked, verify or reclaim port
      console.log(`[Marimo Sidecar] Reclaiming port ${port} for ${cleanWs}`);
      killPortListener(port);
      await new Promise(r => setTimeout(r, 400));
    }

    const { cmd, prefixArgs } = getMarimoExec();
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
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await checkServerAlive(port)) {
        console.log(`[Marimo Sidecar] Server is ready on port ${port} in ${cleanWs}`);
        entry.running = true;
        return { port, wsDir: cleanWs, running: true };
      }
    }

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
  const { sessionRelPath } = ensureNotebooks(ws, convId);
  const notebooks = listNotebooks(ws, convId);

  return {
    running: isAlive,
    port,
    url: `http://127.0.0.1:${port}`,
    notebookUrl: `http://127.0.0.1:${port}/?file=${encodeURIComponent(sessionRelPath)}`,
    activeNotebook: resolve(ws, sessionRelPath),
    activeNotebookRel: sessionRelPath,
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
  const { sessionRelPath } = ensureNotebooks(activeWorkspaceRoot, convId);
  const notebooks = listNotebooks(activeWorkspaceRoot, convId);

  return {
    running: isAlive,
    port,
    url: `http://127.0.0.1:${port}`,
    notebookUrl: `http://127.0.0.1:${port}/?file=${encodeURIComponent(sessionRelPath)}`,
    workspaceRoot: activeWorkspaceRoot.replace(/\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
    conversationId: convId,
    activeNotebookRel: sessionRelPath,
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
  const { port } = resolveRequestWorkspace(data);
  const notebookRel = data.notebook.replace(/\\/g, '/');
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
  const sessionId = convId ? convId.replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
  const sessionDir = join(ws, '.marimo', sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  const targetFile = join(sessionDir, cleanName);
  const targetRel = `.marimo/${sessionId}/${cleanName}`;
  if (!existsSync(targetFile)) {
    const template = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="${cleanName}")


@app.cell
def _():
    import marimo as mo
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(targetFile, template, 'utf8');
  }

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
