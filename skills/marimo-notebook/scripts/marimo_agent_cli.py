import sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import argparse
import ast
import json
import os
import re
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PORT = 2718


def compute_port_for_workspace(ws_dir: str) -> int:
    """Deterministic port calculation matching main.mjs getPortForWorkspace."""
    clean = os.path.abspath(ws_dir).lower().replace("\\", "/")
    h = 0
    for ch in clean:
        h = ((h << 5) - h) + ord(ch)
        # Convert to 32-bit signed integer matching JS (hash |= 0)
        h = h & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    return DEFAULT_PORT + (abs(h) % 50)


def check_server_alive(port: int) -> bool:
    url = f"http://127.0.0.1:{port}/"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return 200 <= resp.status < 500
    except Exception:
        return False


def ensure_notebooks(ws_path: Path, session_id: str | None = None) -> dict:
    marimo_dir = ws_path / ".marimo"
    marimo_dir.mkdir(parents=True, exist_ok=True)

    shared_file = marimo_dir / "shared_toolbox.py"
    if not shared_file.exists():
        shared_template = '''import marimo

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
    > - 檔案路徑：`.marimo/shared_toolbox.py`
    """)
    return


if __name__ == "__main__":
    app.run()
'''
        shared_file.write_text(shared_template, encoding="utf-8")

    session_rel = ".marimo/shared_toolbox.py"
    clean_sid = re.sub(r"[^a-zA-Z0-9_-]", "", session_id or "")
    if clean_sid and clean_sid.lower() not in ("default", "_new", "null", "undefined"):
        s_dir = marimo_dir / clean_sid
        s_dir.mkdir(parents=True, exist_ok=True)
        s_file = s_dir / "marimo_session.py"
        session_rel = f".marimo/{clean_sid}/marimo_session.py"
        if not s_file.exists():
            short_id = clean_sid[:8]
            s_template = f'''import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Marimo Session {short_id}")


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
    # 💬 會話專屬筆記本 (Session: {short_id})
    > **會話識別碼**：`{clean_sid}`  
    > 
    > 本筆記本由當前 Antigravity 對話視窗獨立持有：
    > - 變數、執行狀態與除錯過程與其他對話完全隔離，互不干擾。
    > - 檔案路徑：`{session_rel}`
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
'''
            s_file.write_text(s_template, encoding="utf-8")

    return {
        "sessionNotebookRel": session_rel,
        "sharedToolboxRel": ".marimo/shared_toolbox.py",
    }


def get_workspace_port(ws_path: Path) -> int:
    state_file = ws_path / ".marimo" / "server_state.json"
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            if "port" in data and isinstance(data["port"], int):
                return data["port"]
        except Exception:
            pass
    return compute_port_for_workspace(str(ws_path))


