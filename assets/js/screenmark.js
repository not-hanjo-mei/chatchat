/* ==========================================================================
   畫面浮水印層 - 讓一小段文字在畫面上緩慢飄動
   --------------------------------------------------------------------------
   這一層是**看得見的**：目的是嚇阻與事後辨識，截圖或翻拍都會帶著它，肉眼可讀。

   至於看不見的那一層寫在訊息文字裡（見 watermark.js 的 embedTextMark）：
   人類外流最省事的做法是複製貼上，那條路會把零寬字元的標記一起帶走。

   兩層都只顯示「目前這個使用者」的資訊，所以誰外流就追誰。
   ========================================================================== */

import { deviceModel } from "./sanitize.js";

/* 同時在畫面上飄的份數。太多會干擾閱讀，太少則容易被裁掉。 */
const MARK_COUNT = 9;

/* 三組動畫輪流用，讓它們不同步 */
const MOTIONS = ["mark-drift-a", "mark-drift-b", "mark-drift-c"];

/** 浮水印文字：只有裝置標籤（機型＋裝置指紋） */
export function markLabel(device) {
    const tag = String(device ?? "").trim() || "unknown";
    return tag;
}

/**
 * 裝置標籤：機型（可讀）＋ canvas 指紋（認得出是哪一台）。
 * 整個標記只有 12 bytes 可用，所以有指紋時機型只留 5 字（5+1+5）。
 */
export function deviceTag(userAgent, canvas) {
    const model = deviceModel(userAgent).replace(/[^A-Za-z0-9._-]/g, "");
    const signature = canvasSignature(canvas);
    if (!signature) return model.slice(0, 12) || "unknown";
    return `${model.slice(0, 5)}-${signature}`;
}

/**
 * 在固定尺寸的 canvas 上畫一段固定圖樣，把像素雜湊成短標籤。
 * 字型、反鋸齒、GPU、色彩處理都會影響輸出，所以這是「這台裝置」的特徵；
 * 比 user agent 可靠（UA 可以造假、會被隱藏、也會隨版本變動）。
 */
export function canvasSignature(canvas) {
    const context = canvas?.getContext?.("2d");
    if (!context) return "";

    const width = 240;
    const height = 60;
    canvas.width = width;
    canvas.height = height;

    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#f6f5f0");
    gradient.addColorStop(0.5, "#5b7fe5");
    gradient.addColorStop(1, "#101820");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.globalAlpha = 0.35;
    context.fillStyle = "#000000";
    context.fillRect(7, 11, 61, 23);
    context.globalAlpha = 1;

    context.font = "17px Arial, sans-serif";
    context.fillStyle = "#0a0a0a";
    context.fillText("ChatChat 心情宇宙 ✳ 0123", 11, 31);

    context.beginPath();
    context.arc(186, 30, 17, 0, Math.PI * 2);
    context.fillStyle = "rgba(255,0,128,0.6)";
    context.fill();

    context.shadowColor = "rgba(0,0,0,0.45)";
    context.shadowBlur = 4;
    context.shadowOffsetX = 2;
    context.shadowOffsetY = 2;
    context.fillStyle = "#0099ff";
    context.fillRect(201, 9, 29, 19);

    const image = context.getImageData(0, 0, width, height);
    let hash = 0x811c9dc5;
    for (const byte of image.data) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).slice(0, 5);
}

/* 同一台裝置每次算出來都一樣，算一次就夠 */
let cachedTag = "";

/** 目前裝置的標籤（機型-指紋）；canvas 不可用時退回機型或 unknown。 */
export function currentDeviceTag() {
    if (!cachedTag) {
        const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
        cachedTag = deviceTag(userAgent, document.createElement("canvas"));
    }
    return cachedTag;
}

/**
 * 在容器裡鋪好浮水印文字並開始飄動。
 * @param {HTMLElement} container 覆蓋整個畫面的容器
 */
export function startScreenMark(container) {
    if (!container) return;

    const marks = [];
    for (let index = 0; index < MARK_COUNT; index += 1) {
        const mark = document.createElement("span");
        mark.className = "mark-text";
        /* 起始位置平均分散，動畫各自不同相，才不會整排一起動 */
        mark.style.left = `${((index * 37 + 4) % 82) + 4}%`;
        mark.style.top = `${((index * 23 + 6) % 84) + 4}%`;
        mark.style.animationName = MOTIONS[index % MOTIONS.length];
        mark.style.animationDuration = `${44 + (index % 5) * 9}s`;
        mark.style.animationDelay = `-${(index * 6) % 30}s`;
        container.appendChild(mark);
        marks.push(mark);
    }

    const text = markLabel(currentDeviceTag());
    for (const mark of marks) mark.textContent = text;
}
