/* 自我檢查：node tools/selfcheck.mjs
   驗證輸入淨化的行為，以及 vendored 的 grokbot 引擎能不能正常畫出一格。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { deviceModel } from "../assets/js/sanitize.js";
import {
    embedImageWatermark,
    embedTextMark,
    extractImageWatermark,
    extractTextMark,
    fingerprint,
    markPayload,
    PAYLOAD_MAX as PAYLOAD_MAX_PUBLIC,
} from "../assets/js/watermark.js";
import {
    cleanName,
    cleanText,
    createRateLimiter,
    escapeXml,
    formatRateLimitNotice,
    isValidRoomId,
    isValidUserId,
    makeRoomCode,
    safeEmoji,
    safeImageSrc,
    safeTimestamp,
    MAX_NAME,
} from "../assets/js/sanitize.js";

const results = [];
function check(label, fn) {
    fn();
    results.push(label);
}

/* ---------- 文字淨化 ---------- */
check("HTML 標籤不會被清洗成語法，只當普通文字保留", () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const cleaned = cleanText(payload, 100);
    assert.equal(cleaned, payload);
    assert.ok(!cleaned.includes("\u0000"));
});

check("控制字元與雙向覆寫被移除", () => {
    assert.equal(cleanName("ab\u202Ecd\u0000ef"), "abcdef");
    assert.equal(cleanText("hi\u200Bthere", 50), "hithere");
});

check("暱稱長度以字元數計算，不是位元組", () => {
    assert.equal(Array.from(cleanName("一二三四五六七八九十十一")).length, MAX_NAME);
    assert.equal(cleanName("  小明  "), "小明");
});

check("文字長度截斷保留換行", () => {
    assert.equal(cleanText("a\nb", 10), "a\nb");
    assert.equal(cleanText("a\r\nb", 10), "a\nb");
    assert.equal(cleanText("x".repeat(50), 10).length, 10);
});

/* ---------- 房號與身分 ---------- */
check("房號只接受英數與 - _，且擋掉 Firebase 禁用字元", () => {
    assert.ok(isValidRoomId("MAYO-4821"));
    assert.ok(isValidRoomId("room_1"));
    assert.ok(!isValidRoomId("房間"));
    assert.ok(!isValidRoomId("a.b"));
    assert.ok(!isValidRoomId("a/b"));
    assert.ok(!isValidRoomId("a#b"));
    assert.ok(!isValidRoomId("x".repeat(33)));
    assert.ok(!isValidRoomId(""));
    assert.ok(!isValidRoomId(" rooms/x "));
});

check("隨機房號猜不到且符合規則", () => {
    const codes = new Set();
    for (let index = 0; index < 200; index += 1) {
        const code = makeRoomCode();
        assert.ok(isValidRoomId(code), code);
        assert.ok(!/[^A-Z2-9]/.test(code), code);
        codes.add(code);
    }
    assert.ok(codes.size > 190, `重複率過高：${codes.size}/200`);
});

check("使用者 ID 格式受限（同時接受匿名 ID 與 Firebase Auth UID）", () => {
    assert.ok(isValidUserId("user_abc123"));
    assert.ok(isValidUserId("user_" + "x".repeat(32)));
    assert.ok(isValidUserId("aB3dE5gH7jK9mN1pQ3sT5vX7"));
    assert.ok(!isValidUserId("user_"));
    assert.ok(!isValidUserId("admin"));
    assert.ok(!isValidUserId("aB3dE5gH7jK9mN1pQ3s"));
    assert.ok(!isValidUserId("user_a/../b"));
    assert.ok(!isValidUserId("user_" + "x".repeat(33)));
    assert.ok(!isValidUserId("A".repeat(41)));
});

