# ChatChat & 心情宇宙

免註冊的靜態網頁小應用，兩個功能：

- **ChatChat**：輸入房號建立或加入即時文字聊天室（訊息、圖片、回覆、表情、踢人、解散）。
- **心情宇宙**：把心情貼成夜空中的星點，別人的迴響會變成環繞的橘色微光。

無後端伺服器、無建置流程，整個站台就是 GitHub Pages 上的靜態檔案，資料存在 Firebase Realtime Database。

> ⚠️ **目前的資料庫規則是公開的**：任何拿到資料庫網址的人都能讀取（很可能也能寫入）所有房間與心事。這是最需要優先用 `SECURITY.md` 修掉的問題。程式碼端的 XSS 與輸入驗證已經修好，但那無法取代資料庫規則。

---

## 檔案結構

```
index.html                     唯一的頁面（HTML 骨架）
assets/css/tailwind.css        預先編譯的 Tailwind（產物，要 commit）
assets/css/app.css             設計系統：色票、亮暗主題、所有元件外觀
assets/js/app.js               應用邏輯：畫面切換、Firebase、訊息與宇宙
assets/js/sanitize.js          輸入淨化與驗證（純函式，可單獨測試）
assets/js/avatar.js            名字 → GrokBot 頭像（固定、可重現）
assets/js/watermark.js         頁面標記：整頁平鋪的明文小字（純函式，可單獨測試）
assets/js/vendor/grokbot.js    打包後的 grokbot 繪圖引擎（產物，要 commit）
assets/img/*.webp              站台圖片（由 PNG 轉來）
tailwind.input.css             Tailwind 的進入點（給重建指令用）
tools/selfcheck.mjs            31 項自我檢查
tools/e2e.mjs                  jsdom 端到端流程測試（40 項）
vendor/grokbot/                頭像引擎原始碼與授權（BSD-3-Clause）
SECURITY.md                    安全現況、修好的部分、需要你動手做的部分
```

## 本機預覽

ES module 與相對路徑的關係，直接開檔案會壞掉，請用一個靜態伺服器：

```bash
python3 -m http.server 8080     # 然後開 http://localhost:8080
```

## 三個產物怎麼重建

改過 `index.html` 的 class 之後：

```bash
npx tailwindcss@3.4.17 -i tailwind.input.css -o assets/css/tailwind.css \
  --content "index.html,assets/js/app.js,assets/js/avatar.js" --minify
```

圖片（`universe.webp` 用有損、星球用無損，才能保住像素邊緣）：

```bash
cwebp -q 82 -m 6 -metadata none universe.png -o assets/img/universe.webp
for f in angry bored happy other sad touching; do
  cwebp -lossless -z 9 -m 6 -metadata none "$f.png" -o "assets/img/$f.webp"
done
ffmpeg -i universe.png -i assets/img/universe.webp -lavfi ssim -f null -   # 應該 > 0.99
```

頭像引擎（只有在要升級 `vendor/grokbot/` 的原始碼時才需要）：

```bash
npx esbuild@0.25.10 vendor/grokbot/src/index.ts --bundle --format=esm --minify \
  --target=es2020 --legal-comments=none --outfile=assets/js/vendor/grokbot.js \
  --banner:js='/* grokbot-web (BSD-3-Clause) - vendored - see vendor/grokbot/LICENSE */'
```

## 檢查

```bash
npm install        # 只有測試需要（jsdom）；網站本身零依賴
npm test           # = selfcheck + e2e
```

- **`tools/selfcheck.mjs`（31 項）**：輸入淨化、房號與圖片來源白名單、頻率限制、頭像可重現、頁面標記的內容與透明度、程式碼裡沒有 `innerHTML` 或行內事件、`app.js` 取用的每個 id 都存在、每個被引用的資產都存在、CSS 括號成對。
- **`tools/e2e.mjs`（40 項）**：在 jsdom 裡跑真正的 `app.js`（Firebase 換成 `tools/fb-stub.js`），走一遍「建立房間 → 按鈕送出 → Enter 送出 → 離開 → 重新整理自動回房 → 心情宇宙點星點 → 點心情看清單」。
  這個測試是必要的：靜態檢查抓不到「呼叫了不存在的 API」——`chatLimiter.allow()` 這個打字錯誤就是它抓到的（詳見 `SECURITY.md` 的變更記錄）。

## 防複製與水印

- **防複製**：全站關閉文字選取、右鍵選單與複製／剪下事件（輸入框例外，要能編輯自己的草稿）。這是摩擦，不是防護。
- **水印**：一層，內容是**明文**（暱稱、房號、機型、公網 IP，各一行），強制開啟、畫面上完全看不到也沒有開關。
  整頁平鋪斜向的小字（細體 16px），透明度 0.002（`assets/js/watermark.js` 的 `MARK_ALPHA`），亮色主題用黑字、暗色主題自動換白字。

