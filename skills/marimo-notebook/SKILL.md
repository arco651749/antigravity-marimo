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

1. **會話隔離與拒絕一次性腳本**：實用的資料處理、檔案轉換、API 調用等程式碼，直接沉澱至當前對話專屬的 `.marimo/<conversation_id>/marimo_session.py` 筆記本中。
2. **踩坑紀錄永存**：除錯時，在 `mo.md` 中詳細記錄「當初為何報錯、Windows 環境特異性、修改依據」，避免 AI 越改越回去。
3. **使用者自主維運**：提供 `mo.ui` 互動控制項，使用者平常開啟側邊欄點按鈕就能自用，無需每次對話重新呼叫 AI。
4. **一鍵匯出為獨立腳本**：可隨時透過 `marimo export script` 產出乾淨、拓撲排序保證無錯的純 Python 生產程式。

---

## 🔑 會話路徑定位原則 (Session Path Resolution)

AI Agent 在操作或寫入 Marimo 筆記本時，必須按照以下規則確切定位目錄路徑：

1. **取得 Conversation ID**：
   - 檢視系統提供的 `<user_information>` 中的 `Conversation ID`（UUID 格式，例如 `db500ff4-6591-4283-acc9-444b5b0778b1`）。
   - **子代理 (Subagent) 致命陷阱注意**：
     若你是透過 `invoke_subagent` 派生的子代理，你自身的 `<user_information>` 會帶有子對話的全新 UUID。**你必須使用 Parent Agent（主視窗）的 Conversation ID**，否則建立的目錄將與前端側邊欄脫節，使用者在側邊欄永遠看不到你產出的筆記本！
2. **確定檔案路徑**：
   - 專案目錄：`<專案根目錄>/.marimo/<conversation_id>/`
   - 主筆記本：`<專案根目錄>/.marimo/<conversation_id>/marimo_session.py`

---

## 📁 專案目錄結構規範 (Directory Structure Specification)

```
<專案根目錄>/
├── .marimo/                        # 專案等級的 Marimo 工作區目錄
│   ├── <conversation_id>/          # 依 Antigravity 對話視窗 ID 獨立分割的子目錄
│   │   ├── marimo_session.py       # ⭐️ 該會話預設專屬筆記本 (不可取名為 marimo.py 以免循環引用)
│   │   └── [該會話產生的其他 .py]   # 透過工具列「+」按鈕或 AI 建立的輔助模組
│   └── <其他歷史 conversation_id 目錄>/
└── [專案其他 Python 檔案]          # 專案原有腳本
```

### 關鍵規範與踩坑提示 (Gotchas)
1. **命名避免循環引用 (Circular Import Trap)**：
   * 預設筆記本必須命名為 **`marimo_session.py`**，**嚴禁命名為 `marimo.py`**。
   * *踩坑原因*：若檔案命名為 `marimo.py`，Python 在執行 `import marimo` 時會優先引用同目錄下的自身檔案（`sys.path[0]`），造成 `AttributeError: partially initialized module 'marimo' has no attribute 'App' (most likely due to a circular import)` 導致服務崩潰。
2. **Windows UTF-8 無 BOM 規範 (No-BOM Requirement)**：
   * 在 Windows 環境下建立或更新 `.py` 檔案時，必須確保採用 **UTF-8 No BOM** 編碼。
   * *踩坑原因*：Windows PowerShell 預設的 `Out-File -Encoding utf8` 會寫入 `U+FEFF` (BOM)，導致 Python AST 解析器拋出 `HTTP 500: invalid non-printable character U+FEFF`。使用 Python `encoding="utf-8"` 或 Node.js `writeFileSync(..., 'utf8')` 即可保證無 BOM。
3. **會話嚴格過濾 (Strict Session Scoping)**：
   * 側邊欄下拉選單嚴格僅列出當前會話專屬目錄 (`.marimo/<conversation_id>/*.py`)，絕不混入其他歷史會話，確保操作視覺純粹。

---

## 🚀 冷啟動建立樣板 (Cold-Start Bootstrap Template)

若目標 `.marimo/<conversation_id>/marimo_session.py` 尚不存在，請直接使用 `write_to_file` 建立完整的初始合法骨架，**嚴禁只寫局部 Cell**：

```python
import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium", app_title="Marimo Session")


@app.cell
def _():
    import marimo as mo
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    return (mo,)


if __name__ == "__main__":
    app.run()
```

