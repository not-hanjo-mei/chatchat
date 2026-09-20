/* ==========================================================================
   頭像產生器
   --------------------------------------------------------------------------
   沒有上傳頭像的人，用「名字」當種子產生一個固定的 GrokBot 頭像：
   同一個名字永遠得到同一張臉（形狀、表情、配色都一樣），換一個名字就換一張。

   引擎來自 grokbot-web（BSD-3-Clause，見 vendor/grokbot/），只在使用時才
   動態載入，因此不影響首頁載入速度。繪圖只在記憶體中的 canvas 進行，畫完
   立刻 destroy()，不會有動畫迴圈留在頁面上。
   ========================================================================== */

import { escapeXml, safeImageSrc } from "./sanitize.js";

/* 由名字雜湊挑一組顏色；深色身體配亮眼睛，亮色身體配深眼睛 */
const BODY_COLORS = [
    "#5b7fe5",
    "#e07a5f",
    "#3d9970",
    "#b07de0",
    "#e0a53d",
    "#d4576f",
    "#2f9fb0",
    "#8a9a3b",
    "#c06fc0",
    "#5561c9",
];
const EYE_LIGHT = "#fffdf7";
const EYE_DARK = "#181a15";

const urlCache = new Map();
let vendorPromise = null;

/** 只在真的需要畫頭像時才載入 40KB 的繪圖引擎 */
function loadVendor() {
    vendorPromise ??= import("./vendor/grokbot.js");
    return vendorPromise;
}

function normalizeName(name) {
    return (typeof name === "string" ? name : "").trim() || "匿名";
}

/** FNV-1a 32-bit：穩定、小、不需要額外套件 */
function hash32(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** 可重現的偽隨機序列，讓同一顆種子永遠產生同一張臉 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isDark(hexColor) {
    const value = Number.parseInt(hexColor.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    return luminance < 0.6;
}

/**
 * 名字 → 外觀。刻意只用一顆隨機序列依序取值，所以順序就是規格：
 * 動到這裡的取用順序，所有人的頭像都會換一張臉。
 */
export function avatarPlan(name) {
    const label = normalizeName(name);
    const seed = hash32(label);
    const random = mulberry32(seed);

    const bodyColor = BODY_COLORS[Math.floor(random() * BODY_COLORS.length)];
    const eyeColor = isDark(bodyColor) ? EYE_LIGHT : EYE_DARK;

    return {
        label,
        seed,
        bodyColor,
        eyeColor,
        shapeIndex: Math.floor(random() * 18),
        expression: Math.floor(random() * 25),
        flipX: random() < 0.5,
        gaze: { x: random() * 1.2 - 0.6, y: random() * 0.8 - 0.4 },
        turn: (random() - 0.5) * 0.5,
        initial: Array.from(label)[0] ?? "?",
    };
}

/** 產生真正頭像前先顯示的底色，用同一個顏色，避免換圖時顏色跳動 */
function placeholderUrl(plan, size) {
    const half = size / 2;
    const textColor = isDark(plan.bodyColor) ? EYE_LIGHT : EYE_DARK;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${plan.bodyColor}"/><text x="${half}" y="${half}" font-size="${Math.round(size * 0.5)}" fill="${textColor}" font-family="monospace" font-weight="bold" text-anchor="middle" dominant-baseline="central">${escapeXml(plan.initial)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 用 grokbot 引擎畫一格靜態表情，回傳 PNG data URL */
export async function generateAvatarUrl(name, size = 96) {
    const plan = avatarPlan(name);
    const cacheKey = `${plan.seed}:${size}`;
    const cached = urlCache.get(cacheKey);
    if (cached) return cached;

    const pending = (async () => {
        const { GrokBot, shapeNames } = await loadVendor();
        const canvas = document.createElement("canvas");
        const bot = new GrokBot(canvas, {
            size,
            shape: shapeNames[plan.shapeIndex],
            expression: plan.expression,
            theme: { bodyColor: plan.bodyColor, eyeColor: plan.eyeColor },
            gaze: plan.gaze,
            turn: plan.turn,
            flipX: plan.flipX,
            autoBlink: false,
            autoExpression: false,
            /* 只畫一格靜態圖，不跑動畫，所以不需要理會動態偏好 */
            respectReducedMotion: false,
            ariaLabel: "",
        });

        try {
            bot.render();
            return canvas.toDataURL("image/png");
        } finally {
            /* 不放動畫迴圈在背景跑 */
            bot.destroy();
        }
    })();

    urlCache.set(cacheKey, pending);
    return pending;
}

/**
 * 把頭像套到 <img> 上。
 * 有上傳過頭像就用上傳的，沒有就用名字產生一張；產圖是非同步的，所以先放
 * 同色的底色圖，好了再換上去。
 */
export function applyAvatar(img, name, customSrc, size = 64) {
    const custom = safeImageSrc(customSrc);
    if (custom) {
        img.src = custom;
        return;
    }

    const plan = avatarPlan(name);
    img.src = placeholderUrl(plan, size);
    generateAvatarUrl(name, size)
        .then((url) => {
            img.src = url;
        })
        .catch((error) => {
            console.warn("頭像產生失敗，保留底色圖：", error.message);
        });
}

/** 給需要先知道顏色的地方（例如載入中的骨架） */
export function avatarColor(name) {
    return avatarPlan(name).bodyColor;
}
