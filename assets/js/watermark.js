/* ==========================================================================
   頁面標記 - 整頁平鋪一層看不出來的小字，內容是明文（四行）
   --------------------------------------------------------------------------
   把明文畫成一張重複平鋪、旋轉 -20 度的小磚，當成整頁的 CSS 背景。透明度極低，
   正常瀏覽完全看不出來，不接任何事件、不影響排版，也沒有開關或說明。
   
   明文四行是「暱稱」「房號」「機型」「公網 IP」：拿到外洩截圖的人要的是「這是誰、
   在哪個房間、用什麼裝置、從哪裡」。機型來自 UA Client Hints（拿不到才解析 user
   agent，見 app.js 的 loadDeviceModel），IP 來自外部回顯服務（loadPublicIp）。

   為什麼是平鋪：這一層要解的是「截圖外流」。平鋪的好處是塗掉一塊還有幾十塊，
   被裁掉任何一角都還在。

   字重與字級是取捨：大字粗體在拉對比之後最好讀，但在這種透明度下「看得見的份量」
   是由墨跡面積決定的（不是顏色深淺），所以字越大越粗就越明顯。目前選 20px / 粗體，
   想要更不明顯就往下調這兩個數字，alpha 已經到底了。

   為什麼用 SVG 而不是 canvas：文字直接由 encodeURIComponent 帶進 data URL，
   不必等非同步繪圖、也不必量字寬，一行字串就結束。

   取出靠人眼，不需要程式：把截圖丟進任何修圖軟體，曲線拉高對比或套閾值
   （Threshold），四行字就會浮出來。

   這一層會跟著「畫面截圖」走，但不會跟著「圖片檔本身」走——送進房間的圖片
   下載下來是單純的 WebP，身上沒有這層。

   純函式，不碰 DOM（掛載在 app.js 的 installPageMark），所以要單獨測很容易。
   ========================================================================== */

import { escapeXml } from "./sanitize.js";

/*
 * 透明度旋鈕。它有一個硬下限：每次寫入是 8 bits，黑字壓在白底上要留得住差別，
 * 255 × alpha 就必須 ≥ 0.5（四捨五入成 1 階），也就是 alpha ≥ 0.002。
 *
 *   0.002 → 目前用這組。寫入後是 254 vs 255，就這 1 階
 *   0.003 → 也是 254 vs 255，跟 0.002 印出來一模一樣
 *   0.001 → 四捨五入回到 255，標記完全消失（不是變淡，是沒有了）
 *   0.008 → 差 2 階，拉對比好讀，二次壓縮也還有機會留下來
 *   0.02  → 純色區塊上看得出痕跡，已經算是看得見的浮水印
 *
 * 也就是說：再往下調不會更淡，只會直接消失。還嫌看得到的話，改的是「墨跡面積」
 * （字重、字級、每個磚放幾行），不是這個數字。
 */
export const MARK_ALPHA = 0.002;

/* 字級與字重：越大越粗，拉對比之後越好讀，但也越明顯 */
const FONT_SIZE = 20;
const FONT_WEIGHT = 700;

/*
 * 一行最多幾個「半形寬度」：非 ASCII 算 2，其餘算 1。磚寬 320、字級 20、
 * 置中對齊，24 個半形寬度（約 264px）轉完還留得下邊
 * （IPv4 最長 15 個半形寬度，塞得進去）。
 */
const MAX_ROW_UNITS = 24;

/* 磚一則放幾行：暱稱、房號、機型、IP（IP 拿不到時就是三行） */
const MAX_ROWS = 4;

/* 各行基線的位置（行距 46、磚高 280，整塊垂直置中） */
const ROW_Y = [86, 132, 178, 224];

/* 磚的尺寸：越小鋪得越密，但字也越小越容易被壓縮吃掉；
   寬高要能裝下四行、24 個半形寬度轉 -20 度之後的範圍（約 302×239px） */
const TILE_WIDTH = 320;
const TILE_HEIGHT = 280;
const TILE_ANGLE = -20;

/** 一行文字：清掉控制字元、去頭尾空白、依寬度限長，最後跳脫 XML 特殊字元 */
function cleanRow(value) {
    const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    const kept = [];
    let units = 0;
    for (const char of text) {
        const width = /[^\x00-\xff]/.test(char) ? 2 : 1;
        if (units + width > MAX_ROW_UNITS) break;
        units += width;
        kept.push(char);
    }
    return escapeXml(kept.join(""));
}

/**
 * 一則磚的 SVG，包成可直接餵給 CSS background-image 的 url()。
 * @param {string} text 明文，一行一個欄位（暱稱、房號、機型、IP）；空行不畫
 * @param {string} ink 字色：亮色主題用黑、暗色主題用白
 * @returns {string} 例如 url("data:image/svg+xml,%3Csvg...")
 */
export function pageMarkImage(text, ink = "#000") {
    let rows = String(text ?? "").split("\n").slice(0, MAX_ROWS).map(cleanRow).filter(Boolean);
    if (rows.length === 0) rows = ["unknown"];

    const centered = `rotate(${TILE_ANGLE} ${TILE_WIDTH / 2} ${TILE_HEIGHT / 2})`;
    const lines = rows.map((row, index) => `<text x="${TILE_WIDTH / 2}" y="${ROW_Y[index]}">${row}</text>`).join("");
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_WIDTH}" height="${TILE_HEIGHT}">` +
        `<g transform="${centered}" fill="${ink}" fill-opacity="${MARK_ALPHA}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="${FONT_SIZE}" font-weight="${FONT_WEIGHT}">` +
        `${lines}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

