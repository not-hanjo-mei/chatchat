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

/* 固定長度的負載區塊：表頭 3 bytes + 最多 13 bytes 內容 = 16 bytes = 128 bits。
   長度固定，取出端才能在不先知道長度的情況下對齊位元。 */
const MAGIC = 0xa5;
const PAYLOAD_MAX = 13;
const BLOCK_BYTES = 16;
const BLOCK_BITS = BLOCK_BYTES * 8;

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

/** 標記內容：指紋 + 日期（base36 天數），最多 13 個可列印 ASCII 字元。 */
export function markPayload(userId, now = Date.now()) {
    const day = Math.floor(now / 86400000).toString(36);
    return `${fingerprint(userId).toString(36)}.${day}`.slice(0, PAYLOAD_MAX);
}

/** 負載 → 位元陣列（固定 BLOCK_BITS 長）；不合格式回 null */
function payloadBits(payload) {
    const encoded = new TextEncoder().encode(String(payload));
    if (encoded.length === 0 || encoded.length > PAYLOAD_MAX) return null;
    for (const byte of encoded) {
        if (byte < 0x20 || byte > 0x7e) return null;
    }

    const block = new Uint8Array(BLOCK_BYTES);
    block[0] = MAGIC;
    block[1] = encoded.length;
    block[2] = encoded.reduce((sum, byte) => (sum + byte) & 0xff, 0);
    block.set(encoded, 3);

    const bits = new Uint8Array(BLOCK_BITS);
    for (let i = 0; i < BLOCK_BITS; i++) bits[i] = (block[i >> 3] >> (7 - (i & 7))) & 1;
    return bits;
}

/** 位元陣列 → 負載字串；表頭或檢查碼不符就回空字串 */
function bitsToPayload(bits) {
    const block = new Uint8Array(BLOCK_BYTES);
    for (let i = 0; i < BLOCK_BITS; i++) block[i >> 3] |= bits[i] << (7 - (i & 7));
    if (block[0] !== MAGIC) return "";

    const length = block[1];
    if (length === 0 || length > PAYLOAD_MAX) return "";

    const payload = block.slice(3, 3 + length);
    const checksum = payload.reduce((sum, byte) => (sum + byte) & 0xff, 0);
    return checksum === block[2] ? String.fromCharCode(...payload) : "";
}

/** 多數決：同一個位元被寫進很多區塊與三個通道，票多的贏 */
function majorityBits(ones, counts) {
    const bits = new Uint8Array(BLOCK_BITS);
    for (let i = 0; i < BLOCK_BITS; i++) {
        bits[i] = counts[i] > 0 && ones[i] * 2 > counts[i] ? 1 : 0;
    }
    return bits;
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

const COS = (() => {
    const table = new Float64Array(BLOCK_VALUES);
    for (let u = 0; u < BLOCK_SIDE; u++) {
        const scale = u === 0 ? Math.sqrt(1 / BLOCK_SIDE) : Math.sqrt(2 / BLOCK_SIDE);
        for (let x = 0; x < BLOCK_SIDE; x++) {
            table[u * BLOCK_SIDE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * BLOCK_SIDE)) * scale;
        }
    }
    return table;
})();

const dctScratch = new Float64Array(BLOCK_VALUES);

function blockTransform(source, out, inverse) {
    const n = BLOCK_SIDE;
    for (let row = 0; row < n; row++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += inverse
                    ? source[row * n + i] * COS[i * n + k]
                    : source[row * n + i] * COS[k * n + i];
            }
            dctScratch[row * n + k] = sum;
        }
    }
    for (let column = 0; column < n; column++) {
        for (let k = 0; k < n; k++) {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += inverse
                    ? dctScratch[i * n + column] * COS[i * n + k]
                    : dctScratch[i * n + column] * COS[k * n + i];
            }
            out[k * n + column] = sum;
        }
    }
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
                const bit = bits[index % BLOCK_BITS];
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
export function extractImageWatermark(pixels, width, height, { stepMain = STEP_MAIN, stepSecond = STEP_SECOND, minActivity = MIN_ACTIVITY } = {}) {
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
                const index = row * layout.columns + column;
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

                const slot = index % BLOCK_BITS;
                ones[slot] += vote;
                counts[slot] += 1;
            }
        }
    }

    return bitsToPayload(majorityBits(ones, counts));
}
