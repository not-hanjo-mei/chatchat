/* ==========================================================================
   圖片盲水印 - 純函式，不依賴 DOM、canvas 或 Firebase
   --------------------------------------------------------------------------
   演算法照 guofei9987/blind_watermark 的核心（bwm_core.py）重寫成前端可用：
   RGB→YUV → 三個通道各做 Haar 小波 → 取低頻 cA（一半解析度）切 4x4 區塊 →
   區塊 DCT → 用密碼打亂 16 個係數 → SVD → 把最大的奇異值用 QIM 量化塞入一個
   位元 → 逆 SVD／逆 DCT／逆小波 → 回 RGB。

   為什麼用 QIM 而不是「兩個係數比大小」：QIM 把值對齊到固定間距的格子，取出
   時只看落在格子裡的哪一半，所以對重新壓縮、縮放、加亮度的容忍度高很多。位元
   在大量區塊與三個通道之間重複，取出時取多數決。

   取出時不需要原圖（盲水印），只需要同一套參數與密碼。

   相關檢查：node tools/selfcheck.mjs（純函式往返）
            node tools/watermark-roundtrip.mjs（真的過一次 WebP 壓縮）
   ========================================================================== */

const BLOCK_SIDE = 4;
const BLOCK_VALUES = BLOCK_SIDE * BLOCK_SIDE;

/* QIM 的量化間距。越大越耐壓縮，越大也越容易看出痕跡。 */
const STEP_MAIN = 36;
const STEP_SECOND = 20;

/* 低頻區塊的起伏門檻：低於它的區塊（大面積平色）不寫，避免出現方塊感。 */
const MIN_ACTIVITY = 6;

/* 固定長度的負載區塊：表頭 5 bytes + 最多 43 bytes 內容 = 48 bytes = 384 bits。
   長度固定，取出端才能在不先知道長度的情況下對齊位元。

   表頭刻意用 2 bytes 魔術數字 + 2 bytes 檢查碼：取出時會試 16 種格線相位與 384
   種位元位移（幾千次嘗試），表頭太短會出現「驗證過了、但內容是錯的旋轉」這種
   假陽性（真的發生過）。 */
const MAGIC = [0xa5, 0x5a];
const HEADER_BYTES = 5;
const BLOCK_BYTES = 48;
const BLOCK_BITS = BLOCK_BYTES * 8;
export const PAYLOAD_MAX = BLOCK_BYTES - HEADER_BYTES;

/* 打亂係數用的種子。公開在原始碼裡，只影響圖形樣式，不當成秘密。 */
const SHUFFLE_SEED = 0x9e3779b9;

/* ---------------- 負載編碼 ---------------- */

/** 32 位元指紋（FNV-1a）。取出端用同一函式比對名單，找出是誰留下的。 */
export function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (const char of String(text)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/**
 * 標記內容：使用者 ID 的指紋 + 設備型號。
 * 指紋是把 ID 壓成 6~7 個 base36 字元（32 位元），長度短才塞得進圖片與頁面標記；
 * 取出後用 tools/watermark-decode.mjs 比對成員名單就能還原成是誰。
 */
export function markPayload(userId, device = "unknown") {
    const tag = String(device ?? "").replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 20) || "unknown";
    return `${fingerprint(userId).toString(36)}.${tag}`.slice(0, PAYLOAD_MAX);
}

/** 16 位元檢查碼（FNV-1a 取低 16 位）。取出時會試幾千種相位與位移，
    表頭不夠長就會出現「驗證過但內容是錯的」這種假陽性，所以檢查碼不能省。 */
function checksum16(bytes) {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash & 0xffff;
}

/** 負載 → 位元陣列（固定 BLOCK_BITS 長）；不合格式回 null */
function payloadBits(payload) {
    const encoded = new TextEncoder().encode(String(payload));
    if (encoded.length === 0 || encoded.length > PAYLOAD_MAX) return null;
    for (const byte of encoded) {
        if (byte < 0x20 || byte > 0x7e) return null;
    }

    const block = new Uint8Array(BLOCK_BYTES);
    block[0] = MAGIC[0];
    block[1] = MAGIC[1];
    block[2] = encoded.length;
    const check = checksum16(encoded);
    block[3] = check >> 8;
    block[4] = check & 0xff;
    block.set(encoded, HEADER_BYTES);

    const bits = new Uint8Array(BLOCK_BITS);
    for (let i = 0; i < BLOCK_BITS; i++) bits[i] = (block[i >> 3] >> (7 - (i & 7))) & 1;
    return bits;
}

