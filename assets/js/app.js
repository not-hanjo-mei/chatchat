/* ==========================================================================
   ChatChat & 心情宇宙 - 應用邏輯
   --------------------------------------------------------------------------
   安全原則（改動前請先讀）：
   1. 所有來自資料庫或使用者輸入的字串，一律用 textContent 或 DOM API 放入
      畫面。這個檔案沒有 innerHTML、沒有字串組 HTML、沒有把資料插進
      onclick 屬性；事件一律用 addEventListener。
   2. 圖片來源一律走 safeImageSrc()：只允許 data:image/* 與 https。
   3. 寫回資料庫前先過 cleanText()/cleanName() 並限制長度，避免單筆資料
      塞爆節點。
   4. 資料庫規則修好之前，前端只是降低風險，不是防護。詳見 SECURITY.md。
   ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
    getDatabase,
    ref,
    set,
    push,
    onValue,
    onChildAdded,
    onChildChanged,
    onDisconnect,
    remove,
    get,
    query,
    orderByChild,
    limitToLast,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

import { applyAvatar } from "./avatar.js";
import { pageMarkImage } from "./watermark.js";
import {
    cleanName,
    cleanText,
    deviceModel,
    formatRateLimitNotice,
    formatTime,
    isValidRoomId,
    isValidUserId,
    makeRoomCode,
    safeEmoji,
    safeImageSrc,
    safeIp,
    safeTimestamp,
    createRateLimiter,
    MAX_MESSAGE,
    MAX_POST,
    MAX_REPLY,
    MAX_IMAGE_CHARS,
} from "./sanitize.js";

/* ================= Firebase =================
   apiKey 不是秘密（它只識別專案），但資料庫規則是。規則修好之前，任何拿到
   這個網址的人都能讀寫所有房間，詳見 SECURITY.md。 */
const firebaseConfig = {
    apiKey: "AIzaSyAR8ij9OjrePtf6heoMghCcp7JVu_L5z6U",
    authDomain: "chat-f46da.firebaseapp.com",
    databaseURL: "https://chat-f46da-default-rtdb.firebaseio.com",
    projectId: "chat-f46da",
    storageBucket: "chat-f46da.firebasestorage.app",
    messagingSenderId: "148711107012",
    appId: "1:148711107012:web:676fdcea4bcb62f1225c91",
};
const db = getDatabase(initializeApp(firebaseConfig));

/* ================= 常數 ================= */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1280;
const AVATAR_SIDE = 256;
const UNIVERSE_POST_LIMIT = 300;
/* 星點相對星球的位移上限（vh／vw）。舊資料可能帶著更大的值，渲染時夾住，
   否則會有星點落在畫面外，看得到卻點不到。 */
const MAX_STAR_OFFSET = 11;
/* 手指的半徑大約就是這麼大：離星點 44px 內都算點它 */
const STAR_TAP_RADIUS = 44;
/* 星點彼此、以及星點與星球之間的最小距離，避免疊在一起點錯 */
const STAR_MIN_GAP = 44;
const STAR_HALF = 6;
const PLANET_CLEARANCE = 58;
const SCREENS = ["landing-screen", "setup-screen", "chat-screen", "universe-screen"];
/* 重新整理後自動回到同一間房。刻意用 sessionStorage：只跟著這個分頁，
   所以另開一個分頁測試另一個使用者時不會被自動帶進同一間房。 */
const SESSION_KEY = "chatchat-session";
/* 上一次填過的房號與暱稱。跟 SESSION_KEY 不同：這個是跨分頁、跨次開站的，
   目的只是省下重新輸入，不會自動把人帶進房間。 */
const LAST_INPUT_KEY = "chatchat-last-input";
/* 自訂頭像也記在這台裝置上。壓縮後通常只有幾十 KB，但 localStorage 有
   5MB 左右的配額，所以超過上限就不存（功能不受影響，只是下次要重選）。 */
const AVATAR_KEY = "chatchat-avatar";
const AVATAR_STORE_LIMIT = 400000;
const MAX_REJOIN_TRIES = 3;

/* 星球素材是專案內的固定檔案，不來自使用者，因此直接使用路徑。
   座標是以星球中心點的百分比（見 .planet 的 translate(-50%, -50%)）：
   上下各留一段安全帶，避開行動裝置的瀏覽器工具列與宇宙說明面板。 */
const PLANETS = {
    happy: { name: "開心", img: "./assets/img/happy.webp", color: "#fde047", top: 16, left: 28 },
    bored: { name: "無聊", img: "./assets/img/bored.webp", color: "#9ca3af", top: 16, left: 72 },
    angry: { name: "憤怒", img: "./assets/img/angry.webp", color: "#ef4444", top: 39, left: 22 },
    crush: { name: "心動", img: "./assets/img/touching.webp", color: "#f472b6", top: 39, left: 78 },
    sad: { name: "難過", img: "./assets/img/sad.webp", color: "#60a5fa", top: 62, left: 28 },
    other: { name: "其他", img: "./assets/img/other.webp", color: "#ffffff", top: 62, left: 72 },
};

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);

const el = {
    body: document.body,
    chat: $("chat-screen"),
    universe: $("universe-screen"),
    roomIdInput: $("room-id"),
    nicknameInput: $("nickname"),
    avatarInput: $("avatar-input"),
    btnClearAvatar: $("btn-clear-avatar"),
    avatarPreview: $("avatar-preview"),
    btnCreate: $("btn-create"),
    btnJoin: $("btn-join"),
    btnRandomRoom: $("btn-random-room"),
    heroAvatar: $("hero-avatar"),
    btnTheme: $("btn-theme"),
    btnThemeInline: $("btn-theme-inline"),
    themeLabel: $("theme-label"),
    displayRoomId: $("display-room-id"),
    sidebarPanel: $("mobile-sidebar-content"),
    btnMenu: $("btn-menu"),
    btnPickBg: $("btn-pick-bg"),
    bgInput: $("bg-input"),
    membersList: $("members-list"),
    btnLeave: $("btn-leave"),
    btnLeavePanel: $("btn-leave-panel"),
    btnDisband: $("btn-disband"),
    chatMessages: $("chat-messages"),
    replyPreview: $("reply-preview"),
    replyToName: $("reply-to-name"),
    btnCancelReply: $("btn-cancel-reply"),
    btnPickImage: $("btn-pick-image"),
    chatImgInput: $("chat-img-input"),
    messageInput: $("message-input"),
    btnSend: $("btn-send"),
    composerNotice: $("composer-notice"),
    starMenu: $("star-menu"),
    btnReply: $("btn-reply"),
    planetsContainer: $("planets-container"),
    starsContainer: $("stars-container"),
    postModal: $("universe-post-modal"),
    postTitle: $("u-post-title"),
    postText: $("u-post-text"),
    postNickname: $("u-post-nickname"),
    btnPostSubmit: $("btn-u-submit"),
    listModal: $("universe-list-modal"),
    listTitle: $("u-list-title"),
    listItems: $("u-list-items"),
    readModal: $("universe-read-modal"),
    readAvatar: $("u-read-avatar"),
    readName: $("u-read-name"),
    readTime: $("u-read-time"),
    readText: $("u-read-text"),
    repliesList: $("u-replies-list"),
    replyInput: $("u-reply-input"),
    btnReplySubmit: $("btn-u-reply"),
    legend: $("legend"),
    btnLegend: $("btn-legend"),
};

