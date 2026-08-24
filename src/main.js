import "./style.css";
import * as ort from "onnxruntime-web";
import {
  TextImageUnwarpingService,
  getTextImageUnwarpingPresetOptions,
} from "paddleocr";

// Official PaddlePaddle ONNX model.
// The page caches these bytes after the first successful download.
const UVDOC_URL =
  "https://huggingface.co/PaddlePaddle/UVDoc_onnx/resolve/main/inference.onnx";
const MODEL_CACHE = "bookocr-models-v1";
const MAX_PAGE_SIDE = 2400;

// Avoid COOP/COEP requirements for this first GitHub Pages prototype.
// We can add WebGPU / threaded WASM later after output parity is verified.
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  bitmap: null,
  rightInput: null,
  leftInput: null,
  rightOutput: null,
  leftOutput: null,
  unwarper: null,
  session: null,
};

function setStatus(text, detail = "", progress = null) {
  $("status").textContent = text;
  $("detail").textContent = detail;

  if (progress == null) return;
  $("progressBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function showCanvas(canvasId, emptyId) {
  $(canvasId).style.display = "block";
  $(emptyId).style.display = "none";
}

function clearCanvas(canvasId, emptyId, text) {
  const canvas = $(canvasId);
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.display = "none";
  $(emptyId).style.display = "block";
  $(emptyId).textContent = text;
}

function drawBitmapCropToCanvas(bitmap, sx, sy, sw, sh, canvas) {
  const scale = Math.min(1, MAX_PAGE_SIDE / Math.max(sw, sh));
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

function canvasToPaddlePixels(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // paddleocr.js accepts RGBA.
  return {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(
      imageData.data.buffer.slice(
        imageData.data.byteOffset,
        imageData.data.byteOffset + imageData.data.byteLength,
      ),
    ),
  };
}

function paddlePixelsToCanvas(image, canvas) {
  const { width, height, data } = image;
  canvas.width = width;
  canvas.height = height;

  let rgba;

  if (data.length === width * height * 4) {
    rgba = new Uint8ClampedArray(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  } else if (data.length === width * height * 3) {
    rgba = new Uint8ClampedArray(width * height * 4);
    let si = 0;
    let di = 0;

    while (si < data.length) {
      rgba[di++] = data[si++];
      rgba[di++] = data[si++];
      rgba[di++] = data[si++];
      rgba[di++] = 255;
    }
  } else if (data.length === width * height) {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i++) {
      const v = data[i];
      rgba[j++] = v;
      rgba[j++] = v;
      rgba[j++] = v;
      rgba[j++] = 255;
    }
  } else {
    throw new Error(
      `UVDoc 回傳未知像素格式：${data.length} bytes for ${width}x${height}`,
    );
  }

  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
}

async function fetchArrayBufferCached(url, onProgress) {
  const cache = "caches" in window ? await caches.open(MODEL_CACHE) : null;

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      onProgress?.(100, "UVDoc 模型已從瀏覽器快取載入。");
      return cached.arrayBuffer();
    }
  }

  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`UVDoc 模型下載失敗：HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (cache) {
      await cache.put(
        url,
        new Response(buffer.slice(0), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }
    onProgress?.(100, "UVDoc 模型下載完成。");
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    received += value.byteLength;

    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      onProgress?.(
        pct,
        `下載 UVDoc：${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
      );
    } else {
      onProgress?.(
        null,
        `下載 UVDoc：${(received / 1024 / 1024).toFixed(1)} MB`,
      );
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (cache) {
    await cache.put(
      url,
      new Response(merged.slice().buffer, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  }

  onProgress?.(100, "UVDoc 模型下載完成。");
  return merged.buffer;
}

async function ensureUvDoc() {
  if (state.unwarper) return state.unwarper;

  setStatus("準備 UVDoc 模型…", "第一次開啟會下載模型。", 2);

  const modelBuffer = await fetchArrayBufferCached(
    UVDOC_URL,
    (pct, msg) => {
      setStatus("準備 UVDoc 模型…", msg, pct == null ? 15 : pct * 0.65);
    },
  );

  setStatus("建立 ONNX Runtime session…", "這一步只在本瀏覽器初始化。", 70);

  state.session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  state.unwarper = new TextImageUnwarpingService(
    ort,
    state.session,
    getTextImageUnwarpingPresetOptions("UVDoc"),
  );

  setStatus("UVDoc 已準備完成。", "之後同一瀏覽器會優先使用模型快取。", 100);
  return state.unwarper;
}

function splitPages() {
  if (!state.bitmap) return;

  const bitmap = state.bitmap;
  const w = bitmap.width;
  const h = bitmap.height;

  const splitPct = Number($("splitRange").value) / 100;
  const gutterPct = Number($("gutterRange").value) / 100;

  const splitX = w * splitPct;
  const halfGutter = (w * gutterPct) / 2;

  const leftEnd = Math.max(1, splitX - halfGutter);
  const rightStart = Math.min(w - 1, splitX + halfGutter);

  // Traditional spread: photo's right half is the right-hand page.
  drawBitmapCropToCanvas(
    bitmap,
    rightStart,
    0,
    w - rightStart,
    h,
    $("rightBefore"),
  );

  drawBitmapCropToCanvas(bitmap, 0, 0, leftEnd, h, $("leftBefore"));

  state.rightInput = canvasToPaddlePixels($("rightBefore"));
  state.leftInput = canvasToPaddlePixels($("leftBefore"));

  showCanvas("rightBefore", "rightBeforeEmpty");
  showCanvas("leftBefore", "leftBeforeEmpty");

  clearCanvas("rightAfter", "rightAfterEmpty", "等待 UVDoc");
  clearCanvas("leftAfter", "leftAfterEmpty", "等待 UVDoc");
  $("saveRight").disabled = true;
  $("saveLeft").disabled = true;

  setStatus(
    "左右頁已切開。",
    "確認書脊切割位置後，再按「瀏覽器 UVDoc 展平」。",
    0,
  );
}

async function runUvDoc() {
  if (!state.rightInput || !state.leftInput) splitPages();
  if (!state.rightInput || !state.leftInput) return;

  $("runBtn").disabled = true;
  $("splitBtn").disabled = true;

  try {
    const unwarper = await ensureUvDoc();

    setStatus("正在展平右頁…", "UVDoc inference in browser", 10);
    const rightResult = await unwarper.run(state.rightInput);
    state.rightOutput = rightResult.doctrImage;
    paddlePixelsToCanvas(state.rightOutput, $("rightAfter"));
    showCanvas("rightAfter", "rightAfterEmpty");
    $("saveRight").disabled = false;

    setStatus("正在展平左頁…", "UVDoc inference in browser", 58);
    const leftResult = await unwarper.run(state.leftInput);
    state.leftOutput = leftResult.doctrImage;
    paddlePixelsToCanvas(state.leftOutput, $("leftAfter"));
    showCanvas("leftAfter", "leftAfterEmpty");
    $("saveLeft").disabled = false;

    setStatus(
      "完成：兩頁都已在瀏覽器中展平。",
      "請直接跟 Colab UVDoc 的 right_flat / left_flat 肉眼比較。",
      100,
    );
  } catch (error) {
    console.error(error);
    setStatus(
      "UVDoc 失敗。",
      error instanceof Error ? error.message : String(error),
      0,
    );
  } finally {
    $("runBtn").disabled = false;
    $("splitBtn").disabled = false;
  }
}

function saveCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/jpeg", 0.94);
}

async function loadFile(file) {
  state.file = file;

  if (state.bitmap) {
    state.bitmap.close?.();
  }

  state.bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  $("photoPreview").src = URL.createObjectURL(file);
  $("photoPreview").style.display = "block";
  $("dropHint").style.display = "none";

  $("splitBtn").disabled = false;
  $("runBtn").disabled = false;

  splitPages();
}

$("fileInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
});