/** 位元陣列 → 負載字串；表頭或檢查碼不符就回空字串 */
function bitsToPayload(bits) {
    const block = new Uint8Array(BLOCK_BYTES);
    for (let i = 0; i < BLOCK_BITS; i++) block[i >> 3] |= bits[i] << (7 - (i & 7));
    if (block[0] !== MAGIC[0] || block[1] !== MAGIC[1]) return "";

    const length = block[2];
    if (length === 0 || length > PAYLOAD_MAX) return "";

    const payload = block.slice(HEADER_BYTES, HEADER_BYTES + length);
    const expected = (block[3] << 8) | block[4];
    return checksum16(payload) === expected ? String.fromCharCode(...payload) : "";
}

/*
 * 位元怎麼對應到區塊：把整串位元排成 16x24 的磚，鋪滿整張圖。
 * 這樣「旁邊被加了東西」「被裁掉一塊」「整體位移」都只是讓磚的起點移動，
 * 解碼端搜尋 384 種 2D 位移就能對回來——不能像連續序號那樣一位移就全毀。
 */
const TILE_COLUMNS = 24;
const TILE_ROWS = BLOCK_BITS / TILE_COLUMNS;

function tileSlot(row, column) {
    return (row % TILE_ROWS) * TILE_COLUMNS + (column % TILE_COLUMNS);
}

/** 從「槽位 → 票數」統計出負載：多數決後試所有 2D 位移，表頭會擋掉錯的位移 */
function readTiledPayload(ones, counts) {
    const bits = new Uint8Array(BLOCK_BITS);
    for (let i = 0; i < BLOCK_BITS; i++) {
        bits[i] = counts[i] > 0 && ones[i] * 2 > counts[i] ? 1 : 0;
    }

    const candidate = new Uint8Array(BLOCK_BITS);
    for (let shiftRow = 0; shiftRow < TILE_ROWS; shiftRow++) {
        for (let shiftColumn = 0; shiftColumn < TILE_COLUMNS; shiftColumn++) {
            for (let row = 0; row < TILE_ROWS; row++) {
                for (let column = 0; column < TILE_COLUMNS; column++) {
                    candidate[row * TILE_COLUMNS + column] =
                        bits[((row + shiftRow) % TILE_ROWS) * TILE_COLUMNS + ((column + shiftColumn) % TILE_COLUMNS)];
                }
            }
            const payload = bitsToPayload(candidate);
            if (payload) return payload;
        }
    }
    return "";
}

/* ---------------- 小工具 ---------------- */

function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/* 所有區塊共用同一組係數順序。亂序後再取 SVD，等於把能量平均分散到所有係數，
   這樣 s[0] 不會永遠對應同一個 DCT 係數，重新壓縮時比較難整批被削掉。
   刻意不用「每區塊一組」：位置無關的順序讓寫入與取出的區塊順序不易因為排版而錯開。 */
const ORDER = (() => {
    const random = mulberry32(SHUFFLE_SEED);
    const keys = new Float64Array(BLOCK_VALUES);
    const indices = Array.from({ length: BLOCK_VALUES }, (_, index) => index);
    for (let i = 0; i < BLOCK_VALUES; i++) keys[i] = random();
    indices.sort((a, b) => keys[a] - keys[b] || a - b);
    return Uint8Array.from(indices);
})();

/* ---------------- YUV ---------------- */

function toYuv(pixels, width, height) {
    const size = width * height;
    const planes = [new Float32Array(size), new Float32Array(size), new Float32Array(size)];
    for (let i = 0; i < size; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        planes[0][i] = y;
        planes[1][i] = 0.492 * (b - y) + 128;
        planes[2][i] = 0.877 * (r - y) + 128;
    }
    return planes;
}