/* ================= 狀態 ================= */
const state = {
    userId: createUserId(),
    nickname: "",
    /* 空字串＝沒有自訂頭像，改由名字產生 GrokBot 頭像 */
    avatar: "",
    roomId: null,
    isHost: false,
    hostId: null,
    members: {},
    messages: new Map(),
    selectedMsgId: null,
    replyingTo: null,
    unsubscribe: [],
    membershipConfirmed: false,
    rejoinTries: 0,
    /* 房間是否還開著。離開後所有排隊中的監聽回呼都要變成 no-op，
       否則「移除自己」會再觸發一次成員變更，把人再次踢出房間。 */
    active: false,
    universeReady: false,
    lastPosts: {},
    targetEmotion: null,
    readingPostId: null,
    readingEmotion: null,
};

/* createRateLimiter 回傳的就是 allow 函式本身，直接呼叫它（不是 .allow()） */
const chatRateLimit = createRateLimiter({ windowMs: 60000, max: 20, minGapMs: 700 });
const universeRateLimit = createRateLimiter({ windowMs: 60000, max: 10, minGapMs: 1500 });

let starMenuTimer = null;
/* 已經佔用掉的座標（px），用來讓星點互相避開 */
let placedPoints = [];

function createUserId() {
    const raw = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `user_${raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
}

/* ================= 小工具 ================= */
function showNotice(text) {
    el.composerNotice.textContent = text;
    setHidden(el.composerNotice, !text);
}

/** 警語一律用 textContent，避免把暱稱之類的資料當成 HTML 解析 */
function warn(title, detail) {
    window.alert(detail ? `${title}\n${detail}` : title);
}

function setHidden(node, hidden) {
    node.classList.toggle("is-hidden", hidden);
}

function replayEnterAnimation(node) {
    node.classList.remove("modal-enter");
    void node.offsetWidth;
    node.classList.add("modal-enter");
}

/** 資料庫卡住時（斷網、被防火牆擋）不要讓按鈕永遠不回話 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label}逾時，請確認網路後再試一次`)), ms);
        }),
    ]);
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

/** 把星點位移夾在安全範圍內，避免星點跑到畫面外 */
function clampOffset(value) {
    if (!isFiniteNumber(value)) return 0;
    return Math.max(-MAX_STAR_OFFSET, Math.min(MAX_STAR_OFFSET, value));
}

function toggleMenu(open) {
    setHidden(el.sidebarPanel, !open);
    el.btnMenu.setAttribute("aria-expanded", String(open));
}

/* ================= 佈景主題 ================= */
const THEME_KEY = "chatchat-theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_ICON = { system: "◐", light: "☀", dark: "☾" };
const THEME_TEXT = { system: "跟隨系統", light: "亮色", dark: "暗色" };

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function readThemePreference() {
    const stored = document.documentElement.dataset.themePreference;
    return THEME_ORDER.includes(stored) ? stored : "system";
}

function setThemeControls(preference) {
    for (const button of [el.btnTheme, el.btnThemeInline]) {
        const icon = button.querySelector('span[aria-hidden="true"]');
        if (icon) icon.textContent = THEME_ICON[preference];
        button.setAttribute("aria-label", `佈景主題：${THEME_TEXT[preference]}（點一下切換）`);
    }
    el.themeLabel.textContent = THEME_TEXT[preference];
}

function applyTheme(preference) {
    const resolved = preference === "system" ? (darkQuery.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    try {
        window.localStorage.setItem(THEME_KEY, preference);
    } catch (error) {
        console.warn("無法記住佈景主題偏好：", error.message);
    }
    setThemeControls(preference);
}

function cycleTheme() {
    const next = (THEME_ORDER.indexOf(readThemePreference()) + 1) % THEME_ORDER.length;
    applyTheme(THEME_ORDER[next]);
}

function followSystemTheme() {
    if (readThemePreference() === "system") applyTheme("system");
}

el.btnTheme.addEventListener("click", cycleTheme);
el.btnThemeInline.addEventListener("click", cycleTheme);

if (typeof darkQuery.addEventListener === "function") darkQuery.addEventListener("change", followSystemTheme);
else if (typeof darkQuery.addListener === "function") darkQuery.addListener(followSystemTheme);

setThemeControls(readThemePreference());

/* ================= 畫面切換 ================= */
function switchScreen(screenId) {
    for (const id of SCREENS) setHidden($(id), id !== screenId);
    el.body.dataset.screen = screenId;
    /* 換畫面後輸入框才量得到高度，這時才能把自動長高算對 */
    autoResizeAll();
    if (screenId !== "chat-screen") toggleMenu(false);
    refreshPageMark();
}

for (const button of document.querySelectorAll("[data-goto]")) {
    button.addEventListener("click", () => switchScreen(button.dataset.goto));
}

/* ================= 圖片處理 ================= */
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("讀取檔案失敗"));
        reader.readAsDataURL(file);
    });
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("圖片解碼失敗"));
        image.src = dataUrl;
    });
}

/*
 * 縮圖並轉成 WebP，避免 base64 把資料庫撐肥。
 * 若瀏覽器無法解碼（例如部分瀏覽器讀不了 iPhone 的 HEIC），就退回原始檔，
 * 最後再檢查長度上限。
 */
async function prepareImage(file, maxSide) {
    if (!file || !file.type.startsWith("image/")) throw new Error("只接受圖片檔案");
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("圖片請小於 2MB");

    const original = await readFileAsDataUrl(file);
    let output = original;

    try {
        const image = await loadImage(original);
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (context) {
            context.drawImage(image, 0, 0, width, height);
            const compressed = canvas.toDataURL("image/webp", 0.82);
            if (compressed.startsWith("data:image/webp") && compressed.length < original.length) {
                output = compressed;
            }
        }
    } catch (error) {
        console.warn("圖片壓縮失敗，改用原始檔：", error.message);
    }

    if (output.length > MAX_IMAGE_CHARS) throw new Error("圖片壓縮後仍過大，請換小一點的圖");
    return output;
}

async function handleImagePick(input, maxSide, onReady) {
    const file = input.files?.[0];
    if (!file) return;
    try {
        onReady(await prepareImage(file, maxSide));
    } catch (error) {
        warn("圖片無法使用", error.message);
    } finally {
        input.value = "";
    }
}

/* ================= 房間工作階段（重新整理不掉出房間） ================= */
function saveSession() {
    try {
        window.sessionStorage.setItem(
            SESSION_KEY,
            JSON.stringify({ roomId: state.roomId, nickname: state.nickname }),
        );
    } catch (error) {
        console.warn("無法記住房間狀態：", error.message);
    }
}

function readSession() {
    try {
        const raw = window.sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !isValidRoomId(parsed.roomId)) return null;
        return { roomId: parsed.roomId, nickname: cleanName(parsed.nickname) || "匿名" };
    } catch (error) {
        console.warn("讀取房間狀態失敗：", error.message);
        return null;
    }
}

