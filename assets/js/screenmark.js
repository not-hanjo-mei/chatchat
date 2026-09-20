/* ==========================================================================
   頁面標記層 - 在整個畫面上疊一層透明 canvas，裡面藏盲水印
   --------------------------------------------------------------------------
   為什麼是「疊一層 canvas」而不是直接改 DOM：DOM 文字我們動不了像素，截圖時
   文字邊緣會把低頻標記整片蓋掉；疊層寫在**中頻**係數上，頁面平坦處中頻幾乎
   沒有能量，所以只要解碼時只挑低變異區塊（沒有文字的地方）投票就解得出來。

   標記內容＝使用者 ID 指紋 ＋ 裝置簽章。裝置簽章是用 canvas 畫一段固定圖樣再
   雜湊指紋（字型、反鋸齒、GPU、色彩處理都會影響輸出，這正是「這一台裝置」的
   特徵），比 UA 可靠：UA 可以造假、會被隱藏、也會隨版本變動。UA 只在 canvas
   不可用時當後備。

   這個檔案只負責畫，寫入與取出的演算法在 watermark.js。
   ========================================================================== */

import { deviceModel } from "./sanitize.js";
import { embedOverlayWatermark, markPayload } from "./watermark.js";

/* 標記層的不透明度。0.05 時整張畫面的平均差異約 5/255、最大 9，肉眼看不出來，
   而全螢幕截圖（PNG 不失真）仍解得回來。 */
const MARK_OPACITY = 0.05;

/* 標記層的底色：中性灰，疊上去只會讓對比略微降低，不會整片變亮或變暗 */
const MARK_BASE = 128;

const SIGNATURE_WIDTH = 240;
const SIGNATURE_HEIGHT = 60;

/** 畫一段固定圖樣，回傳像素指紋（base36）。canvas 不可用時回空字串。 */
export function deviceSignature(canvas) {
    const context = canvas?.getContext?.("2d");
    if (!context) return "";

    canvas.width = SIGNATURE_WIDTH;
    canvas.height = SIGNATURE_HEIGHT;

    const gradient = context.createLinearGradient(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    gradient.addColorStop(0, "#f6f5f0");
    gradient.addColorStop(0.5, "#5b7fe5");
    gradient.addColorStop(1, "#101820");
    context.fillStyle = gradient;
    context.fillRect(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);

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

    const image = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    let hash = 0x811c9dc5;
    for (let i = 0; i < image.data.length; i += 1) {
        hash ^= image.data[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/** 裝置標籤＝機型（可讀）＋ canvas 指紋（辨識這台裝置），例如 SM-G991B-3k9v2xq */
export function deviceTag(canvas, userAgent) {
    const model = deviceModel(userAgent).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 10);
    const signature = deviceSignature(canvas);
    if (!signature) return model || "unknown";
    return model ? `${model}-${signature}` : signature;
}

/* 同一台裝置每次算出來都一樣，算一次就夠 */
let cachedTag = "";

/** 目前裝置的標籤（機型-指紋）；canvas 不可用時退回機型或 unknown。 */
export function currentDeviceTag() {
    if (!cachedTag) {
        cachedTag = deviceTag(document.createElement("canvas"), navigator?.userAgent ?? "");
    }
    return cachedTag;
}

/**
 * 開始在畫面上維持標記層。回傳停止函式。
 * @param {HTMLCanvasElement} canvas 疊在最上層的 canvas
 * @param {string} userId 目前使用者的 ID
 */
export function startScreenMark(canvas, userId) {
    if (!canvas) return () => {};

    const payload = markPayload(userId, currentDeviceTag());

    let timer = null;

    function draw() {
        const context = canvas.getContext("2d");
        if (!context) return;

        const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const width = Math.max(64, Math.round(window.innerWidth * ratio));
        const height = Math.max(64, Math.round(window.innerHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        const image = context.createImageData(width, height);
        const pixels = image.data;
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = MARK_BASE;
            pixels[i + 1] = MARK_BASE;
            pixels[i + 2] = MARK_BASE;
            pixels[i + 3] = 255;
        }
        if (!embedOverlayWatermark(pixels, width, height, payload)) {
            console.warn("畫面標記層沒有寫入（視窗太小）");
            return;
        }
        context.putImageData(image, 0, 0);
    }

    function schedule() {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            draw();
        }, 250);
    }

    canvas.style.opacity = String(MARK_OPACITY);
    draw();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);

    return () => {
        if (timer !== null) clearTimeout(timer);
        window.removeEventListener("resize", schedule);
        window.removeEventListener("orientationchange", schedule);
    };
}
