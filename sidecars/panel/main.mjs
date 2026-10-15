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
let activeNotebookRel = 'toolbox/agent_toolbox.py';
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

// Kill any process currently listening on target port (cleans up orphaned servers)
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

// Ensure default starter notebook exists in the given workspace
function ensureStarterNotebook(wsDir) {
  const toolboxDir = join(wsDir, 'toolbox');
  if (!existsSync(toolboxDir)) {
    mkdirSync(toolboxDir, { recursive: true });
  }
  const starterFile = join(toolboxDir, 'agent_toolbox.py');
  if (!existsSync(starterFile)) {
    const repoStarter = join(wsDir, 'antigravity-marimo', 'toolbox', 'agent_toolbox.py');
    if (existsSync(repoStarter)) {
      writeFileSync(starterFile, readFileSync(repoStarter, 'utf8'), 'utf8');
    } else {
      const template = `import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Agent Toolbox")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md(
        r"""
        # 🛠️ Antigravity Agent Toolbox
        > **活文檔代碼庫 (Living Executable Documentation)**
        > 
        > 本筆記本由 Antigravity AI Agent 與使用者共同維護：
        > - 每個模組包含 **📝 踩坑紀錄 (Gotchas)**、**⚙️ 純邏輯函式** 與 **🎛️ 互動測試面板**。
        > - 支援在 Antigravity 側邊欄即時執行、熱重載，並可一鍵匯出為獨立生產程式。
        """
    )
    return


if __name__ == "__main__":
    app.run()
`;
      writeFileSync(starterFile, template, 'utf8');
    }
  }
  return starterFile;
}

// Find all marimo notebooks in workspace
function listNotebooks(wsDir) {
  const results = [];
  if (!wsDir || !existsSync(wsDir)) return results;

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
              results.push({
                absolutePath: fullPath,
                relativePath: relative(wsDir, fullPath).replace(/\\\\/g, '/'),
                name: entry.name,
                size: statSync(fullPath).size
              });
            }
          } catch {
            // ignore unreadable files
          }
        }
      }
    } catch {
      // ignore inaccessible dirs
    }
  };

  walk(wsDir);
  return results;
}

// Start Marimo in the currently active workspace directory
async function startMarimo(wsDir = activeWorkspaceRoot) {
  ensureStarterNotebook(wsDir);

  const isAlive = await checkServerAlive(DEFAULT_PORT);
  if (isAlive) {
    if (runningWorkspaceDir === wsDir) {
      console.log(`[Marimo Sidecar] Server already running on port ${DEFAULT_PORT} for ${wsDir}`);
      return true;
    }
    console.log(`[Marimo Sidecar] Server running on port ${DEFAULT_PORT} is from old workspace (${runningWorkspaceDir}), killing it...`);
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
app.api('/api/status', async () => {
  const isAlive = await checkServerAlive(DEFAULT_PORT);
  const notebooks = listNotebooks(activeWorkspaceRoot);
  const relPath = activeNotebookRel || 'toolbox/agent_toolbox.py';
  return {
    running: isAlive,
    port: DEFAULT_PORT,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    notebookUrl: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(relPath)}`,
    activeNotebook: resolve(activeWorkspaceRoot, relPath),
    activeNotebookRel: relPath,
    workspaceRoot: activeWorkspaceRoot.replace(/\\\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
    notebooks
  };
}, 'GET');

// Dynamically sync active workspace from Antigravity IDE
app.api('/api/workspace', async (data) => {
  const targetPath = toLocalPath(data?.uri || data?.path || data?.workspaceUri);
  if (targetPath && existsSync(targetPath) && (targetPath !== activeWorkspaceRoot || runningWorkspaceDir !== targetPath)) {
    console.log(`[Marimo Sidecar] Switching workspace to: ${targetPath}`);
    activeWorkspaceRoot = targetPath;
    activeNotebookRel = 'toolbox/agent_toolbox.py';
    await startMarimo(activeWorkspaceRoot);
  }
  
  const notebooks = listNotebooks(activeWorkspaceRoot);
  return {
    workspaceRoot: activeWorkspaceRoot.replace(/\\\\/g, '/'),
    workspaceName: basename(activeWorkspaceRoot) || activeWorkspaceRoot,
    notebooks,
    activeNotebookRel
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
  activeNotebookRel = data.notebook.replace(/\\\\/g, '/');
  return { 
    success: true, 
    activeNotebookRel,
    url: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(activeNotebookRel)}`
  };
});

// Auto-start Marimo on launch
startMarimo(activeWorkspaceRoot).catch(console.error);

app.run();