function fromYuv(planes, pixels, width, height) {
    const size = width * height;
    for (let i = 0; i < size; i++) {
        const y = planes[0][i];
        const u = planes[1][i] - 128;
        const v = planes[2][i] - 128;
        pixels[i * 4] = Math.max(0, Math.min(255, y + 1.14 * v));
        pixels[i * 4 + 1] = Math.max(0, Math.min(255, y - 0.395 * u - 0.581 * v));
        pixels[i * 4 + 2] = Math.max(0, Math.min(255, y + 2.032 * u));
        pixels[i * 4 + 3] = 255;
    }
}

/* ---------------- Haar 小波 ---------------- */

/** 正向：回傳 {low, high} ；low 是低頻（長寬各一半），high 是三種高頻細節 */
function haarForward(plane, width, height) {
    const paddedWidth = width + (width % 2);
    const paddedHeight = height + (height % 2);
    const halfWidth = paddedWidth / 2;
    const halfHeight = paddedHeight / 2;
    const at = (x, y) => (x >= width || y >= height ? 0 : plane[y * width + x]);

    const low = new Float32Array(halfWidth * halfHeight);
    const detail = new Float32Array(halfWidth * halfHeight * 3);

    for (let y = 0; y < halfHeight; y++) {
        for (let x = 0; x < halfWidth; x++) {
            const a = at(x * 2, y * 2);
            const b = at(x * 2 + 1, y * 2);
            const c = at(x * 2, y * 2 + 1);
            const d = at(x * 2 + 1, y * 2 + 1);
            const index = y * halfWidth + x;
            low[index] = (a + b + c + d) / 4;
            detail[index] = (a - b + c - d) / 4;
            detail[halfWidth * halfHeight + index] = (a + b - c - d) / 4;
            detail[2 * halfWidth * halfHeight + index] = (a - b - c + d) / 4;
        }
    }
    return { low, detail, halfWidth, halfHeight };
}

/** 反向：只用（可能被改過的）低頻與原本的高頻重建 */
function haarInverse(low, detail, width, height) {
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(height / 2);
    const plane = new Float32Array(width * height);
    const quarter = halfWidth * halfHeight;
    const lowAt = (x, y) => (x < halfWidth && y < halfHeight ? low[y * halfWidth + x] : 0);

    for (let y = 0; y < halfHeight; y++) {
        for (let x = 0; x < halfWidth; x++) {
            const index = y * halfWidth + x;
            const l = lowAt(x, y);
            const h = detail[index];
            const v = detail[quarter + index];
            const d = detail[2 * quarter + index];
            const a = l + h + v + d;
            const b = l - h + v - d;
            const c = l + h - v - d;
            const e = l - h - v + d;
            if (x * 2 < width) {
                if (y * 2 < height) plane[(y * 2) * width + x * 2] = a;
                if (y * 2 + 1 < height) plane[(y * 2 + 1) * width + x * 2] = c;
            }
            if (x * 2 + 1 < width) {
                if (y * 2 < height) plane[(y * 2) * width + x * 2 + 1] = b;
                if (y * 2 + 1 < height) plane[(y * 2 + 1) * width + x * 2 + 1] = e;
            }
        }
    }
    return plane;
}

/* ---------------- 4x4 DCT ---------------- */

function makeTable(size) {
    const table = new Float64Array(size * size);
    for (let u = 0; u < size; u++) {
        const scale = u === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
        for (let x = 0; x < size; x++) {
            table[u * size + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) * scale;
        }
    }
    return table;
}

const TABLE4 = makeTable(4);
const TABLE8 = makeTable(8);

function transformSize(source, out, size, table, inverse) {
    const scratch = new Float64Array(size * size);
    for (let row = 0; row < size; row++) {
        for (let k = 0; k < size; k++) {
            let sum = 0;
            for (let i = 0; i < size; i++) {
                sum += inverse
                    ? source[row * size + i] * table[i * size + k]
                    : source[row * size + i] * table[k * size + i];
            }
            scratch[row * size + k] = sum;
        }
    }
    for (let column = 0; column < size; column++) {
        for (let k = 0; k < size; k++) {
            let sum = 0;
            for (let i = 0; i < size; i++) {
                sum += inverse
                    ? scratch[i * size + column] * table[i * size + k]
                    : scratch[i * size + column] * table[k * size + i];
            }
            out[k * size + column] = sum;
        }
    }
}

