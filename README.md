# OpenFlipbook NAS — 私人互動式圖像探索

> 私人 NAS 自用版。以 AI 產生的圖像作為主要介面，點選圖中的語意區域即可沿著主題繼續探索。

**Release:** `nas-self-use-v1.0.1`
**Security baseline:** Next.js `15.5.24`
**Default UI:** 繁體中文 (`zh-TW`)

## 這個版本是什麼

這個 repository 是基於 `eren23/openflipbook` 的私人 NAS self-use fork。

目前產品路線：
- Web：Next.js 15，NAS 上唯一 LAN-facing 服務。
- Backend：FastAPI，僅透過 authenticated OpenClaw Gateway 使用模型。
- Planner / alignment：`openai/gpt-5.6-luna`
- Image：`openai/gpt-image-2`
- Metadata：MongoDB
- Images：MinIO
- canonical Compose project：`openflipbook-a0`

沒有 FAL/OpenRouter/direct API-key fallback。

## 主要功能

- 文字主題或圖片起始
- 可見的語意 hotspot 標籤與圖像區域探索
- 圖片外的分支 chooser
- 「相關主題」先顯示 3–5 個文字建議，選一個後才生成
- 歷史紀錄 Resume / 刪除
- Sources 面板
- 繁中 UI，UI locale 與 output locale 分離
- 單一 session 離線匯出
- owner backup / dry-run / restore
- `/api/ready`、`/api/status`、`/status`

## 快速使用

1. 開啟 `http://<NAS-IP>:3000/play`。
2. 輸入主題，或按「上傳」。
3. 等待頁面生成並儲存。
4. 點 hotspot 標籤或圖中區域。
5. 從圖片下方分支列切換已探索分支。
6. 按「相關主題」先看文字建議，再選一個生成。
7. 「歷史紀錄」可 Resume 或刪除。

完整說明：
[`docs/OpenFlipbook_NAS_使用說明書_zh-TW.docx`](docs/OpenFlipbook_NAS_使用說明書_zh-TW.docx)

## Canonical NAS 操作

```bash
scripts/nas-compose.sh config --quiet
scripts/nas-compose.sh ps
scripts/nas-compose.sh up -d
```

Web-only update:

```bash
scripts/nas-compose.sh build web
scripts/nas-compose.sh up -d --no-deps web
curl -fsS http://127.0.0.1:3000/api/ready
```

不要使用 `docker compose down -v`。

## 資料與備份

- Mongo：`openflipbook-a0_mongo-data`
- MinIO：`openflipbook-a0_minio-data`

升級前先：
1. 下載完整 owner backup。
2. 記錄 SHA-256。
3. 執行 restore dry-run。
4. 再更新 stateless application services。

離線書用於閱讀；完整備份才是 disaster recovery。

## 安全基線

`nas-self-use-v1.0.1` 使用 Next.js `15.5.24`，包含 2026-08
Maintenance-LTS security backport，並完成 Web rollback / roll-forward 與
Chromium regression。

## NAS 版刻意停用

- World Mode
- AI video
- AI prefetch
- alternate provider fallback
- editable provider/model routing
- public multi-user / SaaS
- upstream auto-merge

## 維護

- [`docs/NAS_MAINTENANCE.md`](docs/NAS_MAINTENANCE.md)
- [`docs/DEVELOPER_HANDOFF.md`](docs/DEVELOPER_HANDOFF.md)

未來只在 security advisory、targeted upstream fix、OpenClaw compatibility
或實際 bug 出現時開 maintenance round。

## Upstream / License

Fork 自 [`eren23/openflipbook`](https://github.com/eren23/openflipbook)。
保留原專案 MIT License 與 upstream attribution。