const dropZone = $("dropZone");

["dragenter", "dragover"].forEach((name) => {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag");
  });
});

["dragleave", "drop"].forEach((name) => {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag");
  });
});

dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file?.type.startsWith("image/")) loadFile(file);
});

$("splitRange").addEventListener("input", () => {
  $("splitValue").textContent = `${Number($("splitRange").value).toFixed(1)}%`;
  if (state.bitmap) splitPages();
});

$("gutterRange").addEventListener("input", () => {
  $("gutterValue").textContent = `${Number($("gutterRange").value).toFixed(1)}%`;
  if (state.bitmap) splitPages();
});

$("splitBtn").addEventListener("click", splitPages);
$("runBtn").addEventListener("click", runUvDoc);

$("saveRight").addEventListener("click", () =>
  saveCanvas($("rightAfter"), "right_browser_uvdoc.jpg"),
);

$("saveLeft").addEventListener("click", () =>
  saveCanvas($("leftAfter"), "left_browser_uvdoc.jpg"),
);

$("clearCacheBtn").addEventListener("click", async () => {
  if (!("caches" in window)) {
    setStatus("這個瀏覽器沒有 Cache Storage API。", "", 0);
    return;
  }

  await caches.delete(MODEL_CACHE);
  setStatus(
    "UVDoc 模型快取已清除。",
    "目前已建立的記憶體 session 仍可使用；重新整理後會重新下載。",
    0,
  );
});

$("splitValue").textContent = `${Number($("splitRange").value).toFixed(1)}%`;
$("gutterValue").textContent = `${Number($("gutterRange").value).toFixed(1)}%`;
