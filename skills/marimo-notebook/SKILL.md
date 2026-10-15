---
name: marimo-notebook
description: >-
  管理、沉澱、除錯並匯出 Marimo 反應式筆記本 (Living Executable Documentation)。
  當使用者需要將實用的 Python 程式碼沉澱儲存、記錄踩坑點 (Gotchas)、在 Antigravity 側邊欄即時測試，
  或需要將 Marimo 筆記本匯出為獨立執行的生產腳本時使用。
---

# Antigravity Marimo Notebook Skill

此技能教導 AI Agent 如何與專案中的 Marimo 筆記本深度協同，建立**「活文檔 (Living Executable Documentation)」**。

## 核心價值與流程

1. **會話隔離與拒絕一次性腳本**：實用的資料處理、檔案轉換、API 調用等程式碼，直接沉澱至當前對話專屬的 `.marimo/<session_id>/marimo_session.py` 筆記本中。
2. **踩坑紀錄永存**：除錯時，在 `mo.md` 中詳細記錄「當初為何報錯、Windows 環境特異性、修改依據」，避免 AI 越改越回去。
3. **使用者自主維運**：提供 `mo.ui` 互動控制項，使用者平常開起側邊欄點按鈕就能自用，無需每次對話重新呼叫 AI。
4. **一鍵匯出為獨立腳本**：可隨時透過 `marimo export script` 產出乾淨、拓撲排序保證無錯的純 Python 生產程式。

---

## 📁 專案目錄結構規範 (Directory Structure Specification)

為了確保不同對話視窗之間的執行狀態、變數與除錯過程完全隔離互不干擾，同時讓所有程式資產集中於當前專案目錄內部，Marimo 筆記本採用**以專案為基礎的會話隔離目錄結構**：

```
<專案根目錄>/
├── .marimo/                        # 專案等級的 Marimo 工作區目錄
│   ├── <session_id>/               # 依 Antigravity 對話視窗 ID 獨立分割的子目錄
│   │   ├── marimo_session.py       # ⭐️ 該會話預設專屬筆記本 (不可取名為 marimo.py 以免循環引用)
│   │   └── [該會話產生的其他 .py]   # 透過工具列「+」按鈕或 AI 建立的輔助模組
│   └── <其他歷史 session_id 目錄>/
└── [專案其他 Python 檔案]          # 專案原有腳本
```

### 關鍵規範與踩坑提示 (Gotchas)
1. **專案內目錄約束**：
   * `.marimo/` 必須建立在目前專案根目錄下，禁止存放於外部暫存目錄或隱蔽路徑，確保程式碼可直接納入專案 Git 追蹤或版本控制。
2. **會話嚴格過濾 (Strict Session Scoping)**：
   * 每個 Antigravity 聊天視窗擁有獨立的 `<session_id>` 目錄。
   * AI 在當前對話中實作或修改的 Python 程式碼，**一律優先寫入當前會話的 `marimo_session.py`**。
   * 側邊欄下拉選單**嚴格僅列出當前會話專屬目錄 (`.marimo/<session_id>/*.py`)**，絕不混入其他歷史會話或專案雜項檔案，確保操作視覺純粹。
3. **會話內多筆記本支援 (`+` 按鈕)**：
   * 使用者或 AI 可在當前會話目錄下建立額外 `.py` 筆記本（例如 `data_analysis.py`）。
   * 側邊欄頂部工具列提供 `+` 按鈕，點擊即可在當前會話目錄內新增並即時切換。
4. **命名避免循環引用 (Circular Import Trap)**：
   * 預設筆記本必須命名為 **`marimo_session.py`**，**嚴禁命名為 `marimo.py`**。
   * *踩坑原因*：若檔案命名為 `marimo.py`，Python 在執行 `import marimo` 時會優先引用同目錄下的自身檔案（`sys.path[0]`），造成 `AttributeError: partially initialized module 'marimo' has no attribute 'App' (most likely due to a circular import)` 導致服務崩潰。
5. **Windows UTF-8 無 BOM 規範 (No-BOM Requirement)**：
   * 在 Windows 環境下建立或更新 `.py` 檔案時，必須確保採用 **UTF-8 No BOM** 編碼。
   * *踩坑原因*：Windows PowerShell 預設的 `Out-File -Encoding utf8` 會寫入 `U+FEFF` (BOM)，導致 Python AST 解析器拋出 `HTTP 500: invalid non-printable character U+FEFF`。使用 Python `encoding="utf-8"` 或 Node.js `writeFileSync(..., 'utf8')` 即可保證無 BOM。

---

## ⚡ 多專案獨立端口常駐架構 (Multi-Workspace Port Isolation)

為徹底解決「在多個專案（如 Blender 與 Agent-Study）切換分頁時彼此殺死背景進程、導致 `kernel not found` 與 WebSocket 斷線」的問題，系統採用多端口常駐調度架構：