function readStoredAvatar() {
    try {
        return safeImageSrc(window.localStorage.getItem(AVATAR_KEY) ?? "");
    } catch (error) {
        console.warn("讀取記住的頭像失敗：", error.message);
        return "";
    }
}

function rememberAvatar() {
    try {
        if (!state.avatar) {
            window.localStorage.removeItem(AVATAR_KEY);
        } else if (state.avatar.length <= AVATAR_STORE_LIMIT) {
            window.localStorage.setItem(AVATAR_KEY, state.avatar);
        } else {
            console.warn("頭像太大，這次不記住（上限約 400KB 的 base64）");
        }
    } catch (error) {
        console.warn("無法記住頭像：", error.message);
    }
}

/** 有自訂頭像時才顯示「用名字產生」 */
function syncAvatarControls() {
    setHidden(el.btnClearAvatar, !state.avatar);
}

function readLastInput() {
    try {
        const raw = window.localStorage.getItem(LAST_INPUT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
            roomId: isValidRoomId(parsed?.roomId) ? parsed.roomId : "",
            nickname: cleanName(parsed?.nickname),
        };
    } catch (error) {
        console.warn("讀取上次的輸入失敗：", error.message);
        return null;
    }
}

/** 記住目前輸入框裡的內容，下次開站直接填回來 */
function rememberLastInput() {
    const roomId = state.roomId ?? el.roomIdInput.value.trim();
    const nickname = state.nickname || cleanName(el.nicknameInput.value);
    const payload = {};
    if (isValidRoomId(roomId)) payload.roomId = roomId;
    if (nickname) payload.nickname = nickname;

    try {
        window.localStorage.setItem(LAST_INPUT_KEY, JSON.stringify(payload));
    } catch (error) {
        console.warn("無法記住輸入內容：", error.message);
    }
}

/** 開站時把上次的輸入填回欄位（已經有值就不覆蓋） */
function prefillInputs() {
    const last = readLastInput();
    if (!last) return;
    if (!el.roomIdInput.value && last.roomId) el.roomIdInput.value = last.roomId;
    if (!el.nicknameInput.value && last.nickname) el.nicknameInput.value = last.nickname;
}

function clearSession() {
    try {
        window.sessionStorage.removeItem(SESSION_KEY);
    } catch (error) {
        console.warn("清除房間狀態失敗：", error.message);
    }
}

/* ================= 建立／加入房間 ================= */
el.btnRandomRoom.addEventListener("click", () => {
    el.roomIdInput.value = makeRoomCode();
});

el.avatarInput.addEventListener("change", () => {
    handleImagePick(el.avatarInput, AVATAR_SIDE, (dataUrl) => {
        state.avatar = dataUrl;
        rememberAvatar();
        syncAvatarControls();
        setHidden(el.avatarPreview, false);
        applyAvatar(el.avatarPreview, el.nicknameInput.value, state.avatar, AVATAR_SIDE);
    });
});

/* 回到用名字產生的頭像 */
el.btnClearAvatar.addEventListener("click", () => {
    state.avatar = "";
    rememberAvatar();
    syncAvatarControls();
    el.avatarInput.value = "";
    applyAvatar(el.avatarPreview, el.nicknameInput.value, state.avatar, AVATAR_SIDE);
});

/* 欄位失焦就記住內容，這樣沒進房也留著下次用 */
el.nicknameInput.addEventListener("change", rememberLastInput);
el.roomIdInput.addEventListener("change", rememberLastInput);

/* 暱稱一改就換一張對應的頭像，讓使用者知道名字決定臉 */
el.nicknameInput.addEventListener("input", () => {
    setHidden(el.avatarPreview, false);
    applyAvatar(el.avatarPreview, el.nicknameInput.value, state.avatar, AVATAR_SIDE);
});

el.bgInput.addEventListener("change", () => {
    handleImagePick(el.bgInput, MAX_IMAGE_SIDE, (dataUrl) => {
        el.chat.style.backgroundImage = `url(${dataUrl})`;
        el.chat.style.backgroundSize = "cover";
        el.chat.style.backgroundPosition = "center";
    });
});

el.btnCreate.addEventListener("click", () => enterRoom(true));
el.btnJoin.addEventListener("click", () => enterRoom(false));

async function enterRoom(isCreate) {
    const roomId = el.roomIdInput.value.trim();
    if (!isValidRoomId(roomId)) {
        return warn("房號格式不對", "只接受英數、- 與 _，最長 32 字元。");
    }

    state.nickname = cleanName(el.nicknameInput.value) || "匿名";
    el.nicknameInput.value = state.nickname;

    const busy = [el.btnCreate, el.btnJoin];
    for (const button of busy) button.disabled = true;

    try {
        const snapshot = await withTimeout(get(ref(db, `rooms/${roomId}`)), 12000, "讀取房間");
        if (isCreate && snapshot.exists()) return warn("房間已存在", "請改用「加入」，或換一個房號。");
        if (!isCreate && !snapshot.exists()) return warn("找不到房間", "請確認房號是否正確。");

        await joinRoom(roomId, isCreate);
    } catch (error) {
        state.roomId = null;
        console.warn("進入房間失敗：", error.message);
        warn("無法進入房間", "請確認網路後再試一次。");
    } finally {
        for (const button of busy) button.disabled = false;
    }
}

/** 把自己寫進成員名單、開始監聽、切到聊天畫面 */
async function joinRoom(roomId, isCreate) {
    state.roomId = roomId;
    state.membershipConfirmed = false;
    state.rejoinTries = 0;

    if (isCreate) await withTimeout(set(ref(db, `rooms/${roomId}/host`), state.userId), 12000, "建立房間");

    const myRef = ref(db, `rooms/${roomId}/members/${state.userId}`);
    await withTimeout(
        set(myRef, { name: state.nickname, avatar: state.avatar, joinedAt: Date.now() }),
        12000,
        "加入房間",
    );
    onDisconnect(myRef).remove().catch((error) => {
        console.warn("註冊離開時自動移除失敗（仍可手動退出）：", error.message);
    });

    saveSession();
    rememberLastInput();
    el.displayRoomId.textContent = roomId;
    switchScreen("chat-screen");
    setupChatListeners();
}

/**
 * 重新整理後自動回房。
 * 重新整理時舊連線的 onDisconnect 會稍後才把成員節點刪掉，可能比我們重新寫入
 * 還晚抵達，所以成員名單第一次看不到自己時要重試，而不是直接把人踢出去。
 */
async function restoreSession() {
    const saved = readSession();
    if (!saved) return;

    el.roomIdInput.value = saved.roomId;
    el.nicknameInput.value = saved.nickname;
    state.nickname = saved.nickname;

    try {
        const snapshot = await withTimeout(get(ref(db, `rooms/${saved.roomId}`)), 12000, "檢查房間");
        if (!snapshot.exists()) {
            clearSession();
            return;
        }
        await joinRoom(saved.roomId, false);
    } catch (error) {
        console.warn("自動回房失敗：", error.message);
        clearSession();
        state.roomId = null;
    }
}