/** 4x4 正交 DCT（圖片盲水印的區塊用） */
function blockTransform(source, out, inverse) {
    transformSize(source, out, BLOCK_SIDE, TABLE4, inverse);
}

/* ---------------- 4x4 SVD（單邊 Jacobi） ---------------- */

const svdU = new Float64Array(BLOCK_VALUES);
const svdV = new Float64Array(BLOCK_VALUES);
const svdS = new Float64Array(BLOCK_SIDE);

function svd4(matrix) {
    const a = Float64Array.from(matrix);
    const v = new Float64Array(BLOCK_VALUES);
    for (let i = 0; i < BLOCK_SIDE; i++) v[i * BLOCK_SIDE + i] = 1;

    for (let sweep = 0; sweep < 12; sweep++) {
        let offDiagonal = 0;
        for (let p = 0; p < BLOCK_SIDE; p++) {
            for (let q = p + 1; q < BLOCK_SIDE; q++) {
                let pp = 0;
                let qq = 0;
                let pq = 0;
                for (let i = 0; i < BLOCK_SIDE; i++) {
                    const left = a[i * BLOCK_SIDE + p];
                    const right = a[i * BLOCK_SIDE + q];
                    pp += left * left;
                    qq += right * right;
                    pq += left * right;
                }
                offDiagonal += pq * pq;
                if (pq === 0 || Math.abs(pq) < 1e-12 * Math.sqrt(pp * qq)) continue;

                const zeta = (qq - pp) / (2 * pq);
                const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
                const c = 1 / Math.sqrt(1 + t * t);
                const s = c * t;

                for (let i = 0; i < BLOCK_SIDE; i++) {
                    const left = a[i * BLOCK_SIDE + p];
                    const right = a[i * BLOCK_SIDE + q];
                    a[i * BLOCK_SIDE + p] = c * left - s * right;
                    a[i * BLOCK_SIDE + q] = s * left + c * right;

                    const vl = v[i * BLOCK_SIDE + p];
                    const vr = v[i * BLOCK_SIDE + q];
                    v[i * BLOCK_SIDE + p] = c * vl - s * vr;
                    v[i * BLOCK_SIDE + q] = s * vl + c * vr;
                }
            }
        }
        if (offDiagonal < 1e-18) break;
    }

    const order = Array.from({ length: BLOCK_SIDE }, (_, index) => index);
    for (let j = 0; j < BLOCK_SIDE; j++) {
        let sum = 0;
        for (let i = 0; i < BLOCK_SIDE; i++) sum += a[i * BLOCK_SIDE + j] * a[i * BLOCK_SIDE + j];
        svdS[j] = Math.sqrt(sum);
    }
    order.sort((left, right) => svdS[right] - svdS[left]);

    for (let column = 0; column < BLOCK_SIDE; column++) {
        const source = order[column];
        const scale = svdS[source] > 1e-12 ? 1 / svdS[source] : 0;
        for (let i = 0; i < BLOCK_SIDE; i++) {
            svdU[i * BLOCK_SIDE + column] = a[i * BLOCK_SIDE + source] * scale;
            svdV[i * BLOCK_SIDE + column] = v[i * BLOCK_SIDE + source];
        }
        svdS[column] = svdS[source];
    }
    return { u: svdU, s: svdS, v: svdV };
}

/** 由 U、s、V 重組矩陣 */
function svdRebuild(u, s, v, out) {
    for (let i = 0; i < BLOCK_SIDE; i++) {
        for (let j = 0; j < BLOCK_SIDE; j++) {
            let sum = 0;
            for (let k = 0; k < BLOCK_SIDE; k++) sum += u[i * BLOCK_SIDE + k] * s[k] * v[j * BLOCK_SIDE + k];
            out[i * BLOCK_SIDE + j] = sum;
        }
    }
}

/** 把奇異值對齊到間距 step 的格子，落在前半或後半代表 0 或 1 */
function quantize(value, step, bit) {
    return (Math.floor(value / step) + 0.25 + 0.5 * bit) * step;
}

