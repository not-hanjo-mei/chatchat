# 安全說明

最後更新：2026-09-20。這份文件記錄「現在的實際狀況」、這次修好了什麼、以及**只有你能做**的部分。

---

## 1. 現況：資料庫是公開的（未修）

Firebase Realtime Database `chat-f46da` 目前沒有任何認證要求。我用未帶任何憑證的請求就能讀到資料：

```bash
# 不需要 token，回傳 {"rooms":true,"universe":true}
https://chat-f46da-default-rtdb.firebaseio.com/.json?shallow=true
```

實際影響：

- 任何人可以列出所有房間、讀取所有人的對話與心事。
- 因為讀寫規則通常是同一個開關，**寫入與刪除極可能也是開放的**：任何人可以冒充房主、踢人、刪房、灌資料。（我沒有實際送出寫入來確認，所以這點標記為「未驗證，但必須當成已經發生」。）
- 悲觀假設：`/rooms` 與 `/universe` 底下的所有內容都應該視為已外洩。

**這件事無法只靠前端修好。** 以下是需要你做的。

## 2. 需要你動手的三步

### 步驟 A：改成需要登入（前端已經準備好一半）

1. Firebase Console → **Authentication → Sign-in method → Anonymous → 啟用**。
2. Console → **Authentication → Settings → Authorized domains**，把 `yesiamyuyi-ux.github.io` 加進去。
3. 前端要接上匿名登入（這次沒有動，因為你選擇先不動資料庫）。`assets/js/app.js` 需要的最小改動：

```js
import { getAuth, signInAnonymously, onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const auth = getAuth(initializeApp(firebaseConfig));
onAuthStateChanged(auth, (user) => { /* 準備好之後才開放建立／加入房間 */ });
await signInAnonymously(auth);
state.userId = auth.currentUser.uid;   // 用 auth.uid 取代自我產生的 ID
```

`assets/js/sanitize.js` 的 `USER_ID_PATTERN` 已經先放寬成同時接受 `user_...` 與 28 字元的 Firebase UID，所以不需要再改驗證規則。

**順序很重要：先改前端、再套規則。** 反過來做，網站會直接壞掉（所有人讀不到也寫不進去）。

### 步驟 B：套用資料庫規則

把下面內容貼進 Console → **Realtime Database → Rules**（先在 **Rules Playground** 測過再發布；我沒有 Console 權限，所以這份規則沒有在你的專案上實測過）。

設計重點：

- 一律需要登入（`auth != null`）。
- 只有**房間成員**能讀該房間；加入房間就是寫入自己的成員節點，所以「房號」本身就是邀請憑證 → 房號必須猜不到（前端已提供隨機房號按鈕）。
- 訊息只能以自己身分送出（`sender == auth.uid`），別人不能冒名。
- 房主離開後，任何人可以接手當房主；被記錄為房主但不是成員時，其他成員可以取代它——否則房間會卡在沒有房主的狀態。
- 長度限制放在 `.validate`，避免單筆資料塞爆節點。

```json
{
  "rules": {
    ".read": false,
    ".write": false,

    "rooms": {
      "$roomId": {
        ".read": "auth != null && data.child('members').child(auth.uid).exists()",

        "host": {
          ".write": "auth != null && (data.val() == auth.uid || !data.exists() || !root.child('rooms').child($roomId).child('members').child(data.val()).exists())",
          ".validate": "newData.isString() && newData.val().length <= 64"
        },

        "settings": {
          ".read": "auth != null && root.child('rooms').child($roomId).child('members').child(auth.uid).exists()",
          ".write": "auth != null && root.child('rooms').child($roomId).child('host').val() == auth.uid"
        },

        "members": {
          "$uid": {
            ".write": "auth != null && auth.uid == $uid",
            ".validate": "newData.hasChildren(['name', 'joinedAt']) && newData.child('name').isString() && newData.child('name').val().length <= 10 && newData.child('joinedAt').isNumber() && (!newData.hasChild('avatar') || newData.child('avatar').isString() && newData.child('avatar').val().length <= 700000)"
          }
        },

        "messages": {
          "$msgId": {
            ".write": "auth != null && root.child('rooms').child($roomId).child('members').child(auth.uid).exists()",
            ".validate": "newData.hasChildren(['sender', 'name', 'timestamp']) && newData.child('sender').val() == auth.uid && (!newData.hasChild('text') || newData.child('text').isString() && newData.child('text').val().length <= 2000) && (!newData.hasChild('image') || newData.child('image').isString() && newData.child('image').val().length <= 900000)"
          }
        }
      }
    },

    "universe": {
      "posts": {
        ".read": "auth != null",
        "$postId": {
          ".write": "auth != null",
          ".validate": "newData.hasChildren(['emotion', 'name', 'text', 'timestamp']) && newData.child('text').isString() && newData.child('text').val().length <= 1000 && newData.child('name').isString() && newData.child('name').val().length <= 10",
          "replies": {
            "$replyId": {
              ".write": "auth != null",
              ".validate": "newData.hasChildren(['name', 'text', 'timestamp']) && newData.child('text').isString() && newData.child('text').val().length <= 500"
            }
          }
        }
      }
    }
  }
}
```