def get_live_sessions(port: int) -> list:
    if not check_server_alive(port):
        return []
    try:
        proc = subprocess.run(
            [sys.executable, "-X", "utf8", "-m", "marimo", "pair", "notebook", "list", "--url", f"http://127.0.0.1:{port}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=5,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            payload = json.loads(proc.stdout.strip())
            return payload.get("notebooks", [])
    except Exception:
        pass
    return []


def cmd_status(args):
    ws_path = Path(args.workspace).resolve()
    nb_info = ensure_notebooks(ws_path, args.session)
    port = get_workspace_port(ws_path)
    alive = check_server_alive(port)
    live_nbs = get_live_sessions(port) if alive else []

    result = {
        "workspace": str(ws_path).replace("\\", "/"),
        "port": port,
        "url": f"http://127.0.0.1:{port}",
        "serverAlive": alive,
        "sessionNotebookRel": nb_info["sessionNotebookRel"],
        "sharedToolboxRel": nb_info["sharedToolboxRel"],
        "liveBrowserNotebooks": live_nbs,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_check(args):
    target = Path(args.file).resolve()
    if not target.exists():
        print(json.dumps({"valid": False, "error": f"File not found: {target}"}, ensure_ascii=False, indent=2))
        return 1

    raw_bytes = target.read_bytes()
    bom_stripped = False
    if raw_bytes.startswith(b"\xef\xbb\xbf"):
        raw_bytes = raw_bytes[3:]
        target.write_bytes(raw_bytes)
        bom_stripped = True

    source = raw_bytes.decode("utf-8")
    errors = []

    # 1. AST & structural check (detect cells accidentally placed after if __name__ == "__main__":)
    try:
        tree = ast.parse(source, filename=str(target))
        main_guard_lineno = None
        cells_after_main = []
        for node in tree.body:
            if isinstance(node, ast.If):
                # Check if __name__ == "__main__"
                test = node.test
                if (
                    isinstance(test, ast.Compare)
                    and isinstance(test.left, ast.Name)
                    and test.left.id == "__name__"
                ):
                    main_guard_lineno = node.lineno
            elif main_guard_lineno is not None and isinstance(node, ast.FunctionDef):
                for dec in node.decorator_list:
                    dec_str = ast.unparse(dec)
                    if "app.cell" in dec_str or "app.function" in dec_str:
                        cells_after_main.append(node.lineno)

        if cells_after_main:
            errors.append(
                f"CRITICAL: Found @app.cell / @app.function at line(s) {cells_after_main} AFTER 'if __name__ == \"__main__\":' (line {main_guard_lineno}). "
                "Cells after app.run() are never registered! Move them BEFORE the main guard."
            )
    except SyntaxError as e:
        errors.append(f"SyntaxError at line {e.lineno}: {e.msg}")

    # 2. Run marimo check
    marimo_out = ""
    if not errors:
        try:
            proc = subprocess.run(
                [sys.executable, "-X", "utf8", "-m", "marimo", "check", str(target)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=15,
            )
            marimo_out = (proc.stdout + "\n" + proc.stderr).strip()
            if proc.returncode != 0:
                errors.append(f"marimo check failed (exit {proc.returncode}):\n{marimo_out}")
        except Exception as e:
            errors.append(f"Failed to execute marimo check: {e}")

    is_valid = len(errors) == 0
    report = {
        "file": str(target).replace("\\", "/"),
        "valid": is_valid,
        "bomStripped": bom_stripped,
        "marimoCheckOutput": marimo_out or "Passed (0 issues)",
        "errors": errors,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if is_valid else 1


def extract_notebook_metadata(py_file: Path, ws_path: Path) -> dict:
    rel_path = str(py_file.relative_to(ws_path)).replace("\\", "/")
    try:
        source = py_file.read_text(encoding="utf-8-sig")
        tree = ast.parse(source, filename=str(py_file))
    except Exception as e:
        return {"file": rel_path, "parseError": str(e), "modules": [], "functions": []}

    modules = []
    functions = []

    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            decs = [ast.unparse(d) for d in node.decorator_list]
            is_app_func = any("app.function" in d for d in decs)
            is_cell = any("app.cell" in d for d in decs)

            if is_app_func:
                args_list = [a.arg for a in node.args.args]
                ret_ann = ast.unparse(node.returns) if node.returns else "Any"
                doc = ast.get_docstring(node) or ""
                functions.append({
                    "name": node.name,
                    "signature": f"{node.name}({', '.join(args_list)}) -> {ret_ann}",
                    "docstring": doc.splitlines()[0] if doc else "",
                    "lineno": node.lineno,
                    "kind": "app.function",
                })
                continue

            if not is_cell:
                continue

            # Extract markdown headers from mo.md(...) inside cell
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == "md":
                    if sub.args and isinstance(sub.args[0], ast.Constant) and isinstance(sub.args[0].value, str):
                        md_text = sub.args[0].value
                        for line in md_text.splitlines():
                            clean_line = line.strip()
                            if clean_line.startswith("## 📌") or clean_line.startswith("# "):
                                modules.append(clean_line)

            # Extract inner pure function definitions
            for stmt in node.body:
                if isinstance(stmt, ast.FunctionDef):
                    args_list = [a.arg for a in stmt.args.args]
                    ret_ann = ast.unparse(stmt.returns) if stmt.returns else "Any"
                    doc = ast.get_docstring(stmt) or ""
                    functions.append({
                        "name": stmt.name,
                        "signature": f"{stmt.name}({', '.join(args_list)}) -> {ret_ann}",
                        "docstring": doc.splitlines()[0] if doc else "",
                        "lineno": stmt.lineno,
                        "kind": "cell_function",
                    })

    return {
        "file": rel_path,
        "modules": modules,
        "functions": functions,
    }


def cmd_catalog(args):
    ws_path = Path(args.workspace).resolve()
    marimo_dir = ws_path / ".marimo"
    notebooks = []
    if marimo_dir.exists():
        shared = marimo_dir / "shared_toolbox.py"
        if shared.exists():
            notebooks.append(extract_notebook_metadata(shared, ws_path))
        for sub in sorted(marimo_dir.iterdir()):
            if sub.is_dir() and sub.name not in ("__marimo__", "default", "_new"):
                for py_f in sorted(sub.glob("*.py")):
                    notebooks.append(extract_notebook_metadata(py_f, ws_path))

    catalog_data = {
        "workspace": str(ws_path).replace("\\", "/"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "notebooks": notebooks,
    }
    if marimo_dir.exists():
        (marimo_dir / "catalog.json").write_text(
            json.dumps(catalog_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(json.dumps(catalog_data, ensure_ascii=False, indent=2))
    return 0


def cmd_toast(args):
    ws_path = Path(args.workspace).resolve()
    port = get_workspace_port(ws_path)
    live_nbs = get_live_sessions(port)
    if not live_nbs:
        print(
            json.dumps(
                {
                    "sent": False,
                    "reason": "no_live_session_open_in_browser",
                    "hint": "The sidecar panel is not currently open on a live session. Code changes on disk will still load automatically when the user opens the panel.",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    # Find matching session ID or fallback to first live session
    target_session_id = None
    target_file_norm = os.path.normcase(os.path.abspath(os.path.join(ws_path, args.file))) if args.file else None

    for nb in live_nbs:
        nb_path = os.path.normcase(os.path.abspath(nb.get("path", "")))
        sessions = nb.get("sessions", [])
        if sessions:
            if target_file_norm and nb_path == target_file_norm:
                target_session_id = sessions[0].get("id")
                break
            elif not target_session_id:
                target_session_id = sessions[0].get("id")

    if not target_session_id:
        print(json.dumps({"sent": False, "reason": "no_session_id_found"}, ensure_ascii=False, indent=2))
        return 0

    safe_msg = args.message.replace("'", "\\'")
    code = f"import marimo as mo; mo.status.toast('{safe_msg}')"
    proc = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8",
            "-m",
            "marimo",
            "pair",
            "execute",
            "--url",
            f"http://127.0.0.1:{port}",
            "--session",
            target_session_id,
            "-c",
            code,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=8,
    )
    print(
        json.dumps(
            {
                "sent": proc.returncode == 0,
                "port": port,
                "liveSessionId": target_session_id,
                "message": args.message,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def main():
    parser = argparse.ArgumentParser(description="Antigravity Marimo Agent Closed-Loop CLI Helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Ensure session notebooks and inspect server/session status")
    p_status.add_argument("--workspace", default=".", help="Workspace root directory")
    p_status.add_argument("--session", default="", help="Antigravity Conversation ID")

    p_check = sub.add_parser("check", help="Run AST guard check + marimo check on a notebook file")
    p_check.add_argument("--file", required=True, help="Path to notebook .py file")

    p_cat = sub.add_parser("catalog", help="Index all tools and Gotchas across all sessions and shared toolbox")
    p_cat.add_argument("--workspace", default=".", help="Workspace root directory")

    p_toast = sub.add_parser("toast", help="Safely send a toast to live session if open (graceful no-op if closed)")
    p_toast.add_argument("--workspace", default=".", help="Workspace root directory")
    p_toast.add_argument("--file", default="", help="Relative path to target notebook")
    p_toast.add_argument("--message", required=True, help="Toast message text")

    args = parser.parse_args()
    if args.command == "status":
        sys.exit(cmd_status(args))
    elif args.command == "check":
        sys.exit(cmd_check(args))
    elif args.command == "catalog":
        sys.exit(cmd_catalog(args))
    elif args.command == "toast":
        sys.exit(cmd_toast(args))


if __name__ == "__main__":
    main()
