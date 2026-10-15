import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Agent Toolbox")


@app.cell
def _():
    import marimo as mo
    import sys
    import json
    from pathlib import Path

    return json, mo


@app.cell
def _(mo):
    mo.md(r"""
    # 🛠️ Antigravity Agent Toolbox
    > **活文檔代碼庫 (Living Executable Documentation)**
    >
    > 本筆記本由 Antigravity AI Agent 與使用者共同維護：
    > - 每個模組包含 **📝 踩坑紀錄 (Gotchas)**、**⚙️ 純邏輯函式** 與 **🎛️ 互動測試面板**。
    > - 支援在 Antigravity 側邊欄即時執行、熱重載，並可一鍵匯出為獨立生產程式。
    """)
    return


@app.cell
def _(mo):
    mo.md(r"""
    ---
    ## 📌 模組 1：文字編碼清洗與統計器
    * **最後修訂**：2026-10-15
    * **踩坑紀錄 (Gotchas)**：
      1. Windows 預設 `cp950` 會導致中文與 Emoji (🚀 ✨) 輸出時報錯 `UnicodeEncodeError`，因此所有字串處理一律以 UTF-8 規範為基底。
      2. 去除空白行時，不可僅使用 `replace('\n\n', '\n')`，因為 CRLF (`\r\n`) 與包含空白字元（Tab/Space）的空行會漏網。
    * **修改原因**：作為日常清洗剪貼簿文本、統計字數與過濾空行的基礎模組。
    """)
    return


@app.function
def clean_text_data(raw_text: str, remove_blank: bool = True, strip_lines: bool = True) -> dict:
    """核心邏輯：純 Python 函式，可直接被外部 import 或匯出。"""
    lines = raw_text.splitlines()
    cleaned = []
    for line in lines:
        target = line.strip() if strip_lines else line
        if remove_blank and not target:
            continue
        cleaned.append(target)
    return {
        "total_lines": len(cleaned),
        "original_lines": len(lines),
        "char_count": sum(len(line) for line in cleaned),
        "preview": cleaned[:10]
    }


@app.cell
def _(mo):
    # 互動式操作元件
    sample_text = (
        "Antigravity Marimo Extension\n"
        "支援雙向即時熱重載與側邊欄操作\n"
        "\n"
        "測試行 1：處理特殊字元與 Emoji 🚀 ✨\n"
        "測試行 2：Windows 環境自動適配\n"
        "   \n"
        "結束測試行"
    )
    txt_input = mo.ui.text_area(value=sample_text, label="輸入待處理文字", rows=6)
    chk_blank = mo.ui.checkbox(value=True, label="過濾空白行")
    chk_strip = mo.ui.checkbox(value=True, label="去除首尾空格")
    btn_exec = mo.ui.run_button(label="🚀 執行處理")

    controls = mo.vstack([
        txt_input,
        mo.hstack([chk_blank, chk_strip, btn_exec], justify="start", gap=1)
    ])

    res = clean_text_data(txt_input.value, chk_blank.value, chk_strip.value) if (btn_exec.value or txt_input.value) else None

    mo.vstack([
        mo.md("### 🎛️ 模組 1 自助操作面板"),
        controls,
        mo.ui.json(res) if res else mo.md("_請輸入文字並點擊執行_")
    ])
    return


@app.cell
def _(mo):
    mo.md(r"""
    ---
    ## 📌 模組 2：JSON 格式診斷與格式化器
    * **最後修訂**：2026-10-15
    * **踩坑紀錄 (Gotchas)**：
      1. API 回傳或 AI 生成的 JSON 常夾帶 Markdown 代碼塊標記 (```json ... ```)，直接 `json.loads` 會引發 `JSONDecodeError`。
      2. 已加入自動剝離頭尾代碼標籤的容錯機制。
    """)
    return


@app.cell
def _(json):
    def safe_parse_json(raw_input: str) -> dict:
        text = raw_input.strip()
        # 移除 markdown code block
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        try:
            parsed = json.loads(text)
            return {"valid": True, "type": type(parsed).__name__, "data": parsed}
        except Exception as e:
            return {"valid": False, "error": str(e), "data": None}

    return (safe_parse_json,)


@app.cell
def _(mo, safe_parse_json):
    sample_json = '{\n  "status": "success",\n  "model": "gemini-3.8-flash",\n  "tools_count": 5\n}'
    json_area = mo.ui.text_area(value=sample_json, label="輸入 JSON 字串 (支援包含 ``` 標籤)", rows=5)
    parse_btn = mo.ui.run_button(label="🔍 驗證與解析")

    json_result = safe_parse_json(json_area.value) if (parse_btn.value or json_area.value) else None

    mo.vstack([
        mo.md("### 🎛️ 模組 2 自助操作面板"),
        json_area,
        parse_btn,
        mo.ui.json(json_result) if json_result else mo.md("_請輸入 JSON 並點擊驗證_")
    ])
    return


if __name__ == "__main__":
    app.run()
