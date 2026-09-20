/* ==========================================================================
   取出圖片裡的盲水印
   --------------------------------------------------------------------------
   用法：
     node tools/watermark-decode.mjs 圖檔 [名單檔]
     node tools/watermark-decode.mjs leak.png members.txt

   圖檔可以是任何 ffmpeg 讀得懂的格式（png/jpg/webp…）。名單檔一行一個
   使用者 ID（房號成員名單），有的話會直接指出標記屬於誰；沒有的話只印出
   標記內容（指紋 + 日期）。

   取出只是統計與比對，不需要原圖，但需要「同一張圖的完整像素」：重新裁切、
   大幅縮圖、或轉成過度壓縮的格式都可能讓標記失效（見 README）。
   ========================================================================== */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractImageWatermark, fingerprint } from "../assets/js/watermark.js";

const [imagePath, rosterPath] = process.argv.slice(2);
if (!imagePath) {
    console.error("用法：node tools/watermark-decode.mjs 圖檔 [名單檔]");
    process.exit(2);
}
if (!existsSync(imagePath)) {
    console.error(`找不到檔案：${imagePath}`);
    process.exit(2);
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

const buffer = readFileSync(rawPath);
const pixels = new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
const payload = extractImageWatermark(pixels, width, height);

console.log(`圖檔：${imagePath}（${width}x${height}）`);
if (!payload) {
    console.log("結果：沒有找到可辨識的標記。");
    console.log("可能原因：圖片被裁切或縮圖、被壓縮到失真、或是這張圖從來沒經過本系統。");
    process.exit(1);
}

console.log(`結果：找到標記「${payload}」`);
const [tag, day] = payload.split(".");
console.log(`  - 內容指紋：${tag}`);
if (day) {
    const date = new Date(Number.parseInt(day, 36) * 86400000);
    console.log(`  - 標記日期：${date.toISOString().slice(0, 10)}`);
}

if (!rosterPath || !existsSync(rosterPath)) {
    console.log("提示：給一份成員名單檔，就能比對出這是誰的標記。");
    process.exit(0);
}

const names = readFileSync(rosterPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const matched = names.filter((name) => fingerprint(name).toString(36) === tag);
if (matched.length > 0) {
    console.log(`  - 對應成員：${matched.join("、")}`);
} else {
    console.log("  - 名單裡沒有人的指紋符合（可能不是名單上的人，或名單不完整）。");
}