/* ================= 房間監聽 ================= */
function setupChatListeners() {
    teardown();

    const roomId = state.roomId;
    const stillHere = () => state.active && state.roomId === roomId;

    state.active = true;

    state.unsubscribe.push(
        onValue(ref(db, `rooms/${roomId}/members`), (snapshot) => {
            if (!stillHere()) return;
            const members = snapshot.val();
            if (!members) return leaveRoom("房間已被解散。");

            if (!members[state.userId]) {
                /* 剛進房（含重新整理自動回房）時，可能被上一條連線的
                   onDisconnect 搶先刪掉，重試幾次再判斷是真的被踢。 */
                if (!state.membershipConfirmed && state.rejoinTries < MAX_REJOIN_TRIES) {
                    state.rejoinTries += 1;
                    const myRef = ref(db, `rooms/${roomId}/members/${state.userId}`);
                    setTimeout(() => {
                        if (!stillHere()) return;
                        set(myRef, { name: state.nickname, avatar: state.avatar, joinedAt: Date.now() }).catch(
                            (error) => console.warn("重新寫入成員失敗：", error.message),
                        );
                    }, 1200);
                    return;
                }
                return leaveRoom("你已被移出房間。");
            }

            state.membershipConfirmed = true;
            state.members = members;
            void syncRoomState();
        }),
    );

    state.unsubscribe.push(
        onValue(ref(db, `rooms/${roomId}/host`), (snapshot) => {
            if (!stillHere()) return;
            state.hostId = snapshot.val();
            void syncRoomState();
        }),
    );

    state.unsubscribe.push(
        onChildAdded(ref(db, `rooms/${roomId}/messages`), (snapshot) => {
            if (!stillHere()) return;
            renderMessage(snapshot.key, snapshot.val());
        }),
    );

    state.unsubscribe.push(
        onChildChanged(ref(db, `rooms/${roomId}/messages`), (snapshot) => {
            if (!stillHere()) return;
            const message = snapshot.val();
            state.messages.set(snapshot.key, message);
            renderReactions(snapshot.key, message);
        }),
    );
}

function teardown() {
    state.active = false;
    for (const unsubscribe of state.unsubscribe.splice(0)) {
        try {
            unsubscribe();
        } catch (error) {
            console.warn("取消監聽失敗：", error.message);
        }
    }
}

/** 房主離開後由最早加入的人接手，否則房間會沒人能管 */
async function syncRoomState() {
    const members = state.members;
    if (!members || Object.keys(members).length === 0) return;

    const currentHost = state.hostId;
    if (currentHost && members[currentHost]) {
        state.isHost = currentHost === state.userId;
    } else {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [uid, member] of Object.entries(members)) {
            if (!isValidUserId(uid)) continue;
            const joinedAt = isFiniteNumber(member?.joinedAt) ? member.joinedAt : Date.now();
            if (joinedAt < oldestAt) {
                oldestAt = joinedAt;
                oldestId = uid;
            }
        }
        state.isHost = oldestId !== null && oldestId === state.userId;
        if (state.isHost) {
            try {
                await set(ref(db, `rooms/${state.roomId}/host`), state.userId);
            } catch (error) {
                console.warn("接手房主失敗：", error.message);
            }
        }
    }

    setHidden(el.btnDisband, !state.isHost);
    renderMembers();
}

/* ================= 成員名單 ================= */
function renderMembers() {
    el.membersList.replaceChildren();

    const entries = Object.entries(state.members).filter(([uid]) => isValidUserId(uid));

    for (const [uid, member] of entries) {
        const name = cleanName(member?.name) || "匿名";

        const card = document.createElement("div");
        card.className = "member-card";
        card.setAttribute("role", "listitem");

        const left = document.createElement("div");
        left.className = "flex items-center gap-3 min-w-0";

        const avatar = document.createElement("img");
        avatar.className = "avatar-tile avatar-tile--sm";
        avatar.alt = "";
        avatar.width = 32;
        avatar.height = 32;
        applyAvatar(avatar, name, member?.avatar, 64);

        const info = document.createElement("div");
        info.className = "min-w-0";

        const nameLine = document.createElement("p");
        nameLine.className = "font-bold truncate";
        nameLine.textContent = uid === state.userId ? `${name}（你）` : name;
        info.appendChild(nameLine);

        if (uid === state.hostId) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "HOST";
            info.appendChild(badge);
        }

        left.append(avatar, info);
        card.appendChild(left);

        if (state.isHost && uid !== state.userId) {
            const kick = document.createElement("button");
            kick.type = "button";
            kick.className = "btn btn--danger btn--sm";
            kick.textContent = "踢出";
            kick.addEventListener("click", () => kickMember(uid, name));
            card.appendChild(kick);
        }

        el.membersList.appendChild(card);
    }
}

async function kickMember(uid, name) {
    if (!state.isHost || !isValidUserId(uid)) return;
    if (!window.confirm(`確定要踢出 ${name} 嗎？`)) return;
    try {
        await remove(ref(db, `rooms/${state.roomId}/members/${uid}`));
    } catch (error) {
        console.warn("踢出成員失敗：", error.message);
        warn("無法踢出成員", "請稍後再試。");
    }
}