---

## 📝 向既有筆記本追加新模組的標準作業 (Append Module SOP)

Marimo 檔案尾端固定為 `if __name__ == "__main__": app.run()`。
> [!CAUTION]
> **嚴禁**使用檔案工具的 `Append=true` 直接附加至檔案末尾！這會把新 Cell 附加在 `app.run()` 之後，Python 執行時在 `app.run()` 結束即退出，後續 Cell 根本不會被 Marimo 註冊！

正確追加方式是使用 `replace_file_content`，以結尾宣告作為**標準錨點 (Anchor)** 向前插入：

* **TargetContent**：
```python
if __name__ == "__main__":
    app.run()
```
* **ReplacementContent**：
```python
# [區塊 1] 活文檔說明...
@app.cell
def _(mo):
    ...
    return


# [區塊 2] 核心純函式邏輯...
@app.cell
def _():
    def my_new_tool(...):
        ...
    return (my_new_tool,)


# [區塊 3] 自助互動測試面板 (注意：結尾 return 必須為空！)...
@app.cell
def _(mo, my_new_tool):
    ...
    return


if __name__ == "__main__":
    app.run()
```

---

## 🛡️ DAG 作用域安全版規範 (Safe Three-Block Pattern)

為了防止 Marimo 的 DAG（有向無環圖）變數重複定義錯誤 (`MultipleDefinitionError`)，並兼顧「互動測試」與「可獨立匯出」，每個功能模組必須嚴格遵循安全三區塊結構：

```python
# [區塊 1] 活文檔說明與踩坑紀錄 (Markdown)
# 規則：入參宣告 mo，結尾直接 return
@app.cell
def _(mo):
    mo.md(r"""
    ---
    ## 📌 模組：資料分析與統計 (Data Summary)
    * **最後修訂**：2026-10-15
    * **踩坑紀錄 (Gotchas)**：
      1. 第三方套件請於函式內部 import，避免污染 DAG 全域命名空間。
      2. Windows 終端強制 UTF-8 編碼。
    * **修改原因**：新增數據統計與分佈計算。
    """)
    return


# [區塊 2] 核心純函式邏輯 (Pure Python Logic)
# 規則：僅 return 具備語意唯一性的工具函式名稱，內部暫存變數嚴禁洩漏！
@app.cell
def _():
    def compute_summary_stats(numbers_str: str) -> dict:
        """純 Python 函式：無副作用、無全域依賴，可直接被外部 import 或匯出。"""
        # 函式內 Local Import，防範 DAG 命名衝突
        import math
        nums = [float(x.strip()) for x in numbers_str.replace(",", " ").split() if x.strip()]
        if not nums:
            return {"count": 0, "mean": 0, "variance": 0}
        avg = sum(nums) / len(nums)
        var = sum((x - avg) ** 2 for x in nums) / len(nums)
        return {"count": len(nums), "mean": avg, "variance": var}

    return (compute_summary_stats,)


# [區塊 3] 自助互動測試面板 (Self-Service UI)
# ⭐️ 核心防坑規則：UI 控制項與展示結果若無下游 Cell 依賴，結尾嚴禁 return 泛用變數！保持 return 為空！
# 踩坑原因：若 return (ui_inp, ui_btn, res)，下一個工具若也叫 ui_inp，會引發 MultipleDefinitionError 崩潰！
@app.cell
def _(mo, compute_summary_stats):
    ui_inp = mo.ui.text_area(value="10, 20, 30, 40", label="輸入數值列表")
    ui_btn = mo.ui.run_button(label="⚡ 計算分佈")

    _res = compute_summary_stats(ui_inp.value) if ui_btn.value else None

    mo.vstack([
        mo.md("### 🎛️ 自助操作台"),
        ui_inp,
        ui_btn,
        mo.ui.json(_res) if _res else mo.md("_請點擊上方按鈕計算_")
    ])
    return  # ⭐️ 關鍵：無下游依賴時絕對不要 return (ui_inp, ui_btn, _res)！
```

---

## ⚡ 多專案獨立端口常駐架構 (Multi-Workspace Port Isolation)

為徹底解決「在多個專案切換分頁時彼此殺死背景進程、導致 `kernel not found` 與 WebSocket 斷線」的問題，系統採用多端口常駐調度架構：

