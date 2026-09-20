/* ==========================================================================
   取出圖片裡的盲水印
   --------------------------------------------------------------------------
   用法：
     node tools/watermark-decode.mjs 圖檔 [名單檔]
     node tools/watermark-decode.mjs leak.png members.txt

   圖檔可以是任何 ffmpeg 讀得懂的格式（png/jpg/webp…）。名單檔一行一個
   使用者 ID（房號成員名單），有的話會直接指出標記屬於誰；沒有的話只印出
   標記內容（指紋 + 日期）。

   兩種來源都會試：
   1. 文字（複製貼上的訊息、心事內文）→ 找零寬字元的隱形標記。副檔名是 .txt 或
      加了 --text 就直接當文字讀。
   2. 圖片（送進房間的圖片）→ 找像素裡的盲水印。

   取出只需要內容本身，不需要原圖。
   ========================================================================== */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SCALE_CANDIDATES,
    extractImageWatermark,
    extractTextMark,
    fingerprint,
} from "../assets/js/watermark.js";

const argv = process.argv.slice(2).filter((value) => value !== "--text");
const asText = process.argv.includes("--text") || /\.(txt|md|json)$/i.test(argv[0] ?? "");
const [imagePath, rosterPath] = argv;
if (!imagePath) {
    console.error("用法：node tools/watermark-decode.mjs 圖檔 [名單檔]");
    console.error("      node tools/watermark-decode.mjs --text 文字檔 [名單檔]");
    process.exit(2);
}
if (!existsSync(imagePath)) {
    console.error(`找不到檔案：${imagePath}`);
    process.exit(2);
}

/* 名單（一行一個使用者 ID）用來把指紋還原成是誰 */
function report(payload, how) {
    console.log(`結果：找到標記「${payload}」（${how}）`);
    const [tag, device] = payload.split(".");
    console.log(`  - 使用者 ID 指紋：${tag}`);
    console.log(`  - 裝置：${device || "unknown"}`);

    if (!rosterPath || !existsSync(rosterPath)) {
        console.log("提示：給一份成員名單檔，就能比對出這是誰的標記。");
        return;
    }
    const names = readFileSync(rosterPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    const matched = names.filter((name) => fingerprint(name).toString(36) === tag);
    console.log(matched.length > 0
        ? `  - 對應成員：${matched.join("、")}`
        : "  - 名單裡沒有人的指紋符合（可能不是名單上的人，或名單不完整）。");
}

if (asText) {
    const text = readFileSync(imagePath, "utf8");
    const payload = extractTextMark(text);
    console.log(`文字檔：${imagePath}（${Array.from(text).length} 個字元）`);
    if (!payload) {
        console.log("結果：沒有找到可辨識的標記。");
        console.log("可能原因：這段文字沒經過本系統，或零寬字元在中途被清掉了。");
        process.exit(1);
    }
    report(payload, "文字隱形標記");
    process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "wm-"));
const rawPath = join(work, "image.raw");

const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", imagePath], { encoding: "utf8" });
if (probe.status !== 0) {
    console.error(`讀不到圖片尺寸（需要 ffmpeg/ffprobe）：${probe.stderr ?? ""}`);
    process.exit(2);
}

const [width, height] = probe.stdout.trim().split(",").map(Number);
const converted = spawnSync("ffmpeg", ["-y", "-i", imagePath, "-f", "rawvideo", "-pix_fmt", "rgba", rawPath], { encoding: "utf8" });
if (converted.status !== 0) {
    console.error(`轉檔失敗：${converted.stderr ?? ""}`);
    process.exit(2);
}

/* 先把像素放大或縮小，再交給取出函式（格線要對回來） */
function resample(source, sourceWidth, sourceHeight, factor) {
    const targetWidth = Math.max(8, Math.round(sourceWidth * factor));
    const targetHeight = Math.max(8, Math.round(sourceHeight * factor));
    const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    for (let y = 0; y < targetHeight; y++) {
        const sourceY = Math.min(sourceHeight - 1, y / factor);
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(sourceHeight - 1, y0 + 1);
        const wy = sourceY - y0;
        for (let x = 0; x < targetWidth; x++) {
            const sourceX = Math.min(sourceWidth - 1, x / factor);
            const x0 = Math.floor(sourceX);
            const x1 = Math.min(sourceWidth - 1, x0 + 1);
            const wx = sourceX - x0;
            const at = (y * targetWidth + x) * 4;
            for (let channel = 0; channel < 4; channel++) {
                const top = source[(y0 * sourceWidth + x0) * 4 + channel] * (1 - wx) + source[(y0 * sourceWidth + x1) * 4 + channel] * wx;
                const bottom = source[(y1 * sourceWidth + x0) * 4 + channel] * (1 - wx) + source[(y1 * sourceWidth + x1) * 4 + channel] * wx;
                out[at + channel] = top * (1 - wy) + bottom * wy;
            }
        }
    }
    return { pixels: out, width: targetWidth, height: targetHeight };
}

const buffer = readFileSync(rawPath);
const pixels = new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
/* 倍率由近到遠試：被重新縮放過的圖片要先對回格線才解得開 */
let imagePayload = "";
let hitScale = 1;

for (const scale of SCALE_CANDIDATES) {
    if (scale !== 1) process.stdout.write(`嘗試倍率 ${scale}…\r`);
    const view = scale === 1 ? { pixels, width, height } : resample(pixels, width, height, scale);
    imagePayload = extractImageWatermark(view.pixels, view.width, view.height);
    if (imagePayload) {
        hitScale = scale;
        break;
    }
}
const payload = imagePayload;

console.log(`圖檔：${imagePath}（${width}x${height}）`);
if (!payload) {
    console.log("結果：沒有找到可辨識的標記。");
    console.log("可能原因：這張圖沒經過本系統、畫面太小、或是被裁切／縮圖／壓縮到失真。");
    process.exit(1);
}

report(payload, `圖片盲水印${hitScale !== 1 ? `，還原倍率 ${hitScale}` : ""}`);

process.exit(0);
