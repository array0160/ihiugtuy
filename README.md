# BookOCR Browser UVDoc Prototype

這是第一個「完全不用 Python server」的驗證版本。

目前只做：

1. 瀏覽器上傳一張同時拍到左右兩頁的照片
2. 依書脊位置切成右頁 / 左頁
3. 瀏覽器用 ONNX Runtime Web 執行 UVDoc
4. 顯示 BEFORE / AFTER
5. 可下載兩張展平結果，比對先前 Colab 的 `right_flat` / `left_flat`

**目前故意沒有 OCR、沒有分欄。**
先確認 Browser UVDoc 和 Python/Colab UVDoc 的幾何展平效果是否足夠接近。

## 為什麼這版不需要 Python

使用：

- `paddleocr` 1.2.0 的 `TextImageUnwarpingService`
- `onnxruntime-web` 1.27.0
- PaddlePaddle 官方 UVDoc ONNX

全部在使用者瀏覽器執行。

模型網址：

`https://huggingface.co/PaddlePaddle/UVDoc_onnx/resolve/main/inference.onnx`

第一次開啟網站約需下載 30 MB UVDoc 模型。程式會用瀏覽器 Cache Storage 保存模型；
之後同一瀏覽器通常不需要重新下載。

## 最簡單的 GitHub Pages 部署方法

### 1. 新增 GitHub repository

例如：

`bookocr-web`

### 2. 把這個資料夾內「所有檔案」上傳到 repository 根目錄

根目錄應該直接看到：

```text
.github/
public/
src/
index.html
package.json
vite.config.js
README.md
```

不要再多包一層資料夾。

### 3. GitHub → Settings → Pages

在 **Build and deployment / Source** 選：

`GitHub Actions`

### 4. 回到 Actions

Push 到 `main` 或 `master` 後，`Deploy BookOCR browser prototype to GitHub Pages`
會自動：

```text
npm install
npm run build
deploy dist/
```

成功後會得到類似：

`https://你的帳號.github.io/bookocr-web/`

## 測試時看什麼

拿你之前 Colab 用的同一張跨頁照片。

比較：

```text
Colab right_flat
vs
網站右頁 AFTER

Colab left_flat
vs
網站左頁 AFTER
```

我們現在只問：

**頁面彎曲、梯形、靠書脊的變形，有沒有改善到相近程度？**

如果這一關成立，下一版才會搬：

```text
UVDoc
→ PP-OCRv5 detector
→ polygon PCA 中心線
→ short-column slope regularization
→ V3 scanline/corridor remap
→ 單欄 recognition
```

也就是我們前面在 Colab 花時間調好的完整前處理。

## 技術備註

### 為什麼第一版固定用 WASM

GitHub Pages 本身不方便設定 COOP/COEP response headers。
為了先排除 WebGPU / 多執行緒 WASM 的環境差異，這版固定：

- ONNX Runtime Web WASM
- `numThreads = 1`
- SIMD on

等輸出 parity 確認後，再做 WebGPU 加速。

### 照片會傳去哪？

OCR/UVDoc 不需要我們自己的 server。

照片由瀏覽器解碼後直接在本機記憶體中處理。
UVDoc 模型檔則由 PaddlePaddle 的 Hugging Face repository 下載。

## 已知風險

這是一個「技術驗證 prototype」，不是最終版。

需要特別驗證：

1. Browser UVDoc 的 preprocessing / postprocessing 與 Python PaddleOCR 是否夠接近。
2. Hugging Face 模型的 CORS 是否在目標瀏覽器正常。
3. 大型手機照片在不同裝置上的記憶體使用。
4. GitHub Pages 環境下 ONNX Runtime WASM 的實際速度。

如果 UVDoc parity 過關，後面的 detector/中心線/V3 remap 才值得繼續搬。
