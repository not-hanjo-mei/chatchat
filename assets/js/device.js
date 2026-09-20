/* ==========================================================================
   裝置標籤 - 產生「機型 ＋ 裝置指紋」這串短標籤
   --------------------------------------------------------------------------
   標籤會寫進訊息文字的隱形標記（watermark.js 的 embedTextMark）與送進房間的
   圖片盲水印，用來在事後辨識是哪一台裝置留下的。

   裝置指紋是用 canvas 畫一段固定圖樣再雜湊像素結果：字型、反鋸齒、GPU、色彩
   處理都會影響輸出，所以這是「這台裝置」的特徵。比 user agent 可靠——UA 可以
   造假、會被隱藏，也會隨版本變動；UA 只在 canvas 不可用時當後備。
   ========================================================================== */

import { deviceModel } from "./sanitize.js";

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
