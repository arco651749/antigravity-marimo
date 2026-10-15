import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { SidecarApp, Response } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve workspace root
function resolveWorkspaceRoot() {
  const envRoot = process.env.ANTIGRAVITY_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
  if (envRoot && existsSync(envRoot)) {
    return resolve(envRoot);
  }
  const fallback = 'd:\\AntiGravity\\Agent-Study';
  if (existsSync(fallback)) return resolve(fallback);
  return process.cwd();
}

const workspaceRoot = resolveWorkspaceRoot();
const DEFAULT_PORT = 2718;
let marimoChild = null;
let activeNotebook = null;

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

// Ensure default starter notebook exists
function ensureStarterNotebook() {
  const toolboxDir = join(workspaceRoot, 'toolbox');
  if (!existsSync(toolboxDir)) {
    mkdirSync(toolboxDir, { recursive: true });
  }
  const starterFile = join(toolboxDir, 'agent_toolbox.py');
  if (!existsSync(starterFile)) {
    // If not found in workspace toolbox, check antigravity-marimo/toolbox
    const repoStarter = join(workspaceRoot, 'antigravity-marimo', 'toolbox', 'agent_toolbox.py');
    if (existsSync(repoStarter)) {
      writeFileSync(starterFile, readFileSync(repoStarter, 'utf8'), 'utf8');
    }
  }
  return starterFile;
}

// Find all marimo notebooks in workspace
function listNotebooks() {
  const results = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          try {
            const content = readFileSync(fullPath, 'utf8');
            if (content.includes('marimo.App(') || content.includes('import marimo')) {
              results.push({
                absolutePath: fullPath,
                relativePath: relative(workspaceRoot, fullPath).replace(/\\\\/g, '/'),
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

  walk(workspaceRoot);
  return results;
}

// Start Marimo in Directory Workspace Mode (single server, instant multi-file routing)
async function startMarimo() {
  ensureStarterNotebook();
  if (!activeNotebook) {
    activeNotebook = 'toolbox/agent_toolbox.py';
  }

  const isAlive = await checkServerAlive(DEFAULT_PORT);
  if (isAlive) {
    console.log(`[Marimo Sidecar] Server already alive on port ${DEFAULT_PORT}`);
    return true;
  }

  const { cmd, prefixArgs } = getMarimoExec();
  // Pass '.' to start directory workspace mode!
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

  console.log(`[Marimo Sidecar] Spawning in directory mode: ${cmd} ${args.join(' ')} (cwd: ${workspaceRoot})`);
  
  marimoChild = spawn(cmd, args, {
    cwd: workspaceRoot,
    env: { ...process.env, PYTHONUTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  marimoChild.stdout?.on('data', (d) => console.log(`[Marimo stdout] ${d}`));
  marimoChild.stderr?.on('data', (d) => console.error(`[Marimo stderr] ${d}`));

  marimoChild.on('exit', (code) => {
    console.log(`[Marimo Sidecar] Process exited with code ${code}`);
    marimoChild = null;
  });

  // Poll until ready or timeout (up to 8s)
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await checkServerAlive(DEFAULT_PORT)) {
      console.log(`[Marimo Sidecar] Server is ready on port ${DEFAULT_PORT}`);
      return true;
    }
  }

  return false;
}

// Stop Marimo process
function stopMarimo() {
  if (marimoChild) {
    try {
      marimoChild.kill('SIGTERM');
    } catch (e) {
      console.error('[Marimo Sidecar] Error killing process:', e);
    }
    marimoChild = null;
  }
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
  const notebooks = listNotebooks();
  const relPath = activeNotebook ? activeNotebook.replace(/\\\\/g, '/') : 'toolbox/agent_toolbox.py';
  return {
    running: isAlive,
    port: DEFAULT_PORT,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    notebookUrl: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(relPath)}`,
    activeNotebook: resolve(workspaceRoot, relPath),
    activeNotebookRel: relPath,
    workspaceRoot: workspaceRoot.replace(/\\\\/g, '/'),
    notebooks
  };
}, 'GET');

app.api('/api/start', async () => {
  const started = await startMarimo();
  return { success: started, port: DEFAULT_PORT };
});

app.api('/api/restart', async () => {
  stopMarimo();
  await new Promise((r) => setTimeout(r, 600));
  const started = await startMarimo();
  return { success: started };
});

// Lightning-fast notebook switch: NO PROCESS KILL, NO REBOOT!
app.api('/api/switch-notebook', async (data) => {
  if (!data?.notebook) return { error: 'Missing notebook path' };
  activeNotebook = data.notebook.replace(/\\\\/g, '/');
  return { 
    success: true, 
    activeNotebookRel: activeNotebook,
    url: `http://127.0.0.1:${DEFAULT_PORT}/?file=${encodeURIComponent(activeNotebook)}`
  };
});

// Auto-start Marimo in directory mode
startMarimo().catch(console.error);

app.run();