/* ---------------- 區塊走訪 ---------------- */

function blockLayout(width, height) {
    const halfWidth = Math.ceil(width / 2);
    const halfHeight = Math.ceil(height / 2);
    return {
        halfWidth,
        halfHeight,
        columns: Math.floor(halfWidth / BLOCK_SIDE),
        rows: Math.floor(halfHeight / BLOCK_SIDE),
    };
}

/** 低頻區塊的起伏程度。太平的區塊寫入標記會看得出來，寫入與取出都跳過。 */
function blockActivity(low, halfWidth, row, column) {
    let sum = 0;
    for (let i = 0; i < BLOCK_VALUES; i++) {
        sum += low[(row * BLOCK_SIDE + Math.floor(i / BLOCK_SIDE)) * halfWidth + column * BLOCK_SIDE + (i % BLOCK_SIDE)];
    }
    const mean = sum / BLOCK_VALUES;
    let variance = 0;
    for (let i = 0; i < BLOCK_VALUES; i++) {
        const value = low[(row * BLOCK_SIDE + Math.floor(i / BLOCK_SIDE)) * halfWidth + column * BLOCK_SIDE + (i % BLOCK_SIDE)] - mean;
        variance += value * value;
    }
    return Math.sqrt(variance / BLOCK_VALUES);
}

/** 雙線性縮放（取出端掃描倍率用；不需要高品質，只需要可預期） */
function rescale(pixels, width, height, factor) {
    const targetWidth = Math.max(8, Math.round(width * factor));
    const targetHeight = Math.max(8, Math.round(height * factor));
    const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);

    for (let y = 0; y < targetHeight; y++) {
        const sourceY = Math.min(height - 1, y / factor);
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(height - 1, y0 + 1);
        const wy = sourceY - y0;
        for (let x = 0; x < targetWidth; x++) {
            const sourceX = Math.min(width - 1, x / factor);
            const x0 = Math.floor(sourceX);
            const x1 = Math.min(width - 1, x0 + 1);
            const wx = sourceX - x0;
            const at = (y * targetWidth + x) * 4;
            for (let channel = 0; channel < 4; channel++) {
                const top = pixels[(y0 * width + x0) * 4 + channel] * (1 - wx) + pixels[(y0 * width + x1) * 4 + channel] * wx;
                const bottom = pixels[(y1 * width + x0) * 4 + channel] * (1 - wx) + pixels[(y1 * width + x1) * 4 + channel] * wx;
                out[at + channel] = top * (1 - wy) + bottom * wy;
            }
        }
    }
    return { pixels: out, width: targetWidth, height: targetHeight };
}

/*
 * 取出時要掃的倍率。標記本身在 0.9x~1.06x 之間都還在（實測），但格線必須對得
 * 夠準才解得開：8 像素的格子只要縮放誤差 0.5%，跨一張圖就會漂掉半格。所以候選
 * 倍率要密（每 0.5% 一個），由近到遠排序，常見情況第一次就中。
 */
export const SCALE_CANDIDATES = (() => {
    const near = [];
    for (let step = 1; step <= 12; step += 1) {
        const offset = step * 0.005;
        near.push(Number((1 - offset).toFixed(4)), Number((1 + offset).toFixed(4)));
    }
    near.sort((left, right) => Math.abs(left - 1) - Math.abs(right - 1));

    const far = [0.9, 1.1, 0.85, 1.15, 0.8, 1.25, 0.75, 1.33, 0.67, 1.5, 0.5, 2];
    return [1, ...near.filter((value) => Math.abs(value - 1) > 0.005), ...far];
})();

function blockCount(width, height) {
    const layout = blockLayout(width, height);
    return layout.columns * layout.rows;
}

/* ---------------- 對外介面 ---------------- */

/**
 * 把標記寫進 RGBA 像素（就地改寫）。
 * @returns {boolean} 是否寫進去（圖太小或負載不合法就不寫）
 */
