# OpenFlipbook NAS 使用說明書

Release：`nas-self-use-v1.0.2`
安全基線：Next.js `15.5.24`
介面預設：繁體中文（zh-TW）

> 本手冊給一般使用者使用。

## 1. 這套系統是什麼

OpenFlipbook NAS 是私人、自用的互動式圖像探索工具。輸入主題或上傳圖片後，
系統會產生一張圖像頁面，並提供可繼續探索的語意區域。

基本流程：
1. 建立主圖。
2. 點 hotspot 標籤或圖中區域。
3. 產生更深入的下一頁。
4. 用分支、歷史紀錄或相關主題繼續探索。

[[SCREENSHOT:G_DOC_MAIN.png|主畫面與互動標籤]]

## 2. 開啟系統

瀏覽器開啟：

`http://<NAS-IP>:3000/play`

建議使用近期 Chrome / Edge。

## 3. 建立新主題

在上方輸入框輸入主題並按「產生」。

NAS 版的上方新主題一定建立新的獨立工作階段，不會沿用剛才 History
頁面的圖片當作父頁。

## 4. 使用自己的圖片

按「上傳」選擇圖片。系統會建立 PagePlan 與互動標籤。

## 5. 點選互動區域

可直接點 hotspot 文字，也可以點圖片中感興趣的位置。

直接點文字會使用該 hotspot 的確切語意；圖片點擊則使用對齊幾何判斷。

頁面要先完成儲存，才進入正常 ready 狀態。

## 6. 分支

- 圖上的 branch beacon 表示當初探索的位置。
- 文字分支列位於圖片下方，不會遮住標題。
- 點分支 chip 可回到已存在的頁面，不需要重新生成。

[[SCREENSHOT:G_DOC_BRANCH_RELATED.png|圖片下方的分支與相關主題]]

## 7. 相關主題

按「相關主題」後：
1. 先顯示 3–5 個文字建議。
2. 不會先生成圖片。
3. 選一個主題後才生成一張新頁。

hotspot 是往圖片中的具體內容深入；相關主題是換到同領域的另一個方向。

## 8. 歷史紀錄

右上角「歷史紀錄」可以：
- 繼續：Resume 工作階段。
- 刪除：永久刪除工作階段。

刪除是破壞性操作，重要內容請先備份。

[[SCREENSHOT:G_DOC_HISTORY.png|歷史紀錄的繼續與刪除]]

## 9. 上一頁 / 下一頁

依目前瀏覽 trail 前後移動。已存在的分支可從分支列重新開啟。

## 10. 來源

右下角「來源」顯示 planner 使用的來源資訊。
標題不再附加容易誤會的 `[1][2]` 標記。

AI 內容可能出錯，需要確認事實時請查看來源。

## 11. 固定風格

「固定風格」讓同一工作階段的後續頁盡量延續目前視覺風格。

## 12. 地圖 / 圖集

用於不同方式整理目前探索內容。完整 session 管理仍以 History / 分支為主。

## 13. 設定

可以調整：
- 介面語言
- 輸出語言
- 主題
- 減少動態效果
- 離線匯出
- 完整備份 / 還原
- 執行狀態

UI 語言和生成內容語言是獨立的。

[[SCREENSHOT:G_DOC_SETTINGS_BACKUP.png|設定、執行狀態與備份]]

## 14. 離線匯出

「離線書」是目前 session 的可攜式靜態閱讀版本。
它適合閱讀，但不是完整災難復原備份。

## 15. 完整備份

Owner backup 包含工作階段、節點、分支、圖片與 SHA-256 manifest。

建議在系統升級、大量刪除或重要探索完成後備份，並保存到 NAS 以外的位置。

## 16. 還原

先做「模擬還原 / dry-run」，確認 ZIP、SHA、衝突與資料結構。
只有按「確認還原」才真正寫入。

## 17. 系統狀態

正常應看到 Backend / Mongo / MinIO 都已連線。
`/api/ready` 不會呼叫 AI。

## 18. 常見問題

### 產生失敗
先再試一次。持續失敗時檢查 `/api/ready` 和 `/status`。

### 新頁顯示但 History 沒有
現行 release 已修正 first-child persistence race；若再次發生，截圖並記錄時間。

### 相關主題沒有建議
不會自動生成圖片。可改用 hotspot 或從上方輸入新主題。

### 歷史紀錄刪不掉
現行 NAS self-use release支援舊 browser cookie 的 session。若仍失敗，保留錯誤訊息。

### 手機圖片無法顯示
正常圖片走 same-origin `/api/image/<nodeId>`，不需手機直連 MinIO localhost。

## 19. 使用限制

私人自用版本，不支援公開多使用者協作。
World Mode、AI video、AI prefetch、provider/model 切換均停用。

新內容需要 OpenClaw 與模型服務；已存 History、離線書、備份不應因此消失。

## 20. 安全與資料建議

- 定期備份。
- 不要刪除 Mongo/MinIO volumes。
- 不要公開完整備份 ZIP。
- AI 內容與來源仍需自行判讀。
- 更新前先 backup + restore dry-run。

## 21. 版本

正式自用 release：`nas-self-use-v1.0.2`
Next.js：`15.5.24`

包含 HF1–HF4 的互動/persistence 修復與 2026-08 Next.js security maintenance。
