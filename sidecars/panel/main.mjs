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
  // Fallback to active project directory
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


@app.cell
def _(mo):
    mo.md(
        r"""
        ---
        ## 📌 模組 1：文字編碼清理與統計器
        * **踩坑紀錄**：Windows 預設 \`cp950\` 常導致中文字元與 Emoji 寫入終端或檔案時崩潰，已採用強制 UTF-8 規範。
        * **修改原因**：供快速清洗字串、計算行數與預覽開頭內容。
        """
    )
    return


@app.cell
def _():
    def clean_text_data(raw_text: str, remove_blank: bool = True) -> dict:
        """核心邏輯：純 Python 函式，可直接被外部 import 或匯出。"""
        lines = raw_text.splitlines()
        if remove_blank:
            lines = [line.strip() for line in lines if line.strip()]
        return {
            "total_lines": len(lines),
            "char_count": sum(len(line) for line in lines),
            "preview": lines[:8]
        }
    return (clean_text_data,)


@app.cell
def _(clean_text_data, mo):
    # 互動式操作元件
    sample_text = (
        "Antigravity Marimo Extension\\n"
        "支援雙向即時同步\\n"
        "\\n"
        "測試行 1\\n"
        "測試行 2 (Unicode: 🚀 ✨)"
    )
    txt_input = mo.ui.text_area(value=sample_text, label="輸入待處理文字")
    chk_blank = mo.ui.checkbox(value=True, label="過濾空白行")
    btn_exec = mo.ui.run_button(label="🚀 執行處理")

    controls = mo.vstack([
        txt_input,
        mo.hstack([chk_blank, btn_exec], justify="start", gap=1)
    ])

    res = clean_text_data(txt_input.value, chk_blank.value) if (btn_exec.value or txt_input.value) else None

    mo.vstack([
        mo.md("### 🎛️ 自助操作面板"),
        controls,
        mo.ui.json(res) if res else mo.md("_請輸入文字並點擊執行_")
    ])
    return btn_exec, chk_blank, controls, res, sample_text, txt_input


if __name__ == "__main__":
    app.run()
`;
    writeFileSync(starterFile, template, 'utf8');
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

// Start Marimo Edit Server
async function startMarimo(targetNotebook = null) {
  if (!targetNotebook) {
    targetNotebook = ensureStarterNotebook();
  }
  activeNotebook = targetNotebook;

  const isAlive = await checkServerAlive(DEFAULT_PORT);
  if (isAlive) {
    console.log(`[Marimo Sidecar] Server already alive on port ${DEFAULT_PORT}`);
    return true;
  }

  const { cmd, prefixArgs } = getMarimoExec();
  const args = [
    ...prefixArgs,
    'edit',
    activeNotebook,
    '--headless',
    '--no-token',
    '--watch',
    '--allow-origins', '*',
    '-p', String(DEFAULT_PORT)
  ];

  console.log(`[Marimo Sidecar] Spawning: ${cmd} ${args.join(' ')}`);
  
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
    await new Promise((r) => setTimeout(r, 500));
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
  return {
    running: isAlive,
    port: DEFAULT_PORT,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    activeNotebook: activeNotebook || ensureStarterNotebook(),
    activeNotebookRel: relative(workspaceRoot, activeNotebook || ensureStarterNotebook()).replace(/\\\\/g, '/'),
    workspaceRoot: workspaceRoot.replace(/\\\\/g, '/'),
    notebooks
  };
}, 'GET');

app.api('/api/start', async (data) => {
  const notebook = data?.notebook ? resolve(workspaceRoot, data.notebook) : activeNotebook;
  const started = await startMarimo(notebook);
  return { success: started, port: DEFAULT_PORT, activeNotebook };
});

app.api('/api/restart', async () => {
  stopMarimo();
  await new Promise((r) => setTimeout(r, 800));
  const started = await startMarimo(activeNotebook);
  return { success: started };
});

app.api('/api/switch-notebook', async (data) => {
  if (!data?.notebook) return { error: 'Missing notebook path' };
  const target = resolve(workspaceRoot, data.notebook);
  stopMarimo();
  await new Promise((r) => setTimeout(r, 800));
  const started = await startMarimo(target);
  return { success: started, activeNotebook: target };
});

// Auto-start Marimo on launch
ensureStarterNotebook();
startMarimo().catch(console.error);

app.run();