/* ---------- 圖片來源白名單 ---------- */
check("只接受 data:image 與 https 圖片", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    assert.equal(safeImageSrc(png), png);
    assert.equal(safeImageSrc("https://api.dicebear.com/7.x/bottts/svg?seed=abc"), "https://api.dicebear.com/7.x/bottts/svg?seed=abc");
    assert.equal(safeImageSrc("javascript:alert(1)"), "");
    assert.equal(safeImageSrc("data:text/html;base64,PHNjcmlwdD4="), "");
    assert.equal(safeImageSrc('https://x/\"><img src=x onerror=alert(1)>'), "");
    assert.equal(safeImageSrc("http://insecure.example/a.png"), "");
    assert.equal(safeImageSrc("./assets/img/happy.webp"), "");
    assert.equal(safeImageSrc(null), "");
    assert.equal(safeImageSrc("data:image/png;base64," + "A".repeat(1_000_000)), "");
});

/* ---------- emoji ---------- */
check("只接受真表情符號，字串與數字被拒", () => {
    assert.equal(safeEmoji("👍"), "👍");
    assert.equal(safeEmoji("❤️"), "❤️");
    assert.equal(safeEmoji("<img src=x>"), "");
    assert.equal(safeEmoji("1234"), "");
    assert.equal(safeEmoji("ab"), "");
    assert.equal(safeEmoji("👍".repeat(5)), "");
    assert.equal(safeEmoji(undefined), "");
});

/* ---------- SVG 跳脫 ---------- */
check("SVG 文字有跳脫，無法提早關閉 <text> 標籤", () => {
    const escaped = escapeXml('</text><script>alert(1)</script>');
    assert.ok(!escaped.includes("<"));
    assert.ok(!escaped.includes(">"));
    assert.equal(escapeXml("a & b"), "a &amp; b");
    assert.equal(escapeXml('say "hi"'), "say &quot;hi&quot;");
});

/* ---------- 圖片盲水印 ---------- */
/* 用固定種子的合成紋理圖，不依賴瀏覽器 canvas 或外部檔案。 */
function watermarkImage(width, height) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    let seed = 20260920;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            const base = 120 + 40 * Math.sin(x / 9) * Math.cos(y / 7) + random() * 24;
            pixels[at] = base;
            pixels[at + 1] = base * 0.9 + 10;
            pixels[at + 2] = base * 0.75 + 25;
            pixels[at + 3] = 255;
        }
    }
    return pixels;
}

check("標記內容是使用者指紋加裝置標籤", () => {
    assert.equal(markPayload("user_mayo_audit", "SM-G991B"), "wd64d9.SM-G991B");
    assert.equal(markPayload("user_mayo_audit"), "wd64d9.unknown");
    assert.equal(markPayload("user_mayo_audit", "中文機型！"), "wd64d9.unknown");
    assert.equal(fingerprint("mayonnaise"), 3621736253);
    const longest = markPayload("mai" + "x".repeat(400), "SM-G991B-1234567890");
    assert.ok(longest.length <= PAYLOAD_MAX_PUBLIC, `標記長度 ${longest.length} 超過上限`);
    assert.ok(longest.endsWith("SM-G991B-1234567890".slice(0, 20)), `裝置標籤被截掉了：${longest}`);
});

check("機型從 user agent 抓得出來，抓不到就說 unknown", () => {
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A) Chrome/120"), "SM-G991B");
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 12; V2166A; wv) Chrome/120"), "V2166A");
    assert.equal(deviceModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone");
    assert.equal(deviceModel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"), "Windows");
    assert.equal(deviceModel(""), "unknown");
    assert.equal(deviceModel(undefined), "unknown");
});

check("寫進圖片再取出來，內容一致", () => {
    const pixels = watermarkImage(640, 480);
    assert.ok(embedImageWatermark(pixels, 640, 480, "wd64d9.SM-G991B"), "寫不進去");
    assert.equal(extractImageWatermark(pixels, 640, 480), "wd64d9.SM-G991B");
});

check("標記改動幅度小到看不出來", () => {
    const before = watermarkImage(640, 480);
    const after = Uint8ClampedArray.from(before);
    embedImageWatermark(after, 640, 480, "wd64d9.SM-G991B");
    let total = 0;
    let worst = 0;
    for (let i = 0; i < after.length; i += 4) {
        const delta = Math.abs(after[i] - before[i]);
        total += delta;
        if (delta > worst) worst = delta;
    }
    assert.ok(total / (after.length / 4) < 8, `平均差 ${total / (after.length / 4)} 過大`);
    assert.ok(worst <= 40, `最大差 ${worst} 過大`);
});