取出不需要程式：拿到截圖後丟進任何修圖軟體，把曲線拉高對比或套閾值（Threshold），四行字就會浮出來。

限制：
- **只跟著畫面截圖走**。外流的圖片檔本身（下載下來的 WebP）、複製出去的文字，都不帶任何標記。
- 截圖若被二次縮圖或重壓縮到很糊，對比拉到底也可能只剩輪廓。
- 透明度有硬下限：8 bits 下黑字最淡只能到 1 階（254 vs 255），也就是 `MARK_ALPHA` 最小 0.002；再往下調不會更淡，會直接消失。真的還看得到就改墨跡面積（字重、字級、每磚幾行）。
- 代價：1 階的標記只撐得住無損 PNG 截圖，二次壓縮就沒了；要耐壓縮得把 `MARK_ALPHA` 拉到 0.008 以上並同時加粗。
- **公網 IP 是本站唯一的第三方請求**：開頁時向 `api.ipify.org` 問自己的 IP（靜態站看不到自己的 IP）。會被廣告阻擋器或離線擋掉，拿不到就少寫那一行。IP 是瀏覽器自報的，改過的客戶端可以填假的。

## 心情宇宙怎麼讀

星點只有 12px，在手機上很難精準點到，所以有三條路：

1. **點星點附近就算點到它**：整個宇宙畫面都接受點擊，落在某顆星 44px（約手指半徑）內就開啟最近的那一顆。
2. **點心情看清單**：說明面板的六個心情列可點，列出該心情的全部心事（作者、時間、摘要、迴響數），點一列直接讀。每一列右邊顯示該心情目前的顆數。
3. **點星球分享**：把新的心事化成星點。

星點位置在渲染時才計算（`findFreeSpot`）：先讓六顆星球佔位，星點若與其他星點或星球太近，就沿黃金角螺旋往外找位置，因此不會擠成一團或藏在星球背後；視窗尺寸改變時會重畫。

## 頭像怎麼運作

沒有上傳頭像的人，用**名字**當種子產生一張 GrokBot 臉：

- 同一個名字永遠得到同一張臉（形狀、表情、配色、翻面都由一組可重現的偽隨機序列決定）。
- 頭像引擎（`grokbot-web`，BSD-3-Clause）約 50KB，**只在使用時才動態載入**，不影響首頁。
- 畫在記憶體中的 canvas 上，畫完立刻 `destroy()`，不會留下動畫迴圈。
- 有上傳自訂頭像就優先用上傳的。

## 這台裝置上存了什麼

| 位置 | 內容 | 用途 | 什麼時候清掉 |
| --- | --- | --- | --- |
| `localStorage` `chatchat-theme` | `system` / `light` / `dark` | 記住佈景主題 | 你自己清瀏覽器資料 |
| `localStorage` `chatchat-last-input` | 上次的房號與暱稱 | 下次開站填回欄位（**不會自動進房**） | 同上 |
| `localStorage` `chatchat-avatar` | 自訂頭像（壓縮後的 WebP，data URL；超過約 400KB 就不存） | 下次開站沿用同一個頭像 | 按「用名字產生」或清瀏覽器資料 |
| `sessionStorage` `chatchat-session` | 目前所在的房號與暱稱 | 重新整理後自動回房；只跟這個分頁，所以另開分頁測試第二位使用者不會互相干擾 | 按退出／解散，或關掉分頁 |

伺服器端除了 Firebase 之外沒有任何儲存；頭像與訊息都是明文存在 Firebase（見 `SECURITY.md`）。

## 佈景主題

`:root` 是亮色（暖紙、1px 細線、藍色強調），`:root[data-theme="dark"]` 是暗色。切換順序是「跟隨系統 → 亮色 → 暗色」，選擇存在 `localStorage`。心情宇宙永遠是夜晚，不隨主題翻面（那裡的文字與面板用固定的夜晚色票）。

`index.html` 的 `<head>` 有一小段同步程式碼，在樣式套用前就決定主題，避免載入時閃一下錯的顏色。

## 部署

GitHub Pages，來源是 `main` 分支根目錄。commit 並 push 之後幾十秒內會自動更新——但**目前這個 repo 的協作者權限只給到讀取**，所以要先處理權限，或由你自己 push。

## 授權與致謝

- 頭像引擎：**[grokbot-web](https://github.com/Coiggahou2002/grokbot-web)**（BSD-3-Clause），它是 **[nasawz/GrokBot](https://github.com/nasawz/GrokBot)**（Flutter，BSD-3-Clause）的 Canvas 2D / TypeScript 移植版。頭像的造型設計全部出自 nasawz。
- 字體：**[Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)**（TakWolf，SIL OFL 1.1），透過 `@vp-tw/cjk-web-fonts-fusion-pixel-font` 的 webfont 分包載入。
- 這個 repo 本身沒有附授權檔，代表「保留所有權利」；要公開讓別人用，請自己補一個授權。
