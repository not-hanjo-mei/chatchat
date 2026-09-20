/* ==========================================================================
   圖片盲水印的真實往返測試
   --------------------------------------------------------------------------
   純函式的往返在 tools/selfcheck.mjs 裡驗；這支負責跑真的編碼器：
   產生原圖 → 寫入標記 → WebP 壓縮 → 解回來 → 取標記，另外量 SSIM 確認肉眼看
   不出來。需要 ffmpeg 與 cwebp（Termux: pkg install ffmpeg webp）。

   node tools/watermark-roundtrip.mjs
   ========================================================================== */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    embedImageWatermark,
    embedTextMark,
    extractImageWatermark,
    extractTextMark,
    markPayload,
} from "../assets/js/watermark.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(repo, "..", "_tmp", "watermark");
mkdirSync(work, { recursive: true });

const WIDTH = 640;
const HEIGHT = 480;
const payload = markPayload("user_mayo_audit");
const file = (name) => join(work, name);

let failures = 0;
function check(name, ok, detail = "") {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} 失敗：${result.stderr ?? ""}`);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function has(command) {
    return spawnSync(command, ["-version"], { encoding: "utf8" }).error === undefined;
}

if (!has("ffmpeg") || !has("cwebp")) {
    console.log("SKIP  需要 ffmpeg 與 cwebp 才能跑真實壓縮往返");
    process.exit(0);
}

/* 影像內容刻意混三種性質：平色區（會被跳過）、規則紋理、隨機雜訊，
   接近手機照片被縮圖後的樣子。 */
function makeImage() {
    const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    let seed = 20260920;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const at = (y * WIDTH + x) * 4;
            const sky = 90 + 70 * Math.sin(x / 40) * Math.cos(y / 55);
            const grid = x % 37 < 6 || y % 43 < 6 ? 40 : 0;
            const noise = rnd() * 45;
            pixels[at] = sky + grid + noise;
            pixels[at + 1] = sky * 0.85 + grid + noise;
            pixels[at + 2] = sky * 0.6 + 30 + noise;
            pixels[at + 3] = 255;
        }
    }
    return pixels;
}

function rawToPng(rawName, pngName) {
    run("ffmpeg", ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-i", file(rawName), "-frames:v", "1", file(pngName)]);
}

function pngToRaw(pngName, rawName) {
    run("ffmpeg", ["-y", "-i", file(pngName), "-f", "rawvideo", "-pix_fmt", "rgba", file(rawName)]);
    const buffer = readFileSync(file(rawName));
    return new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function pngToRawRaw(name) {
    run("ffmpeg", ["-y", "-i", file(name), "-f", "rawvideo", "-pix_fmt", "rgba", file("shot-back.raw")]);
    const buffer = readFileSync(file("shot-back.raw"));
    return new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function writeRaw(pixels, name) {
    writeFileSync(file(name), Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
}

const original = makeImage();
const watermarked = Uint8ClampedArray.from(original);

check("標記寫得進去", embedImageWatermark(watermarked, WIDTH, HEIGHT, payload), payload);
check("未壓縮時取得回原標記", extractImageWatermark(watermarked, WIDTH, HEIGHT) === payload);

writeRaw(original, "original.raw");
writeRaw(watermarked, "watermarked.raw");
rawToPng("original.raw", "original.png");
rawToPng("watermarked.raw", "watermarked.png");

/* 1. 肉眼看不看得出來。這張測試圖刻意塞滿高頻雜訊（SSIM 的嚴苛情境），
      換成一般照片量到的是 0.986 左右；門檻抓 0.97 是保守值。 */
{
    const output = run("ffmpeg", ["-i", file("original.png"), "-i", file("watermarked.png"), "-lavfi", "ssim", "-f", "null", "-"]);
    const match = output.match(/All:([0-9.]+)/);
    const ssim = match ? Number(match[1]) : 0;
    check("標記後肉眼幾乎看不出來（SSIM >= 0.97）", ssim >= 0.97, `SSIM ${ssim}`);
}

/* 2. 過一次 WebP 壓縮（跟 App 上傳時用的品質一樣） */
run("cwebp", ["-q", "82", "-m", "6", "-metadata", "none", file("watermarked.png"), "-o", file("watermarked.webp")]);
run("dwebp", [file("watermarked.webp"), "-o", file("after-webp.png")]);
{
    const decoded = pngToRaw("after-webp.png", "after-webp.raw");
    check("WebP q82 壓縮後仍取得回標記", extractImageWatermark(decoded, WIDTH, HEIGHT) === payload);
}

/* 3. 已知的限制：調整尺寸與裁切會讓標記失效（區塊格線對不上）。
      這裡只觀察、不當成失敗，避免把限制誤當成回歸。 */
{
    run("ffmpeg", ["-y", "-i", file("after-webp.png"), "-vf", `scale=${WIDTH / 2}:${HEIGHT / 2}`, file("half.png")]);
    const half = pngToRaw("half.png", "half.raw");
    console.log(`INFO  縮一半後：${extractImageWatermark(half, WIDTH / 2, HEIGHT / 2) === payload ? "還取得回" : "取不回（已知限制）"}`);

    const cropWidth = Math.floor((WIDTH * 0.7) / 8) * 8;
    const cropHeight = Math.floor((HEIGHT * 0.7) / 8) * 8;
    run("ffmpeg", ["-y", "-i", file("after-webp.png"), "-vf", `crop=${cropWidth}:${cropHeight}`, file("crop.png")]);
    const cropped = pngToRaw("crop.png", "crop.raw");
    console.log(`INFO  裁掉 30% 後：${extractImageWatermark(cropped, cropWidth, cropHeight) === payload ? "還取得回" : "取不回（已知限制）"}`);
}

/* 5. 對照組：沒寫標記的圖不該吐出東西 */
{
    const clean = pngToRaw("original.png", "original-raw.raw");
    check("沒寫標記的圖取不到標記", extractImageWatermark(clean, WIDTH, HEIGHT) === "");
}

/* 6. 文字隱形標記：複製貼上（含前後被加了別的字）之後仍取回 */
{
    const textPayload = markPayload("user_mayo_audit", "SM-G991B-text");
    const message = "明天下午三點在舊地方見，記得帶傘。";
    const marked = embedTextMark(message, textPayload);
    check("文字標記寫得進去且取出內容一致", extractTextMark(marked) === textPayload);

    const visible = marked.replace(/[\u200b\u200c\u200d\u2060]/g, "");
    check("文字標記不改變看得見的內容", visible === message, visible);

    /* 模擬外流：整段被貼進別的檔案，前後還有別人的話 */
    const pasted = `[轉傳] 阿明說：${marked}\n（以上）`;
    check("被貼到別的檔案、前後加了字之後仍取得回", extractTextMark(pasted) === textPayload);
    check("乾淨的文字不會誤判", extractTextMark(`${message}\n（以上）`) === "");
}

console.log(failures === 0 ? "\n全部通過" : `\n${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
