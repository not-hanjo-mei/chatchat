/* ==========================================================================
   端到端流程測試：node tools/e2e.mjs
   --------------------------------------------------------------------------
   在 jsdom 裡跑真正的 assets/js/app.js（把 Firebase 換成 tools/fb-stub.js），
   驗證「建立房間 → 送出訊息 → 離開 → 重新整理回房」整條路徑。

   為什麼需要它：靜態檢查抓不到「呼叫了不存在的 API」這類問題。
   這個測試當初就是為了抓到 `chatLimiter.allow()` 這個打字錯誤而寫的。

   需要一次性安裝：npm install（會裝 jsdom）
   ========================================================================== */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const workdir = mkdtempSync(join(tmpdir(), "chatchat-e2e-"));

const results = [];
function check(label, ok, extra = "") {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
}

/** 把 app.js 的匯入換成替身，打包成一個可以在 node 執行的檔案 */
function buildBundle(tag) {
    const source = readFileSync(join(repo, "assets/js/app.js"), "utf8")
        .replace(/"https:\/\/www\.gstatic\.com[^"]*firebase-app\.js"/, JSON.stringify(join(repo, "tools/fb-stub.js")))
        .replace(/"https:\/\/www\.gstatic\.com[^"]*firebase-database\.js"/, JSON.stringify(join(repo, "tools/fb-stub.js")))
        .replace(/from "\.\/sanitize\.js"/, `from ${JSON.stringify(join(repo, "assets/js/sanitize.js"))}`)
        .replace(/from "\.\/avatar\.js"/, `from ${JSON.stringify(join(repo, "assets/js/avatar.js"))}`);

    const entry = join(workdir, `entry-${tag}.js`);
    const outfile = join(workdir, `bundle-${tag}.mjs`);
    writeFileSync(entry, source);

    execFileSync(
        "npx",
        [
            "-y",
            "esbuild@0.25.10",
            entry,
            "--bundle",
            "--format=esm",
            "--platform=browser",
            /* 頭像引擎需要真的 canvas，jsdom 沒有，所以留給執行時失敗 →
               app.js 會退回底色圖，這也是要驗證的降級路徑。 */
            `--external:${join(repo, "assets/js/vendor/grokbot.js")}`,
            `--outfile=${outfile}`,
        ],
        { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
    );

    return outfile;
}

function setGlobal(name, value) {
    try {
        globalThis[name] = value;
    } catch {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
}

/** 建一個 jsdom 環境並載入 app.js 打包檔 */
async function boot({ tag, session = null, lastInput = null, avatar = null, alerts }) {
    const dom = new JSDOM(readFileSync(join(repo, "index.html"), "utf8"), {
        url: "http://localhost:8080/",
        pretendToBeVisual: true,
    });
    const { window } = dom;

    window.alert = (message) => alerts.push(String(message));
    window.confirm = () => true;
    window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    window.scrollTo = () => {};
    /* jsdom 沒有 2D context，直接回 null，省掉一堆 "Not implemented" 噪音 */
    window.HTMLCanvasElement.prototype.getContext = () => null;
    if (session) window.sessionStorage.setItem("chatchat-session", JSON.stringify(session));
    if (lastInput) window.localStorage.setItem("chatchat-last-input", JSON.stringify(lastInput));
    if (avatar) window.localStorage.setItem("chatchat-avatar", avatar);
    /* jsdom 不會載入圖片，補一個會立刻觸發 onload 的替身，讓上傳流程跑得完 */
    window.Image = class {
        set src(value) {
            this._src = value;
            setTimeout(() => this.onload?.(), 0);
        }

        get src() {
            return this._src;
        }
    };

    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("alert", window.alert);
    setGlobal("confirm", window.confirm);
    setGlobal("localStorage", window.localStorage);
    setGlobal("sessionStorage", window.sessionStorage);
    setGlobal("HTMLElement", window.HTMLElement);
    setGlobal("Node", window.Node);
    setGlobal("Event", window.Event);
    setGlobal("MouseEvent", window.MouseEvent);
    setGlobal("KeyboardEvent", window.KeyboardEvent);
    setGlobal("FileReader", window.FileReader);
    setGlobal("requestAnimationFrame", (callback) => setTimeout(() => callback(Date.now()), 0));
    setGlobal("cancelAnimationFrame", (id) => clearTimeout(id));
    setGlobal("crypto", {
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
        getRandomValues: (array) => array,
    });

    await import(buildBundle(tag));
    await flush();

    return window;
}

async function flush(rounds = 8) {
    for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const alerts = [];
const window = await boot({ tag: "fresh", alerts });
const document = window.document;
const $ = (id) => document.getElementById(id);
const visible = (id) => !$(id).classList.contains("is-hidden");
const click = (element) => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

/* ---------- 建立房間 ---------- */
$("room-id").value = "TESTROOM";
$("nickname").value = "tester";
click($("btn-create"));
await flush(14);

check("建立房間後進到聊天畫面", visible("chat-screen") && document.body.dataset.screen === "chat-screen");
check("進房過程沒有跳出錯誤", alerts.length === 0, JSON.stringify(alerts));

/* ---------- 記住上次的輸入 ---------- */
const remembered = JSON.parse(window.localStorage.getItem("chatchat-last-input") ?? "{}");
check("進房後記住房號與暱稱", remembered.roomId === "TESTROOM" && remembered.nickname === "tester",
    JSON.stringify(remembered));

/* ---------- 送出訊息：按鈕 ---------- */
$("message-input").value = "hello via button";
click($("btn-send"));
await flush(14);

const stub = globalThis.__fbStub;
const stored = Object.values(stub.__dump("rooms/TESTROOM/messages") ?? {});
check("訊息寫進資料庫", stored.some((message) => message.text === "hello via button"),
    JSON.stringify(stored).slice(0, 160));
check("訊息出現在畫面上", $("chat-messages").textContent.includes("hello via button"));
check("送出後輸入框清空", $("message-input").value === "");
check("沒有出現送出失敗提示", $("composer-notice").classList.contains("is-hidden"),
    $("composer-notice").textContent);

/* ---------- 送出訊息：Enter ---------- */
await new Promise((resolve) => setTimeout(resolve, 800)); // 等過最短送出間隔
$("message-input").value = "hello via enter";
$("message-input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await flush(14);

const stored2 = Object.values(stub.__dump("rooms/TESTROOM/messages") ?? {});
check("Enter 也能送出", stored2.some((message) => message.text === "hello via enter"), `共 ${stored2.length} 則`);

/* ---------- 頭像 ---------- */
check("頭像有產生（jsdom 沒有 canvas，會退回底色圖）",
    $("avatar-preview").src.startsWith("data:image/"), $("avatar-preview").src.slice(0, 28));

/* ---------- 退出 ---------- */
click($("btn-leave"));
await flush(14);
check("按退出回到大廳", visible("landing-screen") && document.body.dataset.screen === "landing-screen");
check("退出不會跳出假警報", alerts.length === 0, JSON.stringify(alerts));

/* ---------- 重新整理後自動回房 ----------
   這一步會換掉全域 window／document，所以要放在最後：
   上一個實例還活著，但它之後只會被拿來當對照。 */
const reloadAlerts = [];
const reloaded = await boot({
    tag: "reload",
    session: { roomId: "TESTROOM", nickname: "tester" },
    lastInput: { roomId: "OLDROOM", nickname: "old-name" },
    alerts: reloadAlerts,
});
await flush(14);

check("重新整理後自動回到同一間房",
    !reloaded.document.getElementById("chat-screen").classList.contains("is-hidden") &&
    reloaded.document.body.dataset.screen === "chat-screen",
    `screen=${reloaded.document.body.dataset.screen}`);
check("自動回房沒有跳出錯誤", reloadAlerts.length === 0, JSON.stringify(reloadAlerts));
check("回房後成員名單裡有自己",
    reloaded.document.getElementById("members-list").textContent.includes("tester"),
    JSON.stringify(reloaded.document.getElementById("members-list").textContent.slice(0, 60)));

/* ---------- 只記住輸入、不自動進房 ---------- */
const prefillAlerts = [];
const prefilled = await boot({
    tag: "prefill",
    lastInput: { roomId: "OLDROOM", nickname: "old-name" },
    alerts: prefillAlerts,
});
await flush(8);
const prefillDoc = prefilled.document;
check("新開一次會填回上次的房號與暱稱",
    prefillDoc.getElementById("room-id").value === "OLDROOM" &&
    prefillDoc.getElementById("nickname").value === "old-name",
    `${prefillDoc.getElementById("room-id").value} / ${prefillDoc.getElementById("nickname").value}`);
check("只有記住輸入不會自動進房", prefillDoc.body.dataset.screen === "landing-screen",
    `screen=${prefillDoc.body.dataset.screen}`);
check("暱稱填回後頭像也跟著算", prefillDoc.getElementById("avatar-preview").src.startsWith("data:image/"));

/* ---------- 頭像記住 / 清除 ---------- */
const AVATAR_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const avatarAlerts = [];
const avatarWindow = await boot({
    tag: "avatar",
    lastInput: { roomId: "OLDROOM", nickname: "old-name" },
    avatar: AVATAR_PNG,
    alerts: avatarAlerts,
});
await flush(8);
const avatarDoc = avatarWindow.document;

check("開站時會用記住的頭像",
    avatarDoc.getElementById("avatar-preview").src === AVATAR_PNG,
    avatarDoc.getElementById("avatar-preview").src.slice(0, 32));
check("有自訂頭像時顯示「用名字產生」",
    !avatarDoc.getElementById("btn-clear-avatar").classList.contains("is-hidden"));

click(avatarDoc.getElementById("btn-clear-avatar"));
await flush(8);
check("按「用名字產生」會忘記頭像",
    avatarWindow.localStorage.getItem("chatchat-avatar") === null &&
    avatarDoc.getElementById("avatar-preview").src.startsWith("data:image/svg+xml"),
    avatarDoc.getElementById("avatar-preview").src.slice(0, 28));
check("清除後按鈕自己收起來",
    avatarDoc.getElementById("btn-clear-avatar").classList.contains("is-hidden"));

const avatarFile = new avatarWindow.File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
const avatarInput = avatarDoc.getElementById("avatar-input");
Object.defineProperty(avatarInput, "files", { value: [avatarFile], configurable: true });
avatarInput.dispatchEvent(new avatarWindow.Event("change", { bubbles: true }));
await flush(14);
check("選了新頭像會記在裝置上",
    (avatarWindow.localStorage.getItem("chatchat-avatar") ?? "").startsWith("data:image/"),
    (avatarWindow.localStorage.getItem("chatchat-avatar") ?? "").slice(0, 28));

/* ---------- 星點點擊 ----------
   注意：jsdom 沒有版面引擎，getBoundingClientRect() 一律是 0，
   所以這裡驗證的是「事件流程」——點在星點附近會走最鄰近星點那條路、
   點星球不會誤開心事。幾何計算本身在瀏覽器才看得出效果。 */
const starAlerts = [];
const universeWindow = await boot({
    tag: "stars",
    session: { roomId: "TESTROOM", nickname: "tester" },
    alerts: starAlerts,
});
const { ref: stubRef, set: stubSet } = await import(join(repo, "tools/fb-stub.js"));
await stubSet(stubRef(null, "universe/posts/post-1"), {
    emotion: "happy",
    name: "someone",
    text: "這是一則心事",
    timestamp: Date.now(),
    offsetX: 3,
    offsetY: 2,
});
await flush(4);

const sky = universeWindow.document;
click(sky.getElementById("btn-enter-universe"));
await flush(14);
check("宇宙裡畫得出星點", Boolean(sky.querySelector("#stars-container .star")));

const readModal = sky.getElementById("universe-read-modal");
const postModal = sky.getElementById("universe-post-modal");
sky.getElementById("stars-container").dispatchEvent(
    new universeWindow.MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }),
);
await flush(6);
check("點星點附近就會開啟心事", !readModal.classList.contains("is-hidden"));
check("開啟的是正確的心事內容", sky.getElementById("u-read-text").textContent === "這是一則心事",
    JSON.stringify(sky.getElementById("u-read-text").textContent));

/* 關掉後改點星球，應該分享心事而不是開啟閱讀 */
click(sky.querySelector("[data-close-universe]"));
await flush(6);
click(sky.querySelector("#planets-container .planet"));
await flush(6);
check("點星球是分享心事，不會誤開閱讀視窗",
    !postModal.classList.contains("is-hidden") && readModal.classList.contains("is-hidden"));

/* ---------- 心情清單 ---------- */
click(sky.querySelector("[data-close-universe]"));
await flush(6);
click(sky.querySelector('[data-emotion="happy"]'));
await flush(8);

const listModal = sky.getElementById("universe-list-modal");
check("點心情會開出心事清單", !listModal.classList.contains("is-hidden"));
check("清單裡有那則心事", sky.getElementById("u-list-items").textContent.includes("這是一則心事"),
    JSON.stringify(sky.getElementById("u-list-items").textContent.slice(0, 60)));
check("心情列有顯示顆數", sky.querySelector('[data-count-for="happy"]').textContent.includes("1"),
    JSON.stringify(sky.querySelector('[data-count-for="happy"]').textContent));

click(sky.querySelector("#u-list-items .list-item"));
await flush(8);
check("點清單項目會開啟那則心事",
    !readModal.classList.contains("is-hidden") && listModal.classList.contains("is-hidden"));

/* 沒有心事的類別要顯示空狀態 */
click(sky.querySelector("[data-close-universe]"));
await flush(6);
click(sky.querySelector('[data-emotion="angry"]'));
await flush(8);
check("沒有心事的心情顯示空狀態",
    !listModal.classList.contains("is-hidden") &&
    sky.getElementById("u-list-items").textContent.includes("還沒有星點"),
    JSON.stringify(sky.getElementById("u-list-items").textContent.slice(0, 40)));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed === 0 ? 0 : 1);