check("加一點雜訊後仍取得回標記", () => {
    const pixels = watermarkImage(640, 480);
    embedImageWatermark(pixels, 640, 480, "wd64d9.SM-G991B");
    let seed = 5;
    const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < pixels.length; i++) {
        if (i % 4 === 3) continue;
        pixels[i] = Math.max(0, Math.min(255, pixels[i] + Math.round((random() - 0.5) * 12)));
    }
    assert.equal(extractImageWatermark(pixels, 640, 480), "wd64d9.SM-G991B");
});

check("沒寫標記的圖取不到東西", () => {
    assert.equal(extractImageWatermark(watermarkImage(640, 480), 640, 480), "");
});

check("太小的圖不寫，也不亂回東西", () => {
    const pixels = watermarkImage(96, 96);
    assert.equal(embedImageWatermark(pixels, 96, 96, "wd64d9.SM-G991B"), false);
    assert.equal(extractImageWatermark(pixels, 96, 96), "");
});

check("不合規的標記內容直接拒絕", () => {
    const pixels = watermarkImage(640, 480);
    assert.equal(embedImageWatermark(pixels, 640, 480, "這是中文標記"), false);
    assert.equal(embedImageWatermark(pixels, 640, 480, "x".repeat(60)), false);
});

/* ---------- 文字隱形標記（複製貼上會帶走的那一層） ---------- */
check("訊息文字裡插得進隱形標記，取出來一致", () => {
    const marked = embedTextMark("明天見", "wd64d9.SM-G991B");
    assert.equal(extractTextMark(marked), "wd64d9.SM-G991B");
});

check("標記不改變看得見的文字", () => {
    const original = "這是一則測試訊息，含表情 😀 與標點。";
    const marked = embedTextMark(original, "wd64d9.SM-G991B");
    assert.ok(marked.length > original.length, "沒有插入任何字元");
    /* 把零寬字元拿掉之後，必須與原文一字不差 */
    assert.equal(marked.replace(/[\u200b\u200c\u200d\u2060]/g, ""), original);
});

check("長訊息會重複寫好幾份，短訊息也能取回", () => {
    const long = embedTextMark("a".repeat(600), "wd64d9.SM-G991B");
    assert.equal(extractTextMark(long), "wd64d9.SM-G991B");
    assert.equal(extractTextMark(embedTextMark("嗨", "wd64d9.SM-G991B")), "wd64d9.SM-G991B");
});

check("乾淨的文字取不到東西", () => {
    assert.equal(extractTextMark("這是一段沒有標記的文字"), "");
    assert.equal(extractTextMark(""), "");
});

/* ---------- 時間 ---------- */
check("時間戳防呆", () => {
    assert.equal(safeTimestamp(1700000000000), 1700000000000);
    assert.equal(safeTimestamp("abc", 7), 7);
    assert.equal(safeTimestamp(NaN, 7), 7);
    assert.equal(safeTimestamp(0, 7), 7);
});

