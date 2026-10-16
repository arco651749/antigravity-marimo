---
name: marimo-notebook
description: >-
  管理、沉澱、除錯並匯出 Marimo 反應式筆記本 (Living Executable Documentation)。
  當使用者需要將實用的 Python 程式碼沉澱儲存、記錄踩坑點 (Gotchas)、在 Antigravity 側邊欄即時測試，
  或需要將 Marimo 筆記本匯出為獨立執行的生產腳本時使用。
---

# Antigravity Marimo Notebook Skill (Closed-Loop Agent Edition)

此技能教導 AI Agent 如何與專案中的 Marimo 筆記本進行**「具備自檢回饋的閉環協同 (Closed-Loop Co-Programming)」**，建立可重複使用的**活文檔 (Living Executable Documentation)**。

## 核心價值與雙層記憶架構 (Two-Tier Architecture)

1. **會話隔離層 (`.marimo/<conversation_id>/marimo_session.py`)**：
   - 當前對話專屬的開發、除錯與互動測試筆記本。變數、執行狀態與其他對話完全隔離。
2. **專案共用工具箱 (`.marimo/shared_toolbox.py`)**：
   - 跨會話永久留存的專案級工具庫。在任何對話中驗證成熟、高重用價值的核心 Python 工具與踩坑紀錄 (Gotchas)，可沉澱或晉升至此，解決跨會話失憶問題。
3. **靜態狀態與資產索引 (`.marimo/server_state.json` & `.marimo/catalog.json`)**：
   - Sidecar 與 CLI 自動維護工作區專屬端口、伺服器狀態與全專案工具函式索引，Agent 無需盲猜端口或翻找歷史目錄。
4. **使用者自主維運 (`mo.ui`)**：
   - 每個工具配備 `mo.ui` 互動控制面板，使用者開啟側邊欄點按鈕即可執行，無需重新呼叫 AI。

---

## 🛠️ 閉環標準作業流程 (Closed-Loop Agent Workflow)

本技能內建專屬輔助腳本 `scripts/marimo_agent_cli.py`（位於本技能目錄下）。AI Agent 操作 Marimo 時，**請一律透過此 CLI 進行冷啟動初始化、AST/DAG 靜態檢查、工具目錄檢索與安全 Toast 通知**：

```powershell
# 設定 CLI 路徑變數（依技能安裝位置自動解析）
$cli = "D:\Users\arco0\.gemini\config\plugins\antigravity-marimo\skills\marimo-notebook\scripts\marimo_agent_cli.py"
```

### Step 1：環境探測與冷啟動確保 (`status`)
在讀寫筆記本前，先執行 `status`。即使使用者**尚未點開側邊欄**，此命令也會自動建立 `.marimo/shared_toolbox.py` 與當前會話的 `.marimo/<conversation_id>/marimo_session.py`，並回傳確定性端口（Port）與瀏覽器即時連線狀態：
```powershell
python.exe -X utf8 $cli status --workspace "." --session "<conversation_id>"
```

### Step 2：檢索既有工具與跨會話資產 (`catalog`)
寫新工具前，可先掃描專案內已沉澱的所有模組標題與函式簽名（自動輸出並更新 `.marimo/catalog.json`）：
```powershell
python.exe -X utf8 $cli catalog --workspace "."
```

### Step 3：修改筆記本後強制自檢 (`check`) —— ⭐️ 必做閉環步驟
每次編輯 `.py` 筆記本後，**必須立即執行 `check`**！它會自動完成四件事：
1. 自動偵測並剝除誤寫入的 UTF-8 BOM (`U+FEFF`)。
2. 透過 Python AST 檢查是否有 `@app.cell` 或 `@app.function` 被誤插在 `if __name__ == "__main__":` 之後。
3. 執行 `marimo check --fix` 自動修正縮排與簽名，並檢驗是否有 `MultipleDefinitionError`、循環依賴或語法錯誤。
4. 驗證通過 (`"valid": true`) 時，**自動刷新全專案 `.marimo/catalog.json` 索引**。
```powershell
python.exe -X utf8 $cli check --file ".marimo/<conversation_id>/marimo_session.py"
```
> [!IMPORTANT]
> 若 `check` 回傳 `"valid": false`，請根據 `errors` 與 `marimoCheckOutput` 立即修正，**嚴禁將帶有 DAG 錯誤的筆記本直接交給使用者**。

