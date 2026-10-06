# 結構認證路徑測驗（LIFF 版）

Cloudflare Worker + D1，免費方案即可運作。

- `public/index.html`：測驗本體。在 LINE 內打開時自動帶入 LINE 身分；在外部瀏覽器打開也會照常記錄（匿名）。
- `public/admin.html`：數據後台（漏斗、逐題跳出、來源、作答名單與完整過程、匯出 CSV）。
- `src/index.js`：API（建立紀錄、逐題儲存、行為事件、留資料、試填回饋、後台查詢）。
- `migrations/0001_init.sql`：資料表。

## 會記錄什麼

| 時機 | 存什麼 |
|---|---|
| 一打開 | LINE userId、名稱、頭像、email（有申請權限才有）；UTM、推薦碼 `ref`、入口 `entry`、fbclid／gclid、落地網址、referrer；LINE 內或外部瀏覽器、開啟位置（聊天室／群組）、OS、語言、LINE 版本、時區 |
| 每答一題 | 完整答案快照、答到第幾題、每題花幾秒、按上一題次數、改答案紀錄 |
| 完成 | 推薦結果、方案、高意向標記、Q10 偏好 |
| 留資料頁 | 有沒有看到、選了送出／略過／LINE |
| 結果頁 | 捲到哪一段、點了幾次卡位按鈕 |
| 離開或切到背景 | 用 sendBeacon 送出最後進度，關掉頁面也送得到 |
| 留資料 | 只在按下「送出」時儲存；沒送出的表單內容一律不記錄 |

LINE 身分一律由後端向 LINE 驗證 ID Token 後取得，前端傳來的 userId 不採信。
同一個人 7 天內回來，會詢問是否從上次的題目接續；被接續的舊紀錄不算跳出。

## 部署：Cloudflare Workers Builds（推薦，推上 GitHub 就自動上線）

D1 資料庫已建立（`structure-quiz`，ID 已填在 `wrangler.toml`）。

1. Cloudflare 主控台 → Workers & Pages → Create → Import a repository → 選 `cicostudio/structure-quiz`
2. Build 設定：
   - Build command：留空
   - Deploy command：`npm run deploy`（會先套用資料表，再部署 Worker）
3. 之後每次 push 到 `main` 都會自動部署。
4. 若部署記錄出現 D1 權限錯誤：到 Workers Builds 的 API token 設定，替它加上 **D1 Edit** 權限後重新部署。

## 部署：自己的電腦（手動）

```bash
npm install
npx wrangler login

# 資料庫已建立；這一步會套用資料表並部署，取得網址（例：https://structure-quiz.<你的子網域>.workers.dev）
npm run deploy
```

3. **LINE Developers Console** → 與官方帳號相同用途的 LINE Login channel → LIFF → Add
   - Size：Full
   - Endpoint URL：上一步的網址
   - Scopes：`openid`、`profile`（已通過 email 權限申請的話再勾 `email`）
   - 建立後把 LIFF ID 填進 `wrangler.toml` 的 `LIFF_ID`，channel ID 填進 `LINE_LOGIN_CHANNEL_ID`
4. 在 `wrangler.toml` 填 `OA_BASIC_ID`（例：`@cohesion`）與 `PRIVACY_URL`，再 `npm run deploy` 一次。

## 後台登入

正式環境建議用 **Cloudflare Access**（免費 50 人以內）：

1. Cloudflare Zero Trust → Access → Applications → Add → Self-hosted
2. 網域填上面的 Worker 網域，路徑加兩條：`/admin`、`/api/admin/*`
3. Policy：允許你和指定教練的 email
4. 把 Access 的 team domain（例：`cohesion.cloudflareaccess.com`）與 Application AUD 填進 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`，重新部署

Access 還沒設定前，可以先用密碼：

```bash
npx wrangler secret put ADMIN_TOKEN
```

後台網址：`https://<你的網域>/admin`

## 分享連結

- LINE 內使用：`https://liff.line.me/<LIFF_ID>?utm_source=richmenu&entry=richmenu`
- 貼文／廣告：`https://liff.line.me/<LIFF_ID>?utm_source=instagram&utm_campaign=oct`
- 教練推薦：`https://liff.line.me/<LIFF_ID>?ref=eason`

## 教練試填 → 正式上線

- `TRIAL_MODE = "1"`：結果頁出現回饋表與推薦邏輯追蹤，紀錄標為「試填」。
- 正式上線改成 `"0"` 再部署。後台可以切換「只看正式／只看試填」。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # 設一組 ADMIN_TOKEN
npm run db:migrate:local
npm run dev                      # http://localhost:8787 與 /admin
```

## 尚未包含（下一階段）

- 官方帳號 webhook：收到「我想收到我的結構學習路徑（#XXXXXX）」時，用代碼把這筆作答綁到官方帳號的 userId，並自動回覆結果。代碼就是作答紀錄 id 的前 6 碼。
- n8n 自動跟進（中途離開、完成但沒留資料、高意向通知）。
- 建議在 Cloudflare WAF 加一條速率限制規則（免費方案有 1 條），保護 `/api/session/start`。