/* ---------- 頻率限制 ---------- */
check("app.js 呼叫頻率限制器的方式與 sanitize.js 的介面一致", () => {
    /* createRateLimiter 回傳的就是 allow 函式本身，寫成 xxx.allow() 會直接
       TypeError 讓送出整個失效（真的發生過）。 */
    const app = readFileSync("assets/js/app.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\.allow\(\)/.test(app), "app.js 出現 .allow() 呼叫");
});

check("頻率限制擋連點與爆量", () => {
    let now = 1000000;
    const allow = createRateLimiter({ windowMs: 60000, max: 3, minGapMs: 1000 }, () => now);

    assert.equal(allow().ok, true);
    assert.equal(allow().reason, "too-fast");
    now += 1000;
    assert.equal(allow().ok, true);
    now += 1000;
    assert.equal(allow().ok, true);
    now += 1000;
    const burst = allow();
    assert.equal(burst.ok, false);
    assert.equal(burst.reason, "too-many");
    assert.ok(formatRateLimitNotice(burst).includes("請等"));

    now += 60000;
    assert.equal(allow().ok, true);
    assert.equal(formatRateLimitNotice({ ok: true }), "");
});

/* ---------- 原始碼層級的迴歸檢查 ---------- */
const SOURCE_FILES = ["index.html", "assets/js/app.js", "assets/js/avatar.js", "assets/js/sanitize.js", "assets/js/watermark.js", "assets/js/screenmark.js"];
const APP_JS = readFileSync("assets/js/app.js", "utf8");
const INDEX_HTML = readFileSync("index.html", "utf8");
const APP_CSS = readFileSync("assets/css/app.css", "utf8");

check("畫面渲染不走 innerHTML／字串組 HTML", () => {
    const banned = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write\(/, /eval\(/, /new Function\(/];
    for (const file of SOURCE_FILES) {
        const text = readFileSync(file, "utf8");
        for (const pattern of banned) {
            assert.ok(!pattern.test(text), `${file} 出現 ${pattern}`);
        }
    }
});

check("沒有行內事件處理器（杜絕把資料插進 HTML 屬性）", () => {
    const inlineHandler = /\son(?:click|error|load|change|input|submit|mouseover)\s*=\s*["'`]/;
    assert.ok(!/\son[a-z]+\s*=\s*["'`]/i.test(INDEX_HTML.replace(/<script>[\s\S]*?<\/script>/g, "")), "index.html 有行內事件");
    assert.ok(!inlineHandler.test(APP_JS), "app.js 動態組了行內事件字串");
    assert.ok(!/setAttribute\(\s*["'`]on/i.test(APP_JS), "app.js 用 setAttribute 裝了事件");
});

check("app.js 取用的每個 id 都真的存在於 index.html", () => {
    const ids = new Set([...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const referenced = [...APP_JS.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
    assert.ok(referenced.length > 20, `只找到 ${referenced.length} 個 id 參照，解析可能失效`);
    const missing = [...new Set(referenced)].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `index.html 缺少：${missing.join(", ")}`);
});

check("引用到的本地資產都存在（圖片、CSS、JS）", () => {
    const referenced = new Set();
    for (const match of INDEX_HTML.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) referenced.add(match[1]);
    for (const match of APP_JS.matchAll(/"(\.\/assets\/[^"]+)"/g)) referenced.add(match[1].slice(2));
    for (const match of APP_CSS.matchAll(/url\("\.\.\/([^"]+)"\)/g)) referenced.add(`assets/${match[1]}`);
    for (const match of APP_JS.matchAll(/import\("(\.[^"]+)"\)/g)) referenced.add(`assets/js/${match[1].slice(2)}`);

    assert.ok(referenced.size >= 10, `只找到 ${referenced.size} 個資產引用`);
    for (const path of referenced) {
        assert.ok(existsSync(path), `找不到被引用的檔案：${path}`);
    }
});

check("assets/js 裡的相對匯入都指得到檔案", () => {
    for (const file of ["app.js", "avatar.js", "sanitize.js", "watermark.js", "screenmark.js"]) {
        const text = readFileSync(`assets/js/${file}`, "utf8");
        for (const match of text.matchAll(/from "\.\/([A-Za-z0-9_-]+)\.js"/g)) {
            assert.ok(existsSync(`assets/js/${match[1]}.js`), `${file} 匯入的 ${match[1]}.js 不存在`);
        }
    }
});

check("HTML 沒有夾帶 http:// 的明文外部資源", () => {
    assert.ok(!/(?:src|href)="http:\/\//.test(INDEX_HTML), "有 http:// 資源");
});

check("id 不重複，且 for／aria 參照的 id 都存在", () => {
    const ids = [...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], `重複的 id：${duplicates.join(", ")}`);

    const known = new Set(ids);
    const refs = [
        /* 前面要嘛是空白要嘛是引號，才不會把 data-count-for 之類的屬性算進來 */
        ...[...INDEX_HTML.matchAll(/[\s"']for="([^"]+)"/g)].map((match) => match[1]),
        ...[...INDEX_HTML.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)),
    ];
    const dangling = [...new Set(refs)].filter((id) => !known.has(id));
    assert.deepEqual(dangling, [], `指向不存在的 id：${dangling.join(", ")}`);
});

check("CSS 大括號成對（壞掉的樣式會讓整個外觀默默失效）", () => {
    for (const file of ["assets/css/app.css", "assets/css/tailwind.css"]) {
        const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const open = (text.match(/\{/g) ?? []).length;
        const close = (text.match(/\}/g) ?? []).length;
        assert.equal(open, close, `${file} 大括號不成對（{ ${open} 個、} ${close} 個）`);
    }
});

/* ---------- 頭像產生器 ---------- */
const { avatarPlan } = await import("../assets/js/avatar.js");

check("同一個名字永遠得到同一張臉", () => {
    assert.deepEqual(avatarPlan("mayo"), avatarPlan("mayo"));
    assert.notEqual(avatarPlan("mayo").seed, avatarPlan("mayonnaise").seed);
});

check("頭像只從名字推導，取值都在合法範圍", () => {
    for (const name of ["mayo", "匿名旅人", "a", "小明", "🙂"]) {
        const plan = avatarPlan(name);
        assert.ok(plan.shapeIndex >= 0 && plan.shapeIndex < 18, `${name} 形狀越界`);
        assert.ok(plan.expression >= 0 && plan.expression < 25, `${name} 表情越界`);
        assert.match(plan.bodyColor, /^#[0-9a-f]{6}$/i);
        assert.match(plan.eyeColor, /^#[0-9a-f]{6}$/i);
        assert.notEqual(plan.bodyColor, plan.eyeColor);
        assert.ok(Math.abs(plan.gaze.x) <= 1 && Math.abs(plan.gaze.y) <= 1);
    }
});

check("空名字有預設值，取首字為代表色塊字元", () => {
    assert.equal(avatarPlan("").label, "匿名");
    assert.equal(avatarPlan("").initial, "匿");
    assert.equal(avatarPlan("   ").label, "匿名");
    assert.equal(avatarPlan("小明").initial, "小");
});

/* ---------- grokbot 引擎 ---------- */
function stubCanvas() {
    const calls = [];
    const canvas = {
        width: 0,
        height: 0,
        clientWidth: 128,
        clientHeight: 128,
        style: {},
        setAttribute() {},
    };
    const context = new Proxy(
        { canvas, measureText: () => ({ width: 0 }) },
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                return (...args) => {
                    calls.push(`${String(prop)}(${args.length})`);
                };
            },
            set() {
                return true;
            },
        },
    );
    canvas.getContext = () => context;
    return { canvas, calls };
}

const { GrokBot, shapeNames, expressionIndexes, EXPRESSION_COUNT } = await import("../assets/js/vendor/grokbot.js");
{
    assert.equal(shapeNames.length, 18);
    assert.equal(EXPRESSION_COUNT, 25);
    assert.equal(expressionIndexes.length, 25);

    const { canvas, calls } = stubCanvas();
    let bot = null;
    try {
        bot = new GrokBot(canvas, {
            size: 128,
            shape: shapeNames[4],
            expression: 7,
            theme: { bodyColor: "#5b7fe5", eyeColor: "#fffdf7" },
            autoBlink: false,
            autoExpression: false,
            ariaLabel: "",
            random: () => 0.42,
        });
        bot.render();
    } finally {
        bot?.destroy();
    }
    assert.ok(calls.some((call) => call.startsWith("ellipse(")), "沒有畫到眼球弧線");
    assert.ok(calls.some((call) => call.startsWith("fill(")), "沒有填色");
    assert.ok(calls.some((call) => call.startsWith("clip(")), "沒有裁切身體輪廓（眼睛會溢出）");
    results.push("vendored grokbot 能畫出一格（樁 canvas）");
}

for (const label of results) console.log(`PASS  ${label}`);
console.log(`\n${results.length} 項檢查全部通過`);