/* ================= 訊息 ================= */
function renderMessage(msgId, rawMessage) {
    if (!rawMessage || typeof rawMessage !== "object") return;
    state.messages.set(msgId, rawMessage);

    const isMe = rawMessage.sender === state.userId;
    const text = cleanText(rawMessage.text, MAX_MESSAGE);
    const imageSrc = safeImageSrc(rawMessage.image);

    const row = document.createElement("div");
    row.className = `msg msg-enter${isMe ? " msg--me" : ""}`;

    if (!isMe) {
        const avatar = document.createElement("img");
        avatar.className = "avatar-tile avatar-tile--md";
        avatar.alt = "";
        avatar.width = 36;
        avatar.height = 36;
        applyAvatar(avatar, cleanName(rawMessage.name), rawMessage.avatar, 72);
        row.appendChild(avatar);
    }

    const body = document.createElement("div");
    body.className = "msg-body";

    if (!isMe) {
        const author = document.createElement("p");
        author.className = "msg-author";
        author.textContent = cleanName(rawMessage.name) || "匿名";
        body.appendChild(author);
    }

    const replyTo = rawMessage.replyTo;
    if (replyTo && typeof replyTo === "object") {
        const quote = document.createElement("div");
        quote.className = "reply-quote";

        const quoteName = document.createElement("span");
        quoteName.className = "reply-quote-name";
        quoteName.textContent = `回覆 ${cleanName(replyTo.name) || "匿名"}`;

        quote.append(quoteName, document.createTextNode(cleanText(replyTo.text, MAX_MESSAGE) || "[圖片]"));
        body.appendChild(quote);
    }

    const bubble = document.createElement("div");
    bubble.className = `bubble ${isMe ? "bubble--me" : "bubble--other"}`;

    if (imageSrc) {
        const image = document.createElement("img");
        image.className = "bubble-image";
        image.alt = "訊息圖片";
        image.src = imageSrc;
        image.addEventListener("click", () => openImage(imageSrc));
        bubble.appendChild(image);
    }

    if (text) bubble.appendChild(renderRichText(text));
    body.appendChild(bubble);

    const reactions = document.createElement("div");
    reactions.className = "reactions";
    reactions.id = `reactions-${msgId}`;
    body.appendChild(reactions);

    const star = document.createElement("button");
    star.type = "button";
    star.className = "msg-star";
    star.textContent = "★";
    star.title = "表情與回覆";
    star.setAttribute("aria-label", "對這則訊息按表情或回覆");
    star.addEventListener("click", (event) => openStarMenu(event, star, msgId));

    row.append(...(isMe ? [star, body] : [body, star]));
    el.chatMessages.appendChild(row);

    renderReactions(msgId, rawMessage);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

/**
 * 只把 @標記 轉成元素，其餘一律 textContent，杜絕 HTML 注入。
 */
function renderRichText(text) {
    const fragment = document.createDocumentFragment();

    for (const part of String(text ?? "").split(/(@\S+)/g)) {
        if (part.startsWith("@") && part.length > 1) {
            const mention = document.createElement("span");
            mention.className = "mention";
            mention.textContent = part;
            fragment.appendChild(mention);
        } else if (part) {
            fragment.appendChild(document.createTextNode(part));
        }
    }

    return fragment;
}

function renderReactions(msgId, message) {
    const container = $(`reactions-${msgId}`);
    if (!container) return;
    container.replaceChildren();

    const reactions = message?.reactions;
    if (!reactions || typeof reactions !== "object") return;

    for (const [rawEmoji, users] of Object.entries(reactions)) {
        const emoji = safeEmoji(rawEmoji);
        if (!emoji || !users || typeof users !== "object") continue;

        const userIds = Object.keys(users).filter(isValidUserId);
        if (userIds.length === 0) continue;

        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `chip${userIds.includes(state.userId) ? " is-mine" : ""}`;
        chip.textContent = `${emoji} ${userIds.length}`;
        chip.setAttribute("aria-label", `${emoji}，${userIds.length} 個回應`);
        chip.addEventListener("click", () => toggleReaction(emoji, msgId));
        container.appendChild(chip);
    }
}

async function toggleReaction(emoji, msgId) {
    const safe = safeEmoji(emoji);
    if (!safe || !state.roomId || !msgId) return;

    const reactionRef = ref(db, `rooms/${state.roomId}/messages/${msgId}/reactions/${safe}/${state.userId}`);
    try {
        const snapshot = await get(reactionRef);
        if (snapshot.exists()) await remove(reactionRef);
        else await set(reactionRef, true);
    } catch (error) {
        console.warn("表情更新失敗：", error.message);
        warn("表情沒有更新", "請稍後再試。");
    }
}

/* ================= 送出訊息 ================= */
el.btnSend.addEventListener("click", () => sendChatMessage());

el.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
    }
});

el.btnPickImage.addEventListener("click", () => el.chatImgInput.click());

el.chatImgInput.addEventListener("change", () => {
    handleImagePick(el.chatImgInput, MAX_IMAGE_SIDE, (dataUrl) => sendChatMessage(dataUrl));
});

async function sendChatMessage(imageDataUrl = "") {
    if (!state.roomId) return;

    const text = cleanText(el.messageInput.value, MAX_MESSAGE);
    if (!text && !imageDataUrl) return;

    const gate = chatRateLimit();
    if (!gate.ok) return showNotice(formatRateLimitNotice(gate));
    showNotice("");

    const payload = {
        sender: state.userId,
        name: state.nickname,
        avatar: state.avatar,
        timestamp: Date.now(),
    };
    if (text) payload.text = text;
    if (imageDataUrl) payload.image = imageDataUrl;
    if (state.replyingTo) {
        payload.replyTo = {
            id: state.replyingTo.id,
            name: cleanName(state.replyingTo.name),
            text: cleanText(state.replyingTo.text, MAX_MESSAGE),
        };
        cancelReply();
    }

    el.messageInput.value = "";
    autoResize(el.messageInput);

    try {
        await push(ref(db, `rooms/${state.roomId}/messages`), payload);
    } catch (error) {
        console.warn("送出訊息失敗：", error.message);
        showNotice("訊息沒有送出，請確認網路後再試一次。");
    }
}

/* ================= 星星選單與回覆 ================= */
function openStarMenu(event, anchor, msgId) {
    event.stopPropagation();
    clearTimeout(starMenuTimer);

    state.selectedMsgId = msgId;
    const message = state.messages.get(msgId);
    state.replyingTo = {
        id: msgId,
        name: cleanName(message?.name) || "匿名",
        text: cleanText(message?.text, MAX_MESSAGE),
    };

    setHidden(el.starMenu, false);
    const width = el.starMenu.offsetWidth || 180;
    const rect = anchor.getBoundingClientRect();
    el.starMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    el.starMenu.style.top = `${Math.max(8, rect.top - 48)}px`;
    requestAnimationFrame(() => el.starMenu.classList.remove("is-closed"));

    setTimeout(() => document.addEventListener("click", closeStarMenu, { once: true }), 10);
}

function closeStarMenu() {
    el.starMenu.classList.add("is-closed");
    clearTimeout(starMenuTimer);
    starMenuTimer = setTimeout(() => setHidden(el.starMenu, true), 120);
}

el.starMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-react]");
    if (!button) return;
    event.stopPropagation();
    toggleReaction(button.dataset.react, state.selectedMsgId);
    closeStarMenu();
});

el.btnReply.addEventListener("click", () => {
    if (!state.replyingTo) return;
    el.replyToName.textContent = state.replyingTo.name;
    setHidden(el.replyPreview, false);
    el.messageInput.focus();
    closeStarMenu();
});

el.btnCancelReply.addEventListener("click", cancelReply);

function cancelReply() {
    state.replyingTo = null;
    setHidden(el.replyPreview, true);
}

function openImage(src) {
    const safeSrc = safeImageSrc(src);
    if (!safeSrc) return;
    window.open(safeSrc, "_blank", "noopener,noreferrer");
}

/* ================= 離開與解散 =================
   退出一定要「立刻」生效：先離開畫面，再背景把成員節點刪掉。
   原本是先 await 資料庫寫入才切畫面，只要連線卡住（或手機斷網），
   按鈕就會看起來完全沒反應。 */
function leaveRoomNow() {
    const roomId = state.roomId;
    const userId = state.userId;
    if (!roomId) return leaveRoom("");

    /* 先關掉監聽守門：刪除自己會觸發成員變更，不關的話會把自己判斷成
       「被踢出房間」而跳出假警報。 */
    state.active = false;

    const myRef = ref(db, `rooms/${roomId}/members/${userId}`);
    remove(myRef).catch((error) => console.warn("退出時移除成員失敗：", error.message));
    /* 連線真的斷了也不用擔心殘留：註冊過的 onDisconnect 會清掉成員節點 */
    leaveRoom("");
}

el.btnLeave.addEventListener("click", leaveRoomNow);
el.btnLeavePanel.addEventListener("click", leaveRoomNow);

