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

// Find all marimo notebooks in workspace, classified by role
function listNotebooks(wsDir, currentConvId = null) {
  const results = [];
  if (!wsDir || !existsSync(wsDir)) return results;

  const currentCleanId = currentConvId ? currentConvId.replace(/[^a-zA-Z0-9_-]/g, '') : null;
  const currentShortId = currentCleanId ? currentCleanId.slice(0, 8) : null;

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden dot-dirs EXCEPT .marimo
        if (entry.name.startsWith('.')) {
          if (entry.name !== '.marimo') continue;
        }
        if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '__marimo__' || entry.name === '.git') continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            if (content.includes('marimo.App(') || content.includes('import marimo')) {
              const relPath = relative(wsDir, fullPath).replace(/\\/g, '/');
              let role = 'project';
              let displayName = entry.name;

              // Check if inside .marimo/<sessionId>/...
              if (relPath.startsWith('.marimo/')) {
                const parts = relPath.split('/');
                const sessId = parts[1] || '';
                const isCurrent = currentCleanId && (sessId === currentCleanId || (currentShortId && sessId.startsWith(currentShortId)));

                if (isCurrent) {
                  role = 'current_session';
                  displayName = entry.name === 'marimo_session.py'
                    ? `⭐️ 當前會話預設 (${entry.name})`
                    : `⭐️ 當前會話 (${entry.name})`;
                } else {
                  role = 'other_session';
                  const shortOther = sessId.slice(0, 8);
                  displayName = `💬 其它會話 [${shortOther}] (${entry.name})`;
                }
              } else {
                role = 'project';
                displayName = `📄 專案筆記 (${relPath})`;
              }

              results.push({
                absolutePath: fullPath,
                relativePath: relPath,
                name: entry.name,
                displayName,
                role,
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
  };

  walk(wsDir);

  // Sort: current_session first (with marimo_session.py top), then project, then other_session
  results.sort((a, b) => {
    const roleOrder = { current_session: 0, project: 1, other_session: 2 };
    const orderDiff = (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
    if (orderDiff !== 0) return orderDiff;
    if (a.role === 'current_session') {
      if (a.name === 'marimo_session.py') return -1;
      if (b.name === 'marimo_session.py') return 1;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });

  return results;
}
}

// Start Marimo in the currently active workspace directory
async function startMarimo(wsDir = activeWorkspaceRoot) {
  ensureNotebooks(wsDir);

  const isAlive = await checkServerAlive(DEFAULT_PORT);
  if (isAlive) {
    if (runningWorkspaceDir === wsDir) {
      console.log(`[Marimo Sidecar] Server already running on port ${DEFAULT_PORT} for ${wsDir}`);
      return true;
    }
    console.log(`[Marimo Sidecar] Restarting server from old workspace (${runningWorkspaceDir}) to ${wsDir}`);
    stopMarimo();
    await new Promise(r => setTimeout(r, 600));
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
    '-p', String(DEFAULT_PORT)
  ];

  console.log(`[Marimo Sidecar] Spawning Marimo in: ${wsDir}`);
  
  marimoChild = spawn(cmd, args, {
    cwd: wsDir,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  runningWorkspaceDir = wsDir;

  marimoChild.stdout?.on('data', (d) => console.log(`[Marimo stdout] ${d}`));
  marimoChild.stderr?.on('data', (d) => console.error(`[Marimo stderr] ${d}`));

  marimoChild.on('exit', (code) => {
    console.log(`[Marimo Sidecar] Process exited with code ${code}`);
    marimoChild = null;
    runningWorkspaceDir = null;
  });

  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await checkServerAlive(DEFAULT_PORT)) {
      console.log(`[Marimo Sidecar] Server is ready on port ${DEFAULT_PORT} in ${wsDir}`);
      return true;
    }
  }

  return false;
}

// Stop Marimo process and clear port
function stopMarimo() {
  if (marimoChild) {
    try {
      marimoChild.kill('SIGTERM');
    } catch (e) {
      console.error('[Marimo Sidecar] Error killing process:', e);
    }
    marimoChild = null;
  }
  killPortListener(DEFAULT_PORT);
  runningWorkspaceDir = null;
}

process.on('exit', stopMarimo);
process.on('SIGINT', stopMarimo);
process.on('SIGTERM', stopMarimo);

// Initialize sidecar app
const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

// Page routes
app.page('/', () => readLocal('index.html'));

// API routes
const handleStatus = async (data) => {
  const isAlive = await checkServerAlive(DEFAULT_PORT);
  const convId = data?.conversationId || null;
  const { sessionRelPath } = ensureNotebooks(activeWorkspaceRoot, convId);
  const notebooks = listNotebooks(activeWorkspaceRoot, convId);

  return {
    running: isAlive,
    port: DEFAULT_PORT,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    notebookUrl: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(sessionRelPath)}`,
    activeNotebook: resolve(activeWorkspaceRoot, sessionRelPath),
    activeNotebookRel: sessionRelPath,
    workspaceRoot: activeWorkspaceRoot.replace(/\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
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

  if (targetPath && existsSync(targetPath) && (targetPath !== activeWorkspaceRoot || runningWorkspaceDir !== targetPath)) {
    console.log(`[Marimo Sidecar] Switching workspace to: ${targetPath}`);
    activeWorkspaceRoot = targetPath;
    await startMarimo(activeWorkspaceRoot);
  }

  const { sessionRelPath } = ensureNotebooks(activeWorkspaceRoot, convId);
  const notebooks = listNotebooks(activeWorkspaceRoot, convId);

  return {
    workspaceRoot: activeWorkspaceRoot.replace(/\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
    conversationId: convId,
    activeNotebookRel: sessionRelPath,
    notebooks
  };
});

app.api('/api/start', async () => {
  const started = await startMarimo(activeWorkspaceRoot);
  return { success: started, port: DEFAULT_PORT };
});

app.api('/api/restart', async () => {
  stopMarimo();
  await new Promise((r) => setTimeout(r, 600));
  const started = await startMarimo(activeWorkspaceRoot);
  return { success: started };
});

app.api('/api/switch-notebook', async (data) => {
  if (!data?.notebook) return { error: 'Missing notebook path' };
  const notebookRel = data.notebook.replace(/\\/g, '/');
  return { 
    success: true, 
    activeNotebookRel: notebookRel,
    url: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(notebookRel)}`
  };
});

// Auto-start Marimo on launch
startMarimo(activeWorkspaceRoot).catch(console.error);

app.run();
