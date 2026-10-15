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

// Ensure default starter notebooks (both shared toolbox and conversation session)
function ensureNotebooks(wsDir, convId = null) {
  const toolboxDir = join(wsDir, 'toolbox');
  const sessionsDir = join(toolboxDir, 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  // 1. Shared toolbox
  const sharedFile = join(toolboxDir, 'agent_toolbox.py');
  if (!existsSync(sharedFile)) {
    const repoStarter = join(wsDir, 'antigravity-marimo', 'toolbox', 'agent_toolbox.py');
    if (existsSync(repoStarter)) {
      writeFileSync(sharedFile, readFileSync(repoStarter, 'utf8'), 'utf8');
    } else {
      const template = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Agent Shared Toolbox")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md(
        r"""
        # 📦 Antigravity 專案共用工具庫 (Shared Toolbox)
        > 所有會話皆可讀取與匯入此處的成熟工具函式。
        """
    )
    return


if __name__ == "__main__":
    app.run()
`;
      writeFileSync(sharedFile, template, 'utf8');
    }
  }

  // 2. Per-conversation notebook if convId provided
  let sessionRelPath = 'toolbox/agent_toolbox.py';
  if (convId) {
    const shortId = convId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'default';
    const sessionFilename = `chat_${shortId}.py`;
    const sessionFile = join(sessionsDir, sessionFilename);
    sessionRelPath = `toolbox/sessions/${sessionFilename}`;

    if (!existsSync(sessionFile)) {
      const sessionTemplate = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Chat Session ${shortId}")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md(
        r"""
        # 💬 會話專屬筆記本 (Chat Session: ${shortId})
        > **會話識別碼**：\`${convId}\`  
        > 
        > 本筆記本由當前 Antigravity 對話視窗獨立持有：
        > - 變數、執行狀態與除錯過程與其他對話完全隔離，互不干擾。
        > - 完成且經測試穩定的程式碼，可隨時發布轉移至共用庫 \`toolbox/agent_toolbox.py\`。
        """
    )
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ---
        ## 📌 本次會話筆記區塊
        * 在此會話中 AI 產生的程式碼與 Gotchas 會優先記錄於此。
        """
    )
    return


if __name__ == "__main__":
    app.run()
`;
      writeFileSync(sessionFile, sessionTemplate, 'utf8');
    }
  }

  return { sharedRelPath: 'toolbox/agent_toolbox.py', sessionRelPath };
}

// Find all marimo notebooks in workspace, classified by role
function listNotebooks(wsDir, currentConvId = null) {
  const results = [];
  if (!wsDir || !existsSync(wsDir)) return results;

  const currentShortId = currentConvId ? currentConvId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : null;

  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '__marimo__') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            if (content.includes('marimo.App(') || content.includes('import marimo')) {
              const relPath = relative(wsDir, fullPath).replace(/\\\\/g, '/');
              let role = 'other';
              let displayName = entry.name;

              if (relPath === 'toolbox/agent_toolbox.py') {
                role = 'shared';
                displayName = `📦 專案共用工具庫 (${entry.name})`;
              } else if (relPath.startsWith('toolbox/sessions/')) {
                if (currentShortId && entry.name.includes(currentShortId)) {
                  role = 'current_session';
                  displayName = `⭐️ 當前會話專屬 (${entry.name})`;
                } else {
                  role = 'other_session';
                  displayName = `💬 歷史會話 (${entry.name})`;
                }
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

  // Sort: current_session first, then shared, then others
  results.sort((a, b) => {
    const order = { current_session: 0, shared: 1, other: 2, other_session: 3 };
    return (order[a.role] ?? 4) - (order[b.role] ?? 4);
  });

  return results;
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
    workspaceRoot: activeWorkspaceRoot.replace(/\\\\/g, '/'),
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
    workspaceRoot: activeWorkspaceRoot.replace(/\\\\/g, '/'),
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
  const notebookRel = data.notebook.replace(/\\\\/g, '/');
  return { 
    success: true, 
    activeNotebookRel: notebookRel,
    url: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(notebookRel)}`
  };
});

// Auto-start Marimo on launch
startMarimo(activeWorkspaceRoot).catch(console.error);

app.run();