### 步驟 C：加上 App Check（擋掉站外呼叫）

Console → **App Check** → 註冊 Realtime Database → reCAPTCHA v3（網頁）。這能讓「不是從這個網站發出的請求」被拒絕，是開放式前端唯一有效的濫用防線。前端之後要加：

```js
import { initializeAppCheck, ReCaptchaV3Provider } from
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
initializeAppCheck(app, { provider: new ReCaptchaV3Provider("<site key>"), isTokenAutoRefreshEnabled: true });
```

## 3. 這次已經修好的部分

### 跨站指令碼（stored XSS）— 原本是最嚴重的前端漏洞

原本所有資料都是字串組 HTML：`innerHTML = \`<img src="${mem.avatar}">\``、`onclick="window.kick('${uid}')"`、`u-read-text.innerHTML = data.text.replace(...)`。任何人在暱稱填入 `"><img src=x onerror=alert(1)>` 就能在房間裡所有人的瀏覽器上執行任意程式碼。

現在：

- 全部改用 `textContent` 與 DOM API（`createElement`、`append`、`replaceChildren`），程式碼裡沒有任何 `innerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function`。
- 沒有任何行內事件處理器；事件一律 `addEventListener`，需要帶資料時用 `dataset` 或閉包，不把資料寫進 HTML 屬性。
- 訊息的 `@標記` 用 DOM 節點組出來，不是把字串塞進 HTML。
- 圖片來源白名單：只接受 `data:image/{png,jpeg,webp,gif};base64,...` 與 `https://...`，所以 `javascript:`、`data:text/html`、帶引號的注入字串都會被丟掉。
- 點圖開新視窗用 `window.open(safeSrc, "_blank", "noopener,noreferrer")`。
- 浮

驗證方式（`tools/selfcheck.mjs` 會自動跑）：

```bash
node tools/selfcheck.mjs
# PASS 畫面渲染不走 innerHTML／字串組 HTML
# PASS 沒有行內事件處理器（杜絕把資料插進 HTML 屬性）
# PASS app.js 取用的每個 id 都真的存在於 index.html
```

### 輸入界線

- 暱稱 10 字、訊息 2000 字、心事 1000 字、迴響 500 字，都在寫入前截斷，並移除控制字元、雙向覆寫（可用來偽造順序）與零寬字元。
- 房號只接受 `[A-Za-z0-9_-]{1,32}`，擋掉 Firebase 的禁用字元（`. # $ [ ] /`），也避免路徑穿越。
- 表情只接受真正的單一表情符號（`1234`、`ab`、`<img>` 都會被拒），避免拿來當任意字串塞進資料庫 key。
- 時間戳防呆，`new Date(undefined)` 不會產生 Invalid Date。

### 頻率限制與頻寬

- 送出訊息：最快 0.7 秒一則、每分鐘 20 則；心事／迴響：1.5 秒、每分鐘 10 則。超過會顯示還要等幾秒。
- 上傳圖片先在瀏覽器縮到 1280px（頭像 256px）並轉成 WebP，輸出上限約 675KB；解碼失敗（例如某些瀏覽器的 HEIC）才退回原檔，仍然檢查大小。
- **提醒：** 這些都是前端自律，只有步驟 B 的規則才是真正的防線。