el.btnDisband.addEventListener("click", () => {
    const roomId = state.roomId;
    if (!state.isHost || !roomId) return;
    if (!window.confirm("解散房間會刪除所有人的對話，確定執行？")) return;

    state.active = false;
    const roomRef = ref(db, `rooms/${roomId}`);
    remove(roomRef).catch((error) => console.warn("解散房間失敗：", error.message));
    leaveRoom("房間已解散。");
});

function leaveRoom(message) {
    teardown();
    clearSession();
    state.roomId = null;
    state.isHost = false;
    state.hostId = null;
    state.members = {};
    state.messages.clear();
    state.selectedMsgId = null;
    cancelReply();
    el.chatMessages.replaceChildren();
    el.membersList.replaceChildren();
    el.chat.style.backgroundImage = "";
    switchScreen("landing-screen");
    showNotice("");
    if (message) warn(message);
}

/* ================= 其他介面事件 ================= */
el.btnMenu.addEventListener("click", () => {
    toggleMenu(el.sidebarPanel.classList.contains("is-hidden"));
});

el.btnPickBg.addEventListener("click", () => el.bgInput.click());

/* 手機版：點訊息區就收起側邊選單 */
el.chatMessages.addEventListener("click", () => toggleMenu(false));

/*
 * 全站關閉文字選取（見 app.css），這裡再攔事件：右鍵選單、複製、剪下都不作用，
 * 但輸入框與文字區要能編輯與複製自己的草稿，所以放行。
 * 這是「不讓訊息被順手帶走」的摩擦，不是防護：devtools、reader mode、OCR 都繞得過。
 */
/* 用 closest 判斷，不用 instanceof Element：少一個全域依賴，測試環境也跑得動 */
const isEditable = (target) => Boolean(target?.closest?.("input, textarea"));

document.addEventListener("contextmenu", (event) => {
    if (!isEditable(event.target)) event.preventDefault();
});

for (const type of ["copy", "cut"]) {
    document.addEventListener(type, (event) => {
        if (!isEditable(event.target)) event.preventDefault();
    });
}

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeStarMenu();
    closeUniverseModals();
});

/* ================= 心情宇宙 ================= */
/* 宇宙導覽：手機預設收合（把下半部留給星球），可隨時展開 */
function setLegendOpen(open) {
    el.legend.classList.toggle("is-open", open);
    el.btnLegend.setAttribute("aria-expanded", String(open));
}

el.btnLegend.addEventListener("click", () => {
    setLegendOpen(!el.legend.classList.contains("is-open"));
});

setLegendOpen(window.innerWidth >= 768);

$("btn-enter-universe").addEventListener("click", enterUniverse);
$("btn-exit-universe").addEventListener("click", () => switchScreen("landing-screen"));

/* ================= 心情清單 =================
   星點再多，用點的還是要靠運氣。所以說明面板的六個心情都可以點開清單，
   在清單裡直接挑一則讀，不必在星空裡找。 */
function postsFor(emotion) {
    return Object.entries(state.lastPosts ?? {})
        .filter(([, data]) => data && typeof data === "object" && data.emotion === emotion)
        .map(([postId, data]) => ({ postId, data }))
        .sort((a, b) => safeTimestamp(b.data.timestamp, 0) - safeTimestamp(a.data.timestamp, 0));
}

function renderEmotionCounts() {
    for (const emotion of Object.keys(PLANETS)) {
        const badge = document.querySelector(`[data-count-for="${emotion}"]`);
        if (!badge) continue;
        const count = postsFor(emotion).length;
        badge.textContent = count > 0 ? `${count} 顆` : "";
    }
}

function openMoodList(emotion) {
    if (!PLANETS[emotion]) return;
    state.readingEmotion = emotion;
    el.listTitle.textContent = `${PLANETS[emotion].name}的心事`;
    renderMoodList();
    setHidden(el.listModal, false);
    replayEnterAnimation(el.listModal.firstElementChild);
}

function renderMoodList() {
    const emotion = state.readingEmotion;
    if (!emotion) return;

    const items = postsFor(emotion);
    el.listItems.replaceChildren();

    if (items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "text-center text-gray-400 py-6";
        empty.textContent = "這一區還沒有星點，成為第一個留下心事的人吧。";
        el.listItems.appendChild(empty);
        return;
    }

    for (const { postId, data } of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "list-item";
        row.addEventListener("click", () => {
            setHidden(el.listModal, true);
            state.readingEmotion = null;
            openReadModal(postId, state.lastPosts?.[postId] ?? data);
        });

        const avatar = document.createElement("img");
        avatar.className = "avatar-tile avatar-tile--md avatar-tile--night";
        avatar.alt = "";
        avatar.width = 36;
        avatar.height = 36;
        applyAvatar(avatar, cleanName(data.name), data.avatar, 72);

        const body = document.createElement("div");
        body.className = "min-w-0 flex-1";

        const head = document.createElement("div");
        head.className = "flex items-center gap-2";

        const name = document.createElement("span");
        name.className = "reply-card-name";
        name.textContent = cleanName(data.name) || "匿名旅人";

        const time = document.createElement("span");
        time.className = "reply-card-time";
        time.textContent = formatTime(data.timestamp);

        const text = document.createElement("p");
        text.className = "list-item-text";
        text.textContent = cleanText(data.text, 80);

        head.append(name, time);
        body.append(head, text);

        const replyCount = Object.keys(data.replies ?? {}).length;
        if (replyCount > 0) {
            const meta = document.createElement("span");
            meta.className = "list-item-meta";
            meta.textContent = `${replyCount} 則迴響`;
            body.appendChild(meta);
        }

        row.append(avatar, body);
        el.listItems.appendChild(row);
    }
}

for (const button of document.querySelectorAll("[data-emotion]")) {
    button.addEventListener("click", () => openMoodList(button.dataset.emotion));
}

/**
 * 星點只有 12px，行動裝置很難精準點到。所以整個宇宙畫面都接受點擊：
 * 只要落在某顆星 44px 內，就開啟最近的那一顆（手指的半徑就是這麼大）。
 */
function openNearestStar(clientX, clientY) {
    let nearest = null;
    let nearestDistance = STAR_TAP_RADIUS;

    for (const node of el.starsContainer.children) {
        const rect = node.getBoundingClientRect();
        const distance = Math.hypot(
            clientX - (rect.left + rect.width / 2),
            clientY - (rect.top + rect.height / 2),
        );
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = node;
        }
    }

    /* 交給星點自己的處理器開啟；它會 stopPropagation，不會再回到這裡 */
    if (nearest) nearest.click();
}

el.universe.addEventListener("click", (event) => {
    if (event.target.closest(".star, .planet, .legend, .universe-exit")) return;
    openNearestStar(event.clientX, event.clientY);
});

/* 旋轉螢幕或改變視窗大小時重畫星點，位置才不會跑掉 */
let starLayoutTimer = null;
window.addEventListener("resize", () => {
    if (!state.universeReady) return;
    clearTimeout(starLayoutTimer);
    starLayoutTimer = setTimeout(() => renderStars(state.lastPosts ?? {}), 200);
});