1. **依專案路徑雜湊獨立端口 (Ports 2718–2767)**：
   * 每個專案目錄在第一次啟動時分配專屬常駐端口（例如 `Agent-Study` 使用 `2731`，`Blender` 使用 `2720`）。
   * 切換專案時，**彼此的 Marimo 服務不會被終止**，各專案的 Python Kernel、變數與記憶體狀態在背景持續常駐。
2. **切換分頁自動對齊 (Focus & Visibility Re-sync)**：
   * 前端監聽 `window.addEventListener('focus')` 與 `document.addEventListener('visibilitychange')`。
   * 當使用者滑鼠點回分頁時，前端即時感知當前工作區路徑，動態更新頂部藥丸標籤並校正連線端口。
3. **防緩存強制重連 (`_t=timestamp`)**：
   * 每次重載或切換工作區時帶上時間戳參數，防止瀏覽器 iframe 緩存舊的伺服器防篡改憑證（`skew protection token`），避免出現 `kernel not found`。
4. **GPU 探測日誌正常警告**：
   * 伺服器啟動時若出現 `[W health:451] Neither nvidia-smi nor rocm-smi succeeded, cannot get GPU stats`，為 Marimo 嘗試在 Windows 探測硬體負載儀表板時的正常警告，不影響程式運算，可直接忽略。

---

## 側邊欄開啟捷徑 (Pill Link)

當需要引導使用者查看、測試或操作 Marimo 畫面時，請在回覆中附上標準的 sidecar 捷徑連結：

```markdown
[開啟 Marimo 筆記本](sidecar://antigravity-marimo/panel/)
```

---

## Cell 結構標準規範 (Three-Block Pattern)

為了防止 Marimo 的 DAG（有向無環圖）變數重複定義錯誤 (`MultipleDefinitionError`)，並兼顧「互動測試」與「可獨立匯出」，每個功能模組必須嚴格遵循三區塊結構：

```python
# [區塊 1] 活文檔說明與踩坑紀錄 (Markdown)
@app.cell
def _(mo):
    mo.md(
        r"""
        ---
        ## 📌 模組名稱：{功能描述}
        * **最後修訂**：YYYY-MM-DD
        * **踩坑紀錄 (Gotchas)**：
          1. 說明踩到的雷（例如 Windows UTF-8/CP950、特定 API 限制、非同步鎖定等）。
          2. 解釋為什麼要採用特定架構。
        * **修改原因**：修復了什麼問題或新增了什麼能力。
        """
    )
    return


# [區塊 2] 核心純函式邏輯 (Pure Python Logic)
@app.cell
def _():
    def my_utility_function(param_a: str, flag: bool = True) -> dict:
        """純 Python 函式：無副作用、無全域依賴，可直接被外部 import 或匯出。"""
        # 實作邏輯...
        return {"status": "ok", "result": param_a}

    return (my_utility_function,)


# [區塊 3] 自助互動測試面板 (Self-Service UI)
@app.cell
def _(mo, my_utility_function):
    ui_input = mo.ui.text(value="", label="輸入參數")
    ui_btn = mo.ui.run_button(label="🚀 執行測試")

    result = my_utility_function(ui_input.value) if ui_btn.value else None

    mo.vstack([
        mo.md("### 🎛️ 測試面板"),
        mo.hstack([ui_input, ui_btn], justify="start", gap=1),
        mo.ui.json(result) if result else mo.md("_等待輸入中..._")
    ])
    return (result, ui_btn, ui_input)
```

---

## 維護與除錯作業指引

### 1. 遇到程式碼報錯時的處理順序
1. **讀取檔案**：使用 `view_file` 檢視當前對話對應的筆記本（例如 `.marimo/<session_id>/marimo_session.py`）。
2. **分析與修復**：找出造成錯誤的 Cell。
3. **更新 Gotcha 紀錄**：在該模組前方的 `mo.md` 加上除錯心得與注意事項。
4. **回寫檔案**：使用 `replace_file_content` 更新內容。
   * **注意**：存檔後背景的 Marimo Edit Server 會由 File Watcher 自動 Hot-Reload，無需手動重啟服務。
5. **通知使用者**：附上 `[開啟 Marimo 筆記本](sidecar://antigravity-marimo/panel/)` 供使用者確認修復成果。

### 2. 匯出為生產程式 (Export to Standalone Script)
當使用者要求將筆記本中的某個功能或整本筆記本做成獨立程式時：
```powershell
python.exe -m marimo export script .marimo/<session_id>/marimo_session.py -o dist/my_script.py
```
Marimo 會自動依照依賴圖拓撲排序，輸出乾淨無裝飾器的純 Python 腳本。