### Step 4：安全發送即時通知 (`toast`)
修改驗證通過後，呼叫 `toast` 通知使用者。若使用者正開啟側邊欄，畫面會即時彈出 Toast；若側邊欄未開啟（無 Live Session），腳本會優雅靜默返回 `"sent": false`（Exit Code `0`），絕不報錯中斷流程：
```powershell
python.exe -X utf8 $cli toast --workspace "." --file ".marimo/<conversation_id>/marimo_session.py" --message "✅ 工具已更新並通過 DAG 檢查！"
```

---

## 🔑 會話路徑定位原則 (Session Path Resolution)

1. **取得 Conversation ID**：
   - 檢視 `<user_information>` 中的 `Conversation ID`（UUID 格式，例如 `db500ff4-6591-4283-acc9-444b5b0778b1`）。
   - **子代理 (Subagent) 致命陷阱注意**：
     若你是透過 `invoke_subagent` 派生的子代理，你自身的 `<user_information>` 會帶有子對話的全新 UUID。**你必須使用 Parent Agent（主視窗）傳遞給你的 Conversation ID**，否則建立的目錄將與前端側邊欄脫節！
2. **確定檔案路徑**：
   - 會話專屬筆記本：`.marimo/<conversation_id>/marimo_session.py`
   - 專案共用工具箱：`.marimo/shared_toolbox.py`

---

## 📁 專案目錄結構規範 (Directory Structure Specification)

```
<專案根目錄>/
├── .marimo/                        # 專案等級的 Marimo 工作區目錄
│   ├── server_state.json           # Sidecar 自動寫入的端口、PID、活躍筆記本狀態檔
│   ├── catalog.json                # marimo_agent_cli.py 自動產生的跨會話工具索引
│   ├── shared_toolbox.py           # 📦 跨會話共用工具箱 (下拉選單固定置頂)
│   └── <conversation_id>/          # 💬 依 Antigravity 對話視窗 ID 獨立分割的子目錄
│       ├── marimo_session.py       # ⭐️ 該會話預設專屬筆記本 (嚴禁取名為 marimo.py)
│       └── [該會話產生的其他 .py]   # 透過工具列「+」按鈕或 AI 建立的輔助模組
└── [專案其他 Python 檔案]
```

### 關鍵規範與踩坑提示 (Gotchas)
1. **`sys.stdout.reconfigure` 在 Marimo Cell 內的防護 (`ThreadSafeStream` Trap)**：
   * 在獨立 Python 腳本頂端可直接呼叫 `sys.stdout.reconfigure(encoding="utf-8")`，但在 **Marimo `@app.cell` 內部**，`sys.stdout` 會被替換為 Marimo 的 `ThreadSafeStream`（不具備 `reconfigure` 方法）。
   * **強制寫法**：在 `@app.cell` 內必須加上 `hasattr` 防護：
     ```python
     if hasattr(sys.stdout, "reconfigure"):
         sys.stdout.reconfigure(encoding="utf-8")
     ```
2. **命名避免循環引用 (Circular Import Trap)**：
   * 預設筆記本必須命名為 **`marimo_session.py`**，**嚴禁命名為 `marimo.py`**（會遮蔽官方 `marimo` 套件導致 `AttributeError` 崩潰）。
3. **Windows UTF-8 無 BOM 規範 (No-BOM Requirement)**：
   * 筆記本 `.py` 必須為 **UTF-8 No BOM**。執行 `marimo_agent_cli.py check` 會自動幫你檢測並剝除 BOM。
4. **註解請寫在 Cell 函式內部 (No Top-Level Comments Outside Cells)**：
   * Marimo 的 AST 序列化器在格式化檔案時會自動清除位於 `@app.cell` / `@app.function` 外部的模組頂層 `#` 註解。所有說明註解請寫在 `def _():` 內部或 `mo.md` 區塊中。

---

## 📝 向既有筆記本追加新模組的標準作業 (Append Module SOP)

Marimo 檔案尾端固定為 `if __name__ == "__main__": app.run()`。
> [!CAUTION]
> **嚴禁**使用 `write_to_file` 的 `Append=true` 直接附加至檔案末尾！任何位於 `if __name__ == "__main__":` 之後的 `@app.cell` 或 `@app.function` 都不會被 Marimo 註冊！