function enterUniverse() {
    switchScreen("universe-screen");
    if (state.universeReady) return;
    state.universeReady = true;
    renderPlanets();
    listenToUniverse();
}

function renderPlanets() {
    el.planetsContainer.replaceChildren();

    for (const [key, planet] of Object.entries(PLANETS)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "planet planet-float";
        button.style.top = `${planet.top}%`;
        button.style.left = `${planet.left}%`;
        button.style.animationDelay = `${Math.random() * 2}s`;
        button.setAttribute("aria-label", `對「${planet.name}」留下一顆星`);
        button.addEventListener("click", () => openPostModal(key));

        const art = document.createElement("div");
        art.className = "planet-art";

        const image = document.createElement("img");
        image.className = "planet-img";
        image.alt = "";
        image.src = planet.img;
        image.style.filter = `drop-shadow(0 0 10px ${planet.color})`;

        const plus = document.createElement("span");
        plus.className = "planet-plus";
        plus.setAttribute("aria-hidden", "true");
        plus.textContent = "+";

        art.append(image, plus);

        const label = document.createElement("span");
        label.className = "planet-name";
        label.textContent = planet.name;

        button.append(art, label);
        el.planetsContainer.appendChild(button);
    }
}

function listenToUniverse() {
    /* 只取最近 300 筆，避免貼文累積後整包下載。
       注意：這裡還沒加 .indexOn，Firebase 仍會先抓整包再排序；要真正省流量
       得在資料庫規則為 universe/posts 補上 .indexOn: ["timestamp"]。 */
    const postsQuery = query(ref(db, "universe/posts"), orderByChild("timestamp"), limitToLast(UNIVERSE_POST_LIMIT));
    onValue(postsQuery, (snapshot) => {
        renderStars(snapshot.val() ?? {});
    });
}

/** 畫出全部星點。畫面尺寸改變時會重畫，所以座標一律用 px 重新算。 */
function renderStars(posts) {
    state.lastPosts = posts;
    /* 星球先佔位，星點才不會疊在星球上（星球在上層，疊上去會點不到） */
    placedPoints = Object.values(PLANETS).map((planet) => ({
        x: (planet.left / 100) * window.innerWidth,
        y: (planet.top / 100) * window.innerHeight,
        radius: PLANET_CLEARANCE,
    }));

    el.starsContainer.replaceChildren();
    for (const [postId, data] of Object.entries(posts)) renderStar(postId, data);

    renderEmotionCounts();
    /* 清單開著的時候有新心事進來，直接更新 */
    if (state.readingEmotion) renderMoodList();
}

/**
 * 找一個不跟別人重疊的位置：先用「星球位置 + 貼文位移」算出理想點，
 * 被佔用就沿著黃金角螺旋往外找。黃金角可以讓同一個星球的星點自然散開，
 * 不會擠成一團。
 */
function findFreeSpot(candidate) {
    let best = { x: candidate.x, y: candidate.y };
    for (let attempt = 0; attempt < 24; attempt += 1) {
        const clash = placedPoints.some(
            (point) => Math.hypot(point.x - best.x, point.y - best.y) < (point.radius ?? STAR_MIN_GAP),
        );
        if (!clash) break;
        const angle = attempt * 2.399963;
        const distance = 18 + attempt * 8;
        best = {
            x: candidate.x + Math.cos(angle) * distance,
            y: candidate.y + Math.sin(angle) * distance,
        };
    }

    const margin = STAR_HALF + 4;
    best.x = Math.min(Math.max(best.x, margin), window.innerWidth - margin);
    best.y = Math.min(Math.max(best.y, margin), window.innerHeight - margin);
    placedPoints.push(best);
    return best;
}

function renderStar(postId, data) {
    if (!data || typeof data !== "object") return;
    const planet = PLANETS[data.emotion];
    if (!planet) return;

    const offsetX = clampOffset(data.offsetX);
    const offsetY = clampOffset(data.offsetY);

    const spot = findFreeSpot({
        x: (planet.left / 100) * window.innerWidth + (offsetX / 100) * window.innerWidth,
        y: (planet.top / 100) * window.innerHeight + (offsetY / 100) * window.innerHeight,
    });

    const star = document.createElement("button");
    star.type = "button";
    star.className = "star custom-star";
    star.style.left = `${spot.x - STAR_HALF}px`;
    star.style.top = `${spot.y - STAR_HALF}px`;
    star.style.animationDelay = `${Math.random() * 2}s`;
    star.setAttribute("aria-label", "閱讀這則心事");
    star.addEventListener("click", () => openReadModal(postId, data));

    const halo = document.createElement("span");
    halo.className = "star-halo";
    halo.style.backgroundColor = planet.color;

    const core = document.createElement("span");
    core.className = "star-core";
    core.style.backgroundColor = planet.color;
    core.style.boxShadow = `0 0 8px ${planet.color}, 0 0 12px #ffffff`;

    const orbit = document.createElement("span");
    orbit.className = "reply-orbit";

    star.append(halo, core, orbit);
    el.starsContainer.appendChild(star);

    const replies = Array.isArray(data.replies) ? [] : Object.values(data.replies ?? {});
    const radius = window.innerWidth < 768 ? 14 : 18;
    replies.forEach((_, index) => {
        const angle = (index / replies.length) * Math.PI * 2;
        const dot = document.createElement("span");
        dot.className = "reply-dot";
        dot.style.top = `calc(50% + ${Math.sin(angle) * radius}px - 3px)`;
        dot.style.left = `calc(50% + ${Math.cos(angle) * radius}px - 3px)`;
        orbit.appendChild(dot);
    });

    /* 正在閱讀同一則心事時，同步更新迴響列表 */
    if (state.readingPostId === postId) renderReplies(data.replies);
}

/* ================= 心情宇宙：發文 ================= */
function openPostModal(emotion) {
    if (!PLANETS[emotion]) return;
    state.targetEmotion = emotion;
    el.postTitle.textContent = `為「${PLANETS[emotion].name}」留星`;
    el.postNickname.value = state.nickname;
    el.postText.value = "";
    setHidden(el.postModal, false);
    replayEnterAnimation(el.postModal.firstElementChild);
    el.postText.focus();
}

el.btnPostSubmit.addEventListener("click", async () => {
    if (!PLANETS[state.targetEmotion]) return;

    const text = cleanText(el.postText.value, MAX_POST);
    if (!text) return warn("請輸入心事內容");

    const gate = universeRateLimit();
    if (!gate.ok) return warn("送出太頻繁", formatRateLimitNotice(gate));

    state.nickname = cleanName(el.postNickname.value) || state.nickname || "匿名旅人";

    const angle = Math.random() * Math.PI * 2;
    const distance = (window.innerWidth < 768 ? 5 : 7) + Math.random() * 8;

    try {
        await push(ref(db, "universe/posts"), {
            emotion: state.targetEmotion,
            name: state.nickname,
            avatar: state.avatar,
            text,
            timestamp: Date.now(),
            offsetX: Math.cos(angle) * distance,
            offsetY: Math.sin(angle) * distance,
        });
        closeUniverseModals();
    } catch (error) {
        console.warn("發出心事失敗：", error.message);
        warn("沒有送出", "請確認網路後再試一次。");
    }
});

