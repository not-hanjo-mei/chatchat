# vendor/grokbot

這裡放的是 [grokbot-web](https://github.com/Coiggahou2002/grokbot-web) 的原始碼，用來產生「名字 → 頭像」的圖形。

- 上游：`https://github.com/Coiggahou2002/grokbot-web`
- 鎖定版本：commit `616c1dd451f105a10a903e01eed8f82370968681`（`package.json` 版本 0.1.0）
- 授權：BSD-3-Clause，見同目錄的 `LICENSE`
- 上游本身是 [nasawz/GrokBot](https://github.com/nasawz/GrokBot)（Flutter，BSD-3-Clause）的 TypeScript / Canvas 2D 移植；頭像的造型設計出自 nasawz

## 為什麼是 vendored 而不是裝套件

上游還沒有發佈到 npm（`registry.npmjs.org/grokbot-web` 回 404），而 `dist/` 沒有進版控，所以無法直接從 CDN 取用。因此把 `src/` 的 10 個檔案放進來，自己用 esbuild 打成單一 ESM 檔。

## 這裡有什麼

```
src/index.ts            入口，轉出 GrokBot 與資料表
src/engine.ts           引擎：彈簧形變、眨眼、轉頭、生命週期
src/painter.ts          Canvas 2D 繪製
src/geometry.ts         幾何與投影
src/easing.ts           緩動函式
src/theme.ts            亮／暗主題色票
src/types.ts            型別定義
src/data/expressions.ts 25 組表情（每組兩眼各 48 點）
src/data/shapes.ts      18 種體型
src/data/states.ts      39 種狀態
```

## 重建產物

```bash
npx esbuild@0.25.10 vendor/grokbot/src/index.ts --bundle --format=esm --minify \
  --target=es2020 --legal-comments=none --outfile=assets/js/vendor/grokbot.js \
  --banner:js='/* grokbot-web (BSD-3-Clause) - vendored from github.com/Coiggahou2002/grokbot-web@616c1dd451f105a10a903e01eed8f82370968681 - see vendor/grokbot/LICENSE */'
```

`tools/selfcheck.mjs` 會用樁 canvas 實例化引擎並畫一格，確認打包後的檔案仍可運作。

## 升級步驟

1. 抓新版的 `src/` 覆蓋這裡（`gh api repos/Coiggahou2002/grokbot-web/contents/src/... `）。
2. 重跑上面的打包指令，並把 commit 換成新的。
3. `node tools/selfcheck.mjs`。
4. 若 `shapeNames` 的順序變了，所有人的頭像會換一張臉（因為 `assets/js/avatar.js` 用索引取形狀）；要固定就改成用名字取字串本身。