請使用 `replace_file_content`，以結尾宣告作為**標準錨點 (Anchor)** 向前插入，並在修改後執行 `marimo_agent_cli.py check` 驗證。

---

## 🛡️ DAG 作用域安全版規範 (Safe Three-Block Pattern)

為了防止 Marimo 的 DAG 變數重複定義錯誤 (`MultipleDefinitionError`)，並兼顧「互動測試」與「可獨立匯出」，每個功能模組請遵循安全三區塊結構：
- **重要規則**：使用 `@app.function` 定義的頂層純函式屬於模組級符號，下游 `@app.cell` **直接呼叫即可，無需將該函式名稱列入 `def _(...)` 的參數列中**（只有其他 `@app.cell` `return` 的變數才需列入 `def _(...)` 參數）。

```python
@app.cell(hide_code=True)
def _(mo):
    # [區塊 1] 活文檔說明與踩坑紀錄 (Markdown)
    mo.md(r"""
    ---
    ## 📌 模組：資料分析與統計 (Data Summary)
    * **最後修訂**：2026-10-16
    * **踩坑紀錄 (Gotchas)**：
      1. 第三方套件請於函式內部 import，避免污染 DAG 全域命名空間。
      2. Cell 內若需設定 stdout 編碼，務必使用 `if hasattr(sys.stdout, "reconfigure"):`。
    * **修改原因**：新增數據統計與分佈計算。
    """)
    return


@app.function
def compute_summary_stats(numbers_str: str) -> dict:
    """[區塊 2] 純 Python 函式：無副作用、無全域依賴，可直接被外部 import 或匯出。"""
    nums = [float(x.strip()) for x in numbers_str.replace(",", " ").split() if x.strip()]
    if not nums:
        return {"count": 0, "mean": 0.0, "variance": 0.0}
    avg = sum(nums) / len(nums)
    var = sum((x - avg) ** 2 for x in nums) / len(nums)
    return {"count": len(nums), "mean": round(avg, 4), "variance": round(var, 4)}


@app.cell
def _(mo):
    # [區塊 3A] 自助互動測試面板 - 控制器定義
    stats_inp = mo.ui.text_area(value="10, 20, 30, 40", label="輸入數值列表")
    stats_btn = mo.ui.run_button(label="⚡ 計算分佈")
    return stats_btn, stats_inp


@app.cell
def _(mo, stats_btn, stats_inp):
    # [區塊 3B] 自助互動測試面板 - 執行與展示 (注意：@app.function 的 compute_summary_stats 直接呼叫，不放入 def _(...) 參數)
    _res = compute_summary_stats(stats_inp.value) if stats_btn.value else None
    mo.vstack([
        mo.md("### 🎛️ 自助操作台"),
        stats_inp,
        stats_btn,
        mo.ui.json(_res) if _res else mo.md("_請點擊上方按鈕計算_")
    ])
    return  # ⭐️ 關鍵：展示層結尾保持 return 為空！
```

---

## 🤝 進階即時核心交互 (`marimo pair execute`)

當使用者已經打開側邊欄（`marimo_agent_cli.py status` 中的 `liveBrowserNotebooks` 非空），除了用 `toast` 發送通知外，你也可以在 Live Session 的 Scratchpad 執行臨時診斷指令（不改動磁碟檔案）：

```powershell
# 從 .marimo/server_state.json 讀取當前工作區的確切端口
$state = Get-Content ".marimo/server_state.json" | ConvertFrom-Json
$port = $state.port

# 在指定筆記本的活躍核心中執行臨時探測
python.exe -X utf8 -m marimo pair execute --url "http://127.0.0.1:$port" --session "<live_session_id>" -c "import sys; print(sys.executable)"
```

---

## 側邊欄開啟捷徑 (Pill Link)

每次建立、修改或修復任何 Marimo 筆記本工具後，**必須**在回覆中附上標準的 sidecar 捷徑連結：

```markdown
[開啟 Marimo 筆記本](sidecar://antigravity-marimo/panel/)
```

---

## 匯出為生產程式 (Export to Standalone Script)

當使用者要求將筆記本匯出為獨立執行的純 Python 生產腳本時：
```powershell
python.exe -X utf8 -m marimo export script .marimo/<conversation_id>/marimo_session.py -o dist/my_script.py
```