/* ================= 心情宇宙：閱讀與回覆 ================= */
function openReadModal(postId, data) {
    state.readingPostId = postId;

    const postName = cleanName(data.name) || "匿名旅人";
    applyAvatar(el.readAvatar, postName, data.avatar, 80);
    el.readName.textContent = postName;
    el.readTime.textContent = formatTime(data.timestamp);
    el.readText.textContent = cleanText(data.text, MAX_POST);
    el.replyInput.value = "";
    autoResize(el.replyInput);

    renderReplies(data.replies);
    setHidden(el.readModal, false);
    replayEnterAnimation(el.readModal.firstElementChild);
    el.replyInput.focus();
}

function renderReplies(rawReplies) {
    const replies = Array.isArray(rawReplies) ? [] : Object.values(rawReplies ?? {});
    el.repliesList.replaceChildren();

    if (replies.length === 0) {
        const empty = document.createElement("p");
        empty.className = "text-center text-gray-400 py-4";
        empty.textContent = "目前還沒有迴響，成為第一個給予溫暖的人吧。";
        el.repliesList.appendChild(empty);
        return;
    }

    replies
        .slice()
        .sort((a, b) => safeTimestamp(a?.timestamp, 0) - safeTimestamp(b?.timestamp, 0))
        .forEach((reply, index) => {
            const card = document.createElement("div");
            card.className = "reply-card msg-enter";
            card.style.animationDelay = `${Math.min(index * 0.05, 0.4)}s`;

            const avatar = document.createElement("img");
            avatar.className = "avatar-tile avatar-tile--md avatar-tile--night";
            avatar.alt = "";
            avatar.width = 36;
            avatar.height = 36;
            applyAvatar(avatar, cleanName(reply.name), reply.avatar, 72);

            const body = document.createElement("div");
            body.className = "min-w-0 flex-1";

            const head = document.createElement("div");
            head.className = "flex items-center gap-2";

            const name = document.createElement("span");
            name.className = "reply-card-name";
            name.textContent = cleanName(reply.name) || "匿名旅人";

            const time = document.createElement("span");
            time.className = "reply-card-time";
            time.textContent = formatTime(reply.timestamp);

            const text = document.createElement("p");
            text.className = "reply-card-text";
            text.textContent = cleanText(reply.text, MAX_REPLY);

            head.append(name, time);
            body.append(head, text);
            card.append(avatar, body);
            el.repliesList.appendChild(card);
        });
}

el.btnReplySubmit.addEventListener("click", submitUniverseReply);

el.replyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitUniverseReply();
    }
});

async function submitUniverseReply() {
    if (!state.readingPostId) return;

    const text = cleanText(el.replyInput.value, MAX_REPLY);
    if (!text) return;

    const gate = universeRateLimit();
    if (!gate.ok) return warn("回覆太頻繁", formatRateLimitNotice(gate));

    try {
        await push(ref(db, `universe/posts/${state.readingPostId}/replies`), {
            name: state.nickname || "匿名旅人",
            avatar: state.avatar,
            text,
            timestamp: Date.now(),
        });
        el.replyInput.value = "";
        autoResize(el.replyInput);
    } catch (error) {
        console.warn("回覆失敗：", error.message);
        warn("沒有送出", "請確認網路後再試一次。");
    }
}

/* ================= Modal 共用行為 ================= */
for (const button of document.querySelectorAll("[data-close-universe]")) {
    button.addEventListener("click", closeUniverseModals);
}

for (const modal of [el.postModal, el.readModal, el.listModal]) {
    modal.addEventListener("click", (event) => {
        if (event.target !== modal) return;
        setHidden(modal, true);
        if (modal === el.readModal) state.readingPostId = null;
        if (modal === el.listModal) state.readingEmotion = null;
    });
}

function closeUniverseModals() {
    setHidden(el.postModal, true);
    setHidden(el.readModal, true);
    setHidden(el.listModal, true);
    state.readingPostId = null;
    state.readingEmotion = null;
}

/* ================= 輸入框自動長高 ================= */
/* 元素被隱藏時 scrollHeight 是 0，硬算會把高度設成 2px（看起來扁扁的），
   所以看不到的時候就把行內高度交還給 CSS 的 min-height。 */
function autoResize(textarea) {
    if (!textarea.offsetParent) {
        textarea.style.height = "";
        return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function autoResizeAll() {
    for (const textarea of [el.messageInput, el.replyInput]) autoResize(textarea);
}

for (const textarea of [el.messageInput, el.replyInput]) {
    textarea.addEventListener("input", () => autoResize(textarea));
    autoResize(textarea);
}
autoResizeAll();

/* ================= 頁面標記 =================
   整頁平鋪一層看不出來的小字，內容是明文（暱稱／房號／機型／公網 IP），只有在
   截圖被拉高對比時才看得到。黑白兩份交給 CSS 依主題挑，這裡負責產生圖與掛上圖層。 */
let publicIp = "";
let deviceLabel = deviceModel(navigator.userAgent);

/*
 * 機型：Chrome 110 之後 Android 的 user agent 只剩「Android 10; K」，解析出來就是一個
 * K，所以先問 UA Client Hints 的 model，拿不到才沿用解析結果。這步是非同步的，
 * 回來之後才重畫標記。
 */
async function loadDeviceModel() {
    try {
        const hints = await navigator.userAgentData?.getHighEntropyValues?.(["model"]);
        const model = deviceModel(navigator.userAgent, hints?.model);
        if (model && model !== deviceLabel) {
            deviceLabel = model;
            refreshPageMark();
        }
    } catch (error) {
        console.warn("取不到機型，沿用 user agent：", error.message);
    }
}

/*
 * 靜態站看不到自己的公網 IP，只能問外面的回顯服務——這是本站唯一的第三方請求
 * （取捨寫在 SECURITY.md）。拿不到就少寫一行，其餘照舊。
 */
async function loadPublicIp() {
    if (typeof fetch !== "function") return;
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        const ip = safeIp((await response.json())?.ip);
        if (ip) {
            publicIp = ip;
            refreshPageMark();
        } else {
            console.warn("回顯服務回的內容不像 IP，標記少一行。");
        }
    } catch (error) {
        console.warn("取不到公網 IP，標記少一行：", error.message);
    }
}

function refreshPageMark() {
    const label = [state.nickname, state.roomId, deviceLabel, publicIp].join("\n");
    const style = document.documentElement.style;
    style.setProperty("--mark-image-light", pageMarkImage(label, "#000"));
    style.setProperty("--mark-image-dark", pageMarkImage(label, "#fff"));
}

function installPageMark() {
    const layer = document.createElement("div");
    layer.id = "mark-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    refreshPageMark();
    void loadDeviceModel();
    void loadPublicIp();
}

installPageMark();

prefillInputs();
state.avatar = readStoredAvatar();
syncAvatarControls();
applyAvatar(el.avatarPreview, el.nicknameInput.value, state.avatar, AVATAR_SIDE);
applyAvatar(el.heroAvatar, "ChatChat", "", 192);
void restoreSession();