export function embedImageWatermark(pixels, width, height, payload, { stepMain = STEP_MAIN, stepSecond = STEP_SECOND, minActivity = MIN_ACTIVITY } = {}) {
    if (blockCount(width, height) < BLOCK_BITS) return false;
    const bits = payloadBits(payload);
    if (!bits) return false;

    const planes = toYuv(pixels, width, height);
    const layout = blockLayout(width, height);
    const permuted = new Float64Array(BLOCK_VALUES);
    let written = 0;

    for (const plane of planes) {
        const { low, detail } = haarForward(plane, width, height);
        const coeff = new Float64Array(BLOCK_VALUES);
        const shuffled = new Float64Array(BLOCK_VALUES);
        const rebuilt = new Float64Array(BLOCK_VALUES);

        for (let row = 0; row < layout.rows; row++) {
            for (let column = 0; column < layout.columns; column++) {
                const index = row * layout.columns + column;
                if (minActivity && blockActivity(low, layout.halfWidth, row, column) < minActivity) continue;

                for (let i = 0; i < BLOCK_VALUES; i++) {
                    coeff[i] = low[(row * BLOCK_SIDE + Math.floor(i / BLOCK_SIDE)) * layout.halfWidth + column * BLOCK_SIDE + (i % BLOCK_SIDE)];
                }
                blockTransform(coeff, shuffled, false);
                for (let i = 0; i < BLOCK_VALUES; i++) permuted[i] = shuffled[ORDER[i]];

                const { u, s, v } = svd4(permuted);
                const bit = bits[tileSlot(row, column)];
                s[0] = quantize(s[0], stepMain, bit);
                if (stepSecond) s[1] = quantize(s[1], stepSecond, bit);
                svdRebuild(u, s, v, permuted);

                for (let i = 0; i < BLOCK_VALUES; i++) shuffled[ORDER[i]] = permuted[i];
                blockTransform(shuffled, rebuilt, true);

                for (let i = 0; i < BLOCK_VALUES; i++) {
                    low[(row * BLOCK_SIDE + Math.floor(i / BLOCK_SIDE)) * layout.halfWidth + column * BLOCK_SIDE + (i % BLOCK_SIDE)] = rebuilt[i];
                }
                written += 1;
            }
        }

        const restored = haarInverse(low, detail, width, height);
        for (let i = 0; i < plane.length; i++) plane[i] = restored[i];
    }

    fromYuv(planes, pixels, width, height);
    return written >= BLOCK_BITS;
}

/**
 * 從 RGBA 像素取回標記。
 * @returns {string} 標記字串；取不到就回空字串
 */
export function extractImageWatermark(pixels, width, height, { stepMain = STEP_MAIN, stepSecond = STEP_SECOND, minActivity = MIN_ACTIVITY, scales = [1] } = {}) {
    for (const scale of scales) {
        const view = scale === 1 ? { pixels, width, height } : rescale(pixels, width, height, scale);
        const payload = extractImageWatermarkOnce(view.pixels, view.width, view.height, { stepMain, stepSecond, minActivity });
        if (payload) return payload;
    }
    return "";
}

function extractImageWatermarkOnce(pixels, width, height, { stepMain, stepSecond, minActivity }) {
    if (blockCount(width, height) < BLOCK_BITS) return "";

    const planes = toYuv(pixels, width, height);
    const layout = blockLayout(width, height);
    const ones = new Float64Array(BLOCK_BITS);
    const counts = new Float64Array(BLOCK_BITS);
    const permuted = new Float64Array(BLOCK_VALUES);

    for (const plane of planes) {
        const { low } = haarForward(plane, width, height);
        const coeff = new Float64Array(BLOCK_VALUES);
        const shuffled = new Float64Array(BLOCK_VALUES);

        for (let row = 0; row < layout.rows; row++) {
            for (let column = 0; column < layout.columns; column++) {
                if (minActivity && blockActivity(low, layout.halfWidth, row, column) < minActivity) continue;

                for (let i = 0; i < BLOCK_VALUES; i++) {
                    coeff[i] = low[(row * BLOCK_SIDE + Math.floor(i / BLOCK_SIDE)) * layout.halfWidth + column * BLOCK_SIDE + (i % BLOCK_SIDE)];
                }
                blockTransform(coeff, shuffled, false);
                for (let i = 0; i < BLOCK_VALUES; i++) permuted[i] = shuffled[ORDER[i]];

                const { s } = svd4(permuted);
                let vote = s[0] % stepMain > stepMain / 2 ? 1 : 0;
                if (stepSecond) {
                    const second = s[1] % stepSecond > stepSecond / 2 ? 1 : 0;
                    vote = (vote * 3 + second) / 4;
                }

                const slot = tileSlot(row, column);
                ones[slot] += vote;
                counts[slot] += 1;
            }
        }
    }

    return readTiledPayload(ones, counts);
}

