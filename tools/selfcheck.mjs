/* 自我檢查：node tools/selfcheck.mjs
   驗證輸入淨化的行為，以及 vendored 的 grokbot 引擎能不能正常畫出一格。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { pageMarkImage, MARK_ALPHA } from "../assets/js/watermark.js";
import {
    cleanName,
    cleanText,
    createRateLimiter,
    deviceModel,
    escapeXml,
    formatRateLimitNotice,
    isValidRoomId,
    isValidUserId,
    makeRoomCode,
    safeEmoji,
    safeImageSrc,
    safeIp,
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

/* ---------- 頁面標記（整頁平鋪的明文小字） ---------- */
/* 標記是純字串，不依賴 DOM 或 canvas，所以直接驗字串內容。 */
const MARK_URL = /^url\("data:image\/svg\+xml,/;

function markSvg(text, ink) {
    const image = pageMarkImage(text, ink);
    assert.match(image, MARK_URL, "標記圖不是 SVG data URL");
    return decodeURIComponent(image.replace(MARK_URL, "").replace(/"\)$/, ""));
}

function markRows(text, ink) {
    return [...markSvg(text, ink).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
}

check("標記是看得懂的明文：暱稱、房號、機型、IP 各一行", () => {
    assert.deepEqual(markRows("小美\nABC123\nSM-G991B\n192.0.2.17"),
        ["小美", "ABC123", "SM-G991B", "192.0.2.17"]);
    assert.deepEqual(markRows("小美\n\nSM-G991B"), ["小美", "SM-G991B"]);
    assert.deepEqual(markRows("小美"), ["小美"]);
    assert.deepEqual(markRows("\n\n"), ["unknown"]);
});

check("機型從 user agent 抓得出來，抓不到就說平台名", () => {
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A) Chrome/120"), "SM-G991B");
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 12; V2166A; wv) Chrome/120"), "V2166A");
    assert.equal(deviceModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone");
    assert.equal(deviceModel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"), "Windows");
    assert.equal(deviceModel(""), "unknown");
    assert.equal(deviceModel(undefined), "unknown");
    /* Chrome 110 之後 Android 的 UA 被縮減成「Android 10; K」，只能靠 Client Hints 補回來 */
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120"), "K");
    assert.equal(deviceModel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120", "SM-S911B"), "SM-S911B");
    assert.equal(deviceModel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "  "), "iPhone");
});

check("公網 IP 只接受長得像 IP 的回應", () => {
    assert.equal(safeIp("192.0.2.17"), "192.0.2.17");
    assert.equal(safeIp(" 2001:0db8:85a3::8a2e:0370:7334 "), "2001:0db8:85a3::8a2e:0370:7334");
    assert.equal(safeIp("1.2.3.4.5"), "");
    assert.equal(safeIp("</text><script>alert(1)</script>"), "");
    assert.equal(safeIp(""), "");
    assert.equal(safeIp(undefined), "");
});

check("標記透明到看不出來，而且是斜的平鋪磚", () => {
    const svg = markSvg("小美\nABC123", "#fff");
    assert.match(svg, /rotate\(-20 160 140\)/, "沒有斜向平鋪");
    assert.match(svg, new RegExp(`fill-opacity="${MARK_ALPHA}"`));
    /* 8 bits 的下限：比 1 階還小就四捨五入回原色，標記不是變淡而是整片消失 */
    assert.ok(MARK_ALPHA >= 0.002 && MARK_ALPHA <= 0.02, `透明度 ${MARK_ALPHA} 不在可用範圍`);
    /* 字越大越粗墨跡越多就越明顯，所以守住上限（目前 20px / 粗體，範圍內可調） */
    assert.match(svg, /font-size="(?:1[6-9]|2[0-4])"/, "字級超出可用範圍");
    assert.doesNotMatch(svg, /font-weight="(?:[89]00|900)"/, "字重超出可用範圍");
});

check("一行最多 24 個半形寬度，全形字算兩個", () => {
    const rows = markRows("一二三四五六七八九十十一十二十三");
    assert.equal(rows[0], "一二三四五六七八九十十一");
    assert.equal(rows[0].length, 12);
    /* 半形字串要完整塞得進去，不能被前面的全形規則誤殺（IPv4 最長 15 個半形寬度） */
    assert.deepEqual(markRows("abcdefghijklmno"), ["abcdefghijklmno"]);
});

check("標記最多四行、清掉控制字元、跳脫 XML", () => {
    assert.deepEqual(markRows("a\n\nb"), ["a", "b"]);
    assert.deepEqual(markRows("a & <b>\n房號"), ["a &amp; &lt;b&gt;", "房號"]);
    assert.equal(markRows("\u0007房號")[0].includes("\u0007"), false);
    assert.deepEqual(markRows("一\n二\n三\n四\n五"), ["一", "二", "三", "四"]);
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
const SOURCE_FILES = ["index.html", "assets/js/app.js", "assets/js/avatar.js", "assets/js/sanitize.js", "assets/js/watermark.js"];
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
    for (const file of ["app.js", "avatar.js", "sanitize.js", "watermark.js"]) {
        const text = readFileSync(`assets/js/${file}`, "utf8");
        for (const match of text.matchAll(/from "\.\/([A-Za-z0-9_-]+)\.js"/g)) {
            assert.ok(existsSync(`assets/js/${match[1]}.js`), `${file} 匯入的 ${match[1]}.js 不存在`);
        }
    }
});

check("HTML 沒有夾帶 http:// 的明文外部資源", () => {
    assert.ok(!/(?:src|href)="http:\/\//.test(INDEX_HTML), "有 http:// 資源");
});

check("標記層蓋滿畫面、不擋點擊、而且跟著主題換字色", () => {
    assert.match(APP_CSS, /#mark-layer\s*\{[^}]*position:\s*fixed/, "標記層沒有蓋滿畫面");
    assert.match(APP_CSS, /#mark-layer\s*\{[^}]*z-index:\s*9999/, "標記層會被彈窗蓋掉");
    assert.match(APP_CSS, /#mark-layer\s*\{[^}]*pointer-events:\s*none/, "標記層會擋住點擊");
    assert.match(APP_CSS, /#mark-layer\s*\{[^}]*background-image:\s*var\(--mark-image-light\)/);
    assert.match(APP_CSS, /\[data-theme="dark"\]\s*#mark-layer\s*\{[^}]*var\(--mark-image-dark\)/, "暗色主題沒有換字色");
});

check("舊的圖片盲水印與文字隱形標記都清乾淨了", () => {
    const WATERMARK_JS = readFileSync("assets/js/watermark.js", "utf8");
    for (const name of ["embedImageWatermark", "extractImageWatermark", "embedTextMark", "extractTextMark", "markPayload"]) {
        assert.ok(!APP_JS.includes(name), `app.js 還有 ${name}`);
        assert.ok(!WATERMARK_JS.includes(name), `watermark.js 還有 ${name}`);
    }
    assert.ok(!/[\u200b\u200c\u200d\u2060]/.test(APP_JS), "app.js 還有零寬字元");
    assert.ok(!existsSync("assets/js/device.js"), "device.js 還在");
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