1. **依專案路徑雜湊獨立端口 (Ports 2718–2767)**：
   * 每個專案目錄在第一次啟動時分配專屬常駐端口（例如 `Agent-Study` 使用 `2731`）。
   * 切換專案時，**彼此的 Marimo 服務不會被終止**，各專案的 Python Kernel、變數與記憶體狀態在背景持續常駐。
2. **切換分頁自動對齊 (Focus & Visibility Re-sync)**：
   * 前端監聽 `focus` 與 `visibilitychange` 事件，當使用者點回分頁時動態校正連線端口與狀態。
3. **GPU 探測日誌正常警告**：
   * 啟動時若出現 `[W health:451] Neither nvidia-smi nor rocm-smi succeeded, cannot get GPU stats`，為 Marimo 在 Windows 探測 GPU 儀表板時的正常警示，完全不影響運算，可直接忽略。

---

## 🤝 即時結對編程與核心交互 (Live Pair-Programming via `marimo pair`)

除了透過檔案編輯與熱重載更新筆記本之外，AI Agent 亦可使用 Marimo 官方原生結對通訊協議 `marimo pair`，直接與正在背景運行的 Live Python 核心無縫互動。

### 1. 自動化探測活躍 Marimo 端口與會話
Agent 無需人為推算端口雜湊，請在 Windows PowerShell 直接以單行指令探測：

```powershell
# 1. 取得當前工作區監聽中的 Marimo 端口 (2718-2767 範圍)
$port = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 2718 -and $_.LocalPort -le 2767 }).LocalPort | Select-Object -First 1

# 2. 列出筆記本資訊與 Live Session ID
python.exe -m marimo pair notebook list --url "http://127.0.0.1:$port"
```

### 2. 在活躍核心中執行代碼 (Live Code Execution & Scratchpad)
直接在指定會話的 Scratchpad（暫存區）中執行 Python 程式碼，不改動磁碟檔案，適合即時探測變數、運算臨時資料或發送 UI 反饋：

* **發送 Toast 畫面通知**：
  ```powershell
  python.exe -m marimo pair execute --url "http://127.0.0.1:$port" --file ".marimo/<conversation_id>/marimo_session.py" -c "import marimo as mo; mo.status.toast('資料分析模組已就緒！')"
  ```
* **查詢執行期變數或診斷錯誤**：
  ```powershell
  python.exe -m marimo pair execute --url "http://127.0.0.1:$port" --file ".marimo/<conversation_id>/marimo_session.py" -c "import sys; print(sys.version); print(globals().keys())"
  ```

> [!WARNING]
> `marimo._code_mode`（動態 Cell 注入 API）僅可在 Live Kernel 內部運作，不可作為外部獨立 Python 腳本呼叫。若需動態建立 Cell，應優先使用標準錨點 SOP 修改檔案由 File Watcher 熱重載，或透過 `marimo pair execute` 注入執行。

### 3. 適用場景比較：檔案寫入 vs `marimo pair`
| 操作模式 | 適用時機 | 特性與優勢 |
| :--- | :--- | :--- |
| **檔案沉澱 (`replace_file_content`)** | • 沉澱長期實用工具<br>• 編寫 Three-Block 活文檔與 Gotcha 紀錄<br>• 建立使用者自用的 `mo.ui` 測試面板 | 磁碟永久保存、納入 Git 追蹤、File Watcher 自動觸發熱重載。 |
| **即時結對 (`marimo pair execute`)** | • 執行中臨時除錯與變數狀態探測<br>• 即時向使用者側邊欄發送 Toast 提示<br>• 快速嘗試小段 Python 邏輯而不污染磁碟檔案 | 毫秒級即時反應、直接連通記憶體核心、不改動專案歷史檔案。 |

---

## 側邊欄開啟捷徑 (Pill Link)

當需要引導使用者查看、測試或操作 Marimo 畫面時，請在回覆中附上標準的 sidecar 捷徑連結：

```markdown
[開啟 Marimo 筆記本](sidecar://antigravity-marimo/panel/)
```

---

## 匯出為生產程式 (Export to Standalone Script)

當使用者要求將筆記本中的某個功能或整本筆記本做成獨立程式時：
```powershell
python.exe -m marimo export script .marimo/<conversation_id>/marimo_session.py -o dist/my_script.py
```
Marimo 會自動依照依賴圖拓撲排序，輸出乾淨無裝飾器的純 Python 腳本。
