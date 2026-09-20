/* ==========================================================================
   輸入淨化與驗證 - 純函式，不依賴 DOM 或 Firebase
   --------------------------------------------------------------------------
   所有來自資料庫或使用者輸入的資料，都必須先經過這裡才能進入畫面或寫回
   資料庫。畫面渲染一律使用 textContent / DOM API，不使用 innerHTML，
   因此這裡的責任是「界線驗證」，不是 HTML 跳脫。
   相關的自我檢查：node tools/selfcheck.mjs
   ========================================================================== */

export const MAX_NAME = 10;
export const MAX_MESSAGE = 2000;
export const MAX_POST = 1000;
export const MAX_REPLY = 500;

/* 單筆 Base64 圖片上限（約 675KB 原始位元）。RTDB 單次寫入上限是 10MB，
   這裡刻意壓在遠低於上限，避免單一訊息吃光頻寬。 */
export const MAX_IMAGE_CHARS = 900000;

/* Firebase 的 key 不能包含 . # $ [ ] /，房號限英數與 - _ */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/*
 * 使用者 ID 接受兩種形狀：
 *   1. user_ 前綴的匿名 ID（現在的做法：crypto.randomUUID 去掉符號）
 *   2. 未加前綴的 Firebase Auth UID（20~40 個英數）——之後接上匿名登入時，
 *      auth.uid 會直接用來當成員節點的 key，所以規則先放寬。
 * 兩者都不含 Firebase 禁用字元。
 */
export const USER_ID_PATTERN = /^(?:user_[A-Za-z0-9_-]{1,32}|[A-Za-z0-9]{20,40})$/;

/* 允許的圖片來源：本地檔案轉出的 data URL，或 https 遠端圖 */
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const HTTPS_IMAGE_PATTERN = /^https:\/\/[^\s"'<>\\]{4,600}$/;

/* 控制字元、雙向覆寫、零寬字元：可用來偽造暱稱或欺騙畫面 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function toCleanString(value) {
    return typeof value === "string" ? value.normalize("NFC").replace(INVISIBLE, "") : "";
}

function clampChars(value, max) {
    return Array.from(value).slice(0, max).join("");
}

/** 暱稱：去控制字元與換行、限制長度 */
export function cleanName(value) {
    const cleaned = toCleanString(value).replace(/[\r\n\t]+/g, " ").trim();
    return clampChars(cleaned, MAX_NAME);
}

/** 一般文字：保留換行（換成 \n），限制長度 */
export function cleanText(value, max = MAX_MESSAGE) {
    const cleaned = toCleanString(value).replace(/\r\n?/g, "\n").trim();
    return clampChars(cleaned, max);
}

export function isValidRoomId(value) {
    return typeof value === "string" && ROOM_ID_PATTERN.test(value);
}

export function isValidUserId(value) {
    return typeof value === "string" && USER_ID_PATTERN.test(value);
}

/** 產生猜不到的房號；房號就是加入房間的唯一憑證，所以不能是可預測的流水號 */
export function makeRoomCode(length = 10) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const byte of bytes) out += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
    return out;
}

/** 圖片來源白名單：只接受 data:image/* 與 https */
export function safeImageSrc(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_IMAGE_CHARS) return "";
    if (DATA_IMAGE_PATTERN.test(trimmed)) return trimmed;
    if (HTTPS_IMAGE_PATTERN.test(trimmed)) return trimmed;
    return "";
}

/* emoji 只允許單一或含修飾符（膚色、variation selector、ZWJ）的短序列。
   開頭必須是 Extended_Pictographic，否則數字與 # * 也會因為算 Emoji_Component
   而被放行。 */
const EMOJI_PATTERN = /^\p{Extended_Pictographic}(?:\p{Extended_Pictographic}|\p{Emoji_Component}){0,3}$/u;

export function safeEmoji(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 8 && EMOJI_PATTERN.test(trimmed) ? trimmed : "";
}

/* 機型只留英數與 - _ .，最長 16 字元，避免塞進標記時爆長或夾帶控制字元 */
export const MAX_DEVICE = 16;

function cleanDeviceTag(value) {
    return String(value ?? "")
        .replace(/[^A-Za-z0-9._-]+/g, "")
        .replace(/^[-._]+|[-._]+$/g, "")
        .slice(0, MAX_DEVICE);
}

/**
 * 從 user agent 抓出可讀的機型（明文，可以造假）。
 * Chrome 110 之後 Android 的 UA 被縮減成「Android 10; K」，機型就沒了，
 * 所以有 UA Client Hints 的 model 時優先用它（見 app.js 的 loadDeviceModel），
 * 都沒有才退成平台名或 unknown。
 */
export function deviceModel(userAgent, model = "") {
    const explicit = cleanDeviceTag(model);
    if (explicit) return explicit;

    const ua = String(userAgent ?? "");

    /* Android 的 UA 通常是「Android 13; SM-G991B Build/TP1A」，機型在中間那一段 */
    const android = ua.match(/Android[^;)]*;\s*([^;)]+)/i);
    if (android) {
        const model = cleanDeviceTag(android[1].replace(/\s*Build[/\s].*$/i, ""));
        return model || "Android";
    }

    if (/\biPad\b/i.test(ua)) return "iPad";
    if (/\biPhone\b/i.test(ua)) return "iPhone";
    if (/\biPod\b/i.test(ua)) return "iPod";
    if (/Windows NT/i.test(ua)) return "Windows";
    if (/CrOS/i.test(ua)) return "ChromeOS";
    if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
    if (/Linux/i.test(ua)) return "Linux";
    return "unknown";
}

/**
 * 公網 IP 是外部服務回報的字串，只接受長得像 IPv4／IPv6 的內容，
 * 其餘一律當作沒拿到（免得別人的回應被寫進標記）。
 */
export function safeIp(value) {
    const text = String(value ?? "").trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return text;
    if (/^[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}$/.test(text)) return text;
    return "";
}

/** 貼進 SVG <text> 前把 XML 特殊字元換掉（頭像的底色圖用） */
export function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
        switch (char) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&#39;";
        }
    });
}

/** 送出頻率限制：同時擋「手速連點」與「一分鐘內爆量」 */
export function createRateLimiter({ windowMs = 60000, max = 20, minGapMs = 700 } = {}, now = () => Date.now()) {
    let stamps = [];
    let last = 0;

    return function allow() {
        const t = now();
        const sinceLast = t - last;
        if (last !== 0 && sinceLast < minGapMs) {
            return { ok: false, reason: "too-fast", retryMs: minGapMs - sinceLast };
        }

        stamps = stamps.filter((stamp) => t - stamp < windowMs);
        if (stamps.length >= max) {
            return { ok: false, reason: "too-many", retryMs: windowMs - (t - stamps[0]) };
        }

        stamps.push(t);
        last = t;
        return { ok: true, retryMs: 0 };
    };
}

/** 只接受合理的數字時間戳，避免 new Date(undefined) 產生 Invalid Date */
export function safeTimestamp(value, fallback = Date.now()) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function formatTime(value) {
    return new Date(safeTimestamp(value)).toLocaleString("zh-TW", { hour12: false });
}

export function formatRateLimitNotice(result) {
    if (result.ok) return "";
    const seconds = Math.max(1, Math.ceil(result.retryMs / 1000));
    return result.reason === "too-fast" ? `送出太快了，請等 ${seconds} 秒。` : `訊息量過大，請等 ${seconds} 秒再試。`;
}