### 移除的虛假安全感

- 「即時加密對話」→ 改成事實描述；頁面上明白寫出「沒有端到端加密、內容以明文儲存」。
- 「防截圖模式」與「防誤傳模式」→ 介面上完全移除，不再有任何名稱或開關。
- 原本按下 PrintScreen 會彈出「系統已記錄您的截圖嘗試行為」——**這是假的**，沒有任何記錄行為，這段提示與監聽已刪除。
- 房間加入提示：「房間沒有密碼，只有房號」。

### 防複製（全站、不分房主）

文字選取與右鍵選單全站關閉，`copy`／`cut` 事件一律攔掉，只有輸入框與文字區放行（要能編輯自己的草稿）。它擋的是「順手帶走」，不是防護：devtools、reader mode、OCR、截圖、直接讀資料庫都繞得過，所以它不改變「訊息是明文、而且可被大範圍讀取」這個事實。

### 水印（強制、無介面提示）

有兩層，內容都是「**使用者 ID 指紋 ＋ 裝置簽章**」，例如 `wd64d9.SM-G991B-3k9v2xq`：

1. **畫面疊層**：整頁蓋一層透明 canvas（`assets/js/screenmark.js`），不透明度 0.05，把標記寫在畫面的中頻係數上。截圖（PNG 不失真）就能取出標記，畫面上看不出來（平均差約 5/255、最大 9）。
2. **圖片本身**：送進房間的圖片在轉檔前也會被打上盲水印（`assets/js/watermark.js`，演算法移植自 [blind_watermark](https://github.com/guofei9987/blind_watermark)：YUV→Haar 小波→區塊 DCT→SVD→QIM 量化，三通道取多數決）。這層耐重新壓縮成 WebP q82。

- 使用者 ID 用 FNV-1a 壓成 6~7 個 base36 字元才塞得進標記；取出後用成員名單比對就能還原成誰。
- 裝置簽章是用 canvas 畫一段固定圖樣再雜湊結果（字型、反鋸齒、GPU、色彩處理都會影響輸出），不用 user agent：UA 可以造假、會被隱藏，也會隨版本變動。canvas 不可用時才退回 UA 的機型名。
- 強制開啟，沒有任何介面開關或說明文字；取出不需要原圖。

實測與限制（`npm run test:watermark`）：

| 情境 | 結果 |
| --- | --- |
| 全螢幕截圖，PNG | 取得回（含瀏覽器介面造成的位移） |
| 截圖被轉成 JPEG/WebP | 取不回（疊層振幅太小，除非把透明度開到看得見） |
| 畫面整頁都是照片（沒有平坦區） | 疊層取不回；改靠圖片本身的標記 |
| 送進房間的圖片，再壓成 WebP q82 | 取得回 |
| 圖片被縮圖或裁切 | 取不回（區塊格線對不上） |

- 取出工具：`node tools/watermark-decode.mjs 圖檔 [成員名單檔]`，兩種載體都會試。
- 它能指出「這張截圖／這張圖是誰的裝置留下的」，不能阻止外流，也不能證明是誰按下的快門。

### 本機儲存

瀏覽器端只存四樣東西，全部是使用者自己的資料，沒有任何追蹤碼：佈景主題、上次的房號與暱稱、自訂頭像（`localStorage`），以及目前所在房間（`sessionStorage`，只跟單一分頁）。詳見 `README.md` 的「這台裝置上存了什麼」。自訂頭像超過約 400KB 就不會寫入，避免佔滿 localStorage 配額。

### 依賴與其他

- 拿掉 `cdn.tailwindcss.com`（Play CDN 是官方標示的開發用版本，而且等於讓第三方在頁面上執行任意程式碼）。Tailwind 改成預先編譯成本機的 `assets/css/tailwind.css`。
- 拿掉 `api.dicebear.com`：預設頭像改成用名字在本機產生，不再把使用者的名字送到第三方。
- 使用者 ID 改用 `crypto.randomUUID()`，不再是 `Math.random()`。
- 監聽器在離開／解散房間時會取消訂閱；房主切換、成員變更都收斂到同一個同步函式，不再重複註冊事件。
- 新增 `referrer` 政策與 `noopener`。

## 4. 還沒解決、需要你決定的事

| 項目 | 為什麼還在 | 建議 |
| --- | --- | --- |
| 資料庫公開讀寫 | 需要 Console 權限與前端接上匿名登入 | 照第 2 節做，先 A 再 B |
| 房主可被搶 | 規則開放時，任何人都能寫 `host` 節點 | 步驟 B 的規則會擋掉；在那之前不要放重要內容 |
| 身分可偽造 | 沒有登入，`sender` 是前端自己填的 | 步驟 A |
| 訊息永久留存 | RTDB 沒有 TTL；前端刪除會互相競爭，不安全 | 之後用排程的 Cloud Function 清理，或搬到 Firestore（有 TTL） |
| 圖片存 base64 在資料庫 | 換成 Storage 需要規則與前端一起改 | 訊息圖片已經先縮到 1280px WebP；量大了再搬 |
| `universe/posts` 全量下載 | 查詢加了 `limitToLast(300)`，但沒有 `.indexOn` 時 Firebase 仍會先抓整包 | 在規則的 `universe/posts` 加 `".indexOn": ["timestamp"]` |
| 第三方 CDN | 字體從 jsDelivr 載入（Firebase SDK 從 gstatic） | 想在嚴格環境跑就把字體也放到本機；`SECURITY.md` 記錄這件事本身就是風險可見性 |
| 沒有授權檔 | 公開 repo 沒授權＝保留所有權利 | 要讓別人用就補一個 LICENSE |

## 5. 修掉的前端缺陷記錄

| 症狀 | 原因 | 修法 |
| --- | --- | --- |
| 按送出／Enter 完全沒反應，訊息不出去、輸入框也不清空 | `chatLimiter.allow()` —— `createRateLimiter()` 回傳的是函式本身，呼叫 `.allow()` 直接 TypeError。例外在 `sendChatMessage()` 內被吞掉，所以畫面完全沒提示 | 改成直接呼叫，並在 selfcheck 加上禁止 `.allow()` 的守門 + `tools/e2e.mjs` 實際送出訊息 |
| 重新整理就掉出房間 | 沒有任何狀態保存，而且舊連線的 `onDisconnect` 會刪掉成員節點 | `sessionStorage` 記住房號與暱稱（只跟這個分頁，另開分頁測試另一位使用者不會互相干擾），載入時自動回房；成員名單第一次看不到自己時會重試，避免被上一條連線的 `onDisconnect` 誤踢 |
| 退出鈕按了沒反應 | `await remove(...)` 之後才切畫面。RTDB 在離線時不會 reject 只會無限期 pending，所以連線一卡住就永遠退不出去 | 先離開畫面、背景再刪節點；並移除自己造成成員變更時不會再跳出「你已被移出房間」的假警報 |
| 移動端點不到下方星球 | `100vh` 把手機底部算到瀏覽器工具列底下；星點位移最大 27vh 會蓋住星球 | 改用 `100dvh` + `safe-area-inset`；星球座標收進安全帶；星點位移夾在 ±11vh/vw；星點可點範圍從 10px 擴大到 28px |
| 輸入框變成扁扁的一條 | 模組載入時聊天室還是 `display: none`，`scrollHeight` 為 0，行內高度被寫成 2px | `min-height: 44px` 的 `.input--grow`；元素隱藏時不寫行內高度；切換畫面後重新量測 |
| 送出頻率限制誤擋 | 無（設計行為） | 前端限流只在同一次連線有效，真正的防線仍是資料庫規則 |

## 6. 我做了什麼、沒做什麼（透明說明）

- 讀取測試是在沒有帶憑證的情況下對 `/.json?shallow=true` 發出的，只讀取鍵名，沒有讀取內容、沒有寫入、沒有刪除任何資料。
- 房間 5 的內容是你自己留下的審計訊息，我用同樣的公開端點讀取它來確認問題（那也是你在對話中要我去讀的）。
- 資料庫規則與匿名登入我沒有實作、沒有實測：你選擇先不動資料庫。上面提供的規則請先在 Console 的 Rules Playground 驗證，再發布。
