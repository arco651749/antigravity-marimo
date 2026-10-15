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
│   │   └── [該會話產生的其他 .py]
│   └── <其他歷史 session_id 目錄>/
└── [專案其他 Python 檔案]          # 例如 demo_marimo.py 或共用腳本
```

### 關鍵規範與踩坑提示 (Gotchas)
1. **目錄位置**：
   * `.marimo/` 必須建立在目前專案根目錄下，禁止存放於外部暫存目錄或隱蔽路徑，確保程式碼可直接納入專案 Git 追蹤或版本控制。
2. **會話隔離 (Session-Based Isolation)**：
   * 每個 Antigravity 聊天視窗擁有獨立的 `<session_id>` 目錄。
   * AI 在當前對話中實作或修改的 Python 程式碼，**一律優先寫入當前會話的 `marimo_session.py`**。
   * 如此可確保多視窗並行除錯時，變數命名、執行順序與 DAG 圖譜完全互不衝突。
3. **命名避免循環引用 (Circular Import Trap)**：
   * 預設筆記本必須命名為 **`marimo_session.py`**，**嚴禁命名為 `marimo.py`**。
   * *踩坑原因*：若檔案命名為 `marimo.py`，Python 在執行 `import marimo` 時會優先引用同目錄下的自身檔案（`sys.path[0]`），造成 `AttributeError: partially initialized module 'marimo' has no attribute 'App' (most likely due to a circular import)` 導致服務崩潰。
4. **側邊欄智能感知與即時切換**：
   * Marimo 伺服器以目錄工作區模式 (`marimo edit .`) 監聽專案根目錄。
   * 側邊欄面板透過 `window.sidecar.conversationId` 動態感知當前會話，自動打開 `.marimo/<session_id>/marimo_session.py`。
   * 側邊欄頂部的下拉選單提供專案內所有筆記本的毫秒級切換（0.1s 內完成，無須重啟伺服器）。

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