/* ==========================================================================
   文字用的隱形標記
   --------------------------------------------------------------------------
   訊息文字裡插入零寬字元（看不見、不影響排版），把「使用者 ID 指紋 ＋ 裝置簽章」
   藏進去。人類外流最省事的做法是複製貼上，那條路會把這些字元一起帶走，事後用
   tools/watermark-decode.mjs 貼回去就能知道是誰。

   每個字元帶 2 bits，用四個零寬字元輪替；同一段文字會重複寫幾份，取出時逐位元
   多數決。標記只在畫面渲染時插入，資料庫裡存的原字串不變。
   ========================================================================== */

const TEXT_SYMBOLS = ["\u200b", "\u200c", "\u200d", "\u2060"];
const TEXT_SYMBOL_INDEX = new Map(TEXT_SYMBOLS.map((char, index) => [char, index]));

/*
 * 標記放在「文字的結尾」，長訊息再多放一份在中段的空白／標點後面。
 * 刻意不插在每個字元之間：那樣會讓「hello via button」這種相連字串都對不上，
 * 瀏覽器搜尋、程式比對全部失效。放在句尾則完全看不到也不影響搜尋，
 * 複製整段訊息時標記一定會跟著走。
 */
export function embedTextMark(text, payload) {
    const bits = payloadBits(payload);
    const source = String(text ?? "");
    const chars = Array.from(source);
    if (!bits || chars.length === 0) return source;

    const symbols = [];
    for (let i = 0; i < BLOCK_BITS; i += 2) {
        symbols.push(TEXT_SYMBOLS[bits[i] * 2 + bits[i + 1]]);
    }
    const block = symbols.join("");

    /* 插入點：0 代表開頭，chars.length 代表結尾，其餘是某個字元之後 */
    const breaks = [];
    for (let i = 0; i < chars.length - 1; i += 1) {
        if (/[\s、。，！？；：,.!?;:]/.test(chars[i])) breaks.push(i + 1);
    }

    const points = [chars.length];
    if (chars.length > 240 && breaks.length > 0) points.push(breaks[Math.floor(breaks.length / 2)]);

    const groups = new Map();
    for (const point of points) {
        groups.set(point, (groups.get(point) ?? "") + block);
    }

    let out = "";
    for (let i = 0; i <= chars.length; i += 1) {
        if (groups.has(i)) out += groups.get(i);
        if (i < chars.length) out += chars[i];
    }
    return out;
}

/** 從文字裡取回標記；取不到就回空字串 */
export function extractTextMark(text) {
    const values = [];
    for (const char of Array.from(String(text ?? ""))) {
        const index = TEXT_SYMBOL_INDEX.get(char);
        if (index !== undefined) values.push(index);
    }

    const symbolsPerCopy = BLOCK_BITS / 2;
    const copies = Math.floor(values.length / symbolsPerCopy);
    if (copies === 0) return "";

    const ones = new Float64Array(BLOCK_BITS);
    const counts = new Float64Array(BLOCK_BITS);
    for (let copy = 0; copy < copies; copy += 1) {
        for (let i = 0; i < symbolsPerCopy; i += 1) {
            const value = values[copy * symbolsPerCopy + i];
            const first = value >> 1;
            const second = value & 1;
            ones[copy * 0 + 2 * i] += first;
            counts[2 * i] += 1;
            ones[2 * i + 1] += second;
            counts[2 * i + 1] += 1;
        }
    }

    const bits = new Uint8Array(BLOCK_BITS);
    for (let i = 0; i < BLOCK_BITS; i += 1) {
        bits[i] = counts[i] > 0 && ones[i] * 2 > counts[i] ? 1 : 0;
    }
    return bitsToPayload(bits);
}
