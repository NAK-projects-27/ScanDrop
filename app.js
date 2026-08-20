/*
  Endpoints used:
    POST /api/scan       -> send a scan
    GET  /api/scans       -> poll for scans
    POST /api/clear       -> clear a room
*/

let currentRoom = "";
let connected = false;
let scanner = null;
let scannerRunning = false;
let latestPlainText = "";
let allResults = [];
let lastSeenId = 0;
let pollTimer = null;
let serverInfo = { ips: [], httpsPort: 8443, httpsEnabled: false };

const scanMemory = new Map();   // decoded value -> timestamp it was last accepted
let scansSent = 0;
let dupesIgnored = 0;
let scannerPaused = false;
let audioCtx = null;

const els = {
  modeSelect: document.getElementById("modeSelect"),
  roomInput: document.getElementById("roomInput"),
  connectBtn: document.getElementById("connectBtn"),
  copyPhoneLinkBtn: document.getElementById("copyPhoneLinkBtn"),
  copyLaptopLinkBtn: document.getElementById("copyLaptopLinkBtn"),
  clearRoomBtn: document.getElementById("clearRoomBtn"),
  connectionStatus: document.getElementById("connectionStatus"),

  phoneView: document.getElementById("phoneView"),
  laptopView: document.getElementById("laptopView"),

  startScannerBtn: document.getElementById("startScannerBtn"),
  stopScannerBtn: document.getElementById("stopScannerBtn"),
  resumeScannerBtn: document.getElementById("resumeScannerBtn"),
  dupeMode: document.getElementById("dupeMode"),
  pauseAfterScan: document.getElementById("pauseAfterScan"),
  beepOnScan: document.getElementById("beepOnScan"),
  manualText: document.getElementById("manualText"),
  sendTextBtn: document.getElementById("sendTextBtn"),

  secureWarning: document.getElementById("secureWarning"),
  phoneLinkBox: document.getElementById("phoneLinkBox"),

  imageInput: document.getElementById("imageInput"),
  enhanceOcr: document.getElementById("enhanceOcr"),
  ocrLayout: document.getElementById("ocrLayout"),
  scanPhotoBtn: document.getElementById("scanPhotoBtn"),
  sendImageBtn: document.getElementById("sendImageBtn"),
  ocrImageBtn: document.getElementById("ocrImageBtn"),
  sendImageAndOcrBtn: document.getElementById("sendImageAndOcrBtn"),
  phoneStatus: document.getElementById("phoneStatus"),
  imagePreviewWrap: document.getElementById("imagePreviewWrap"),
  imagePreview: document.getElementById("imagePreview"),

  copyLatestBtn: document.getElementById("copyLatestBtn"),
  downloadCsvBtn: document.getElementById("downloadCsvBtn"),
  downloadTextBtn: document.getElementById("downloadTextBtn"),
  laptopStatus: document.getElementById("laptopStatus"),
  latestBox: document.getElementById("latestBox"),
  results: document.getElementById("results")
};

initFromUrl();

els.modeSelect.addEventListener("change", () => {
  localStorage.setItem("scannerMode", els.modeSelect.value);
  showMode();
  updateAddressBar();
});

els.connectBtn.addEventListener("click", connect);
els.copyPhoneLinkBtn.addEventListener("click", () => copyModeLink("phone"));
els.copyLaptopLinkBtn.addEventListener("click", () => copyModeLink("laptop"));
els.clearRoomBtn.addEventListener("click", clearRoom);

els.startScannerBtn.addEventListener("click", startScanner);
els.stopScannerBtn.addEventListener("click", stopScanner);
els.resumeScannerBtn.addEventListener("click", resumeScanner);
els.dupeMode.addEventListener("change", () => {
  scanMemory.clear();
  setStatus(els.phoneStatus, "Duplicate rule changed. Memory cleared.", "warn");
});
els.sendTextBtn.addEventListener("click", sendManualText);

els.imageInput.addEventListener("change", previewSelectedImage);
els.scanPhotoBtn.addEventListener("click", scanPhotoForCode);
els.sendImageBtn.addEventListener("click", sendImageOnly);
els.ocrImageBtn.addEventListener("click", ocrImageOnly);
els.sendImageAndOcrBtn.addEventListener("click", sendImageAndOcr);

els.copyLatestBtn.addEventListener("click", copyLatest);
els.downloadCsvBtn.addEventListener("click", downloadCsv);
els.downloadTextBtn.addEventListener("click", downloadText);

function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  const mode = params.get("mode");

  if (room) {
    els.roomInput.value = room;
  } else {
    els.roomInput.value = localStorage.getItem("scannerRoom") || makeDefaultRoom();
  }

  if (mode === "phone" || mode === "laptop") {
    els.modeSelect.value = mode;
  } else {
    els.modeSelect.value = localStorage.getItem("scannerMode") || "phone";
  }

  showMode();
  checkSecureContext();
}

function cameraAvailable() {
  return Boolean(
    window.isSecureContext &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  );
}

function checkSecureContext() {
  if (!els.secureWarning) return;

  if (cameraAvailable()) {
    els.secureWarning.classList.add("hidden");
    els.startScannerBtn.disabled = false;
    return;
  }

  els.secureWarning.classList.remove("hidden");
  els.startScannerBtn.disabled = true;

  const host = window.location.hostname;
  const httpsUrl =
    "https://" + host + ":" + serverInfo.httpsPort + window.location.search;

  els.secureWarning.innerHTML =
    "Live camera is blocked because this page was opened over <b>http</b>. " +
    "Open the <b>https</b> address instead: <br><b>" +
    httpsUrl +
    "</b><br>Accept the certificate warning once, then the camera works. " +
    "Until then, use <b>Scan barcode from photo</b> below - that works over http.";
}

function makeDefaultRoom() {
  const saved = localStorage.getItem("scannerRoom");
  if (saved) return saved;

  const room = "scanner-" + Math.random().toString(36).slice(2, 8);
  localStorage.setItem("scannerRoom", room);
  return room;
}

function showMode() {
  const mode = els.modeSelect.value;
  els.phoneView.classList.toggle("hidden", mode !== "phone");
  els.laptopView.classList.toggle("hidden", mode !== "laptop");
}

function cleanRoomCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .slice(0, 80);
}

function updateAddressBar() {
  const room = cleanRoomCode(els.roomInput.value);
  const mode = els.modeSelect.value;
  if (!room) return;

  const newUrl = new URL(window.location.href);
  newUrl.searchParams.set("room", room);
  newUrl.searchParams.set("mode", mode);
  window.history.replaceState({}, "", newUrl);
}

async function connect() {
  currentRoom = cleanRoomCode(els.roomInput.value);

  if (!currentRoom) {
    setStatus(els.connectionStatus, "Enter a room code first.", "bad");
    return;
  }

  try {
    const res = await fetch("/api/ping");
    if (!res.ok) throw new Error("ping failed");

    try {
      const info = await res.json();
      if (info && typeof info === "object") {
        serverInfo.ips = info.ips || [];
        serverInfo.httpsPort = info.httpsPort || 8443;
        serverInfo.httpsEnabled = Boolean(info.httpsEnabled);
      }
    } catch (e) {
      /* older server, ignore */
    }

    checkSecureContext();
    showPhoneLink();

    connected = true;
    lastSeenId = 0;

    localStorage.setItem("scannerRoom", currentRoom);
    localStorage.setItem("scannerMode", els.modeSelect.value);

    updateAddressBar();
    showMode();
    startPolling();

    setStatus(els.connectionStatus, "Connected to server. Room: " + currentRoom, "ok");
  } catch (err) {
    console.error(err);
    connected = false;
    setStatus(
      els.connectionStatus,
      "Could not reach the local server. Is server.py running, and are you on the same Wi-Fi?",
      "bad"
    );
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(pollScans, 1200);
  pollScans();
}

async function pollScans() {
  if (!connected || !currentRoom) return;

  try {
    const url = "/api/scans?room=" + encodeURIComponent(currentRoom) + "&since=" + lastSeenId;
    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok) return;

    const newScans = data.scans || [];
    if (!newScans.length) return;

    for (const s of newScans) {
      allResults.push(s);
      if (s.id > lastSeenId) lastSeenId = s.id;
    }

    // Sort newest first for display
    const sorted = allResults.slice().sort((a, b) => b.createdAt - a.createdAt);
    renderResults(sorted);
  } catch (err) {
    // Network hiccup - stay quiet, will retry next tick.
  }
}

async function sendScan(payload) {
  if (!connected) {
    setStatus(els.phoneStatus, "Not connected. Click Connect first.", "bad");
    return false;
  }

  try {
    const body = Object.assign({ room: currentRoom }, payload);
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error("send failed");

    setStatus(els.phoneStatus, "Sent to laptop.", "ok");
    return true;
  } catch (err) {
    console.error(err);
    setStatus(els.phoneStatus, "Send failed. Check server connection.", "bad");
    return false;
  }
}

/*
  Returns true if this decoded value should actually be sent.
  Called synchronously on every decoded frame, before any await, so two frames
  can never slip through together.
*/
function shouldAcceptScan(value) {
  const mode = els.dupeMode ? els.dupeMode.value : "3000";
  if (mode === "0") return true;

  const now = Date.now();
  const lastAccepted = scanMemory.get(value) || 0;

  if (mode === "once") {
    if (scanMemory.has(value)) return false;
    scanMemory.set(value, now);
    return true;
  }

  const windowMs = parseInt(mode, 10) || 3000;

  if (lastAccepted && now - lastAccepted < windowMs) {
    // Push the timestamp forward, so holding the code in frame keeps it
    // suppressed instead of firing again every few seconds.
    scanMemory.set(value, now);
    return false;
  }

  scanMemory.set(value, now);
  return true;
}

function ensureAudio() {
  try {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
  } catch (e) {
    audioCtx = null;
  }
}

function beep() {
  if (els.beepOnScan && !els.beepOnScan.checked) return;

  try {
    if (navigator.vibrate) navigator.vibrate(60);
  } catch (e) {
    /* not supported on iOS */
  }

  try {
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") audioCtx.resume();

    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "square";
    osc.frequency.value = 880;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  } catch (e) {
    /* audio is a nicety, never break scanning over it */
  }
}

async function onCodeDecoded(decodedText, decodedResult) {
  if (!shouldAcceptScan(decodedText)) {
    dupesIgnored++;
    return;
  }

  beep();
  scansSent++;

  // Optionally freeze the camera so one scan means one item.
  if (els.pauseAfterScan && els.pauseAfterScan.checked && scanner) {
    try {
      scanner.pause(true);
      scannerPaused = true;
      els.resumeScannerBtn.classList.remove("hidden");
    } catch (e) {
      /* older library version without pause() */
    }
  }

  const format =
    decodedResult && decodedResult.result && decodedResult.result.format
      ? decodedResult.result.format.formatName
      : "Unknown";

  await sendScan({ type: "barcode_or_qr", value: decodedText, format: format });

  let msg = "Sent #" + scansSent + ": " + decodedText;
  if (dupesIgnored) msg += "  (" + dupesIgnored + " repeats ignored)";
  if (scannerPaused) msg += "  - paused, tap Resume for the next item.";

  setStatus(els.phoneStatus, msg, "ok");
}

async function resumeScanner() {
  if (!scanner || !scannerPaused) return;

  try {
    scanner.resume();
    scannerPaused = false;
    els.resumeScannerBtn.classList.add("hidden");
    setStatus(els.phoneStatus, "Scanner running.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(els.phoneStatus, "Could not resume. Stop and start the scanner.", "bad");
  }
}

function supportedFormats() {
  if (!window.Html5QrcodeSupportedFormats) return undefined;

  return [
    Html5QrcodeSupportedFormats.QR_CODE,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
    Html5QrcodeSupportedFormats.PDF_417,
    Html5QrcodeSupportedFormats.AZTEC
  ];
}

/*
  uses the phone's normal camera app through <input type="file" capture>,
  then decodes the still image in JavaScript. It needs NO camera permission and
  NO secure context, so it works fine over plain http.
*/
async function scanPhotoForCode() {
  const file = selectedImageFile();
  if (!file) return;

  if (!connected) {
    setStatus(els.phoneStatus, "Click Connect first.", "bad");
    return;
  }

  if (!window.Html5Qrcode) {
    setStatus(els.phoneStatus, "Scanner library did not load.", "bad");
    return;
  }

  setStatus(els.phoneStatus, "Looking for a barcode in that photo...", "warn");

  let fileScanner = null;

  try {
    if (scannerRunning) await stopScanner();

    fileScanner = new Html5Qrcode("reader", {
      formatsToSupport: supportedFormats(),
      verbose: false
    });

    const decodedText = await fileScanner.scanFile(file, true);

    await sendScan({
      type: "barcode_or_qr",
      value: decodedText,
      format: "from photo"
    });

    setStatus(els.phoneStatus, "Code found and sent: " + decodedText, "ok");
  } catch (err) {
    console.error(err);
    setStatus(
      els.phoneStatus,
      "No readable code in that photo. Get closer, hold steady, and make sure the whole code is in frame.",
      "bad"
    );
  } finally {
    if (fileScanner) {
      try {
        await fileScanner.clear();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function showPhoneLink() {
  if (!els.phoneLinkBox) return;

  const room = cleanRoomCode(els.roomInput.value);
  const ip = (serverInfo.ips || []).find((x) => x !== "127.0.0.1");

  if (!ip || !serverInfo.httpsEnabled) {
    els.phoneLinkBox.classList.add("hidden");
    return;
  }

  const url =
    "https://" + ip + ":" + serverInfo.httpsPort +
    "/?mode=phone&room=" + encodeURIComponent(room);

  els.phoneLinkBox.classList.remove("hidden");
  els.phoneLinkBox.innerHTML =
    "Open this on your phone (camera-enabled): <b>" + url + "</b>";
}

async function startScanner() {
  if (scannerRunning) return;

  if (!connected) {
    setStatus(els.phoneStatus, "Click Connect first.", "bad");
    return;
  }

  if (!window.Html5Qrcode) {
    setStatus(
      els.phoneStatus,
      "Scanner library did not load. If the network blocks the CDN, we can host it locally instead.",
      "bad"
    );
    return;
  }

  if (!cameraAvailable()) {
    checkSecureContext();
    setStatus(
      els.phoneStatus,
      "Live camera needs https. Open the https address shown above, or use " +
      "\"Scan barcode from photo\" instead.",
      "bad"
    );
    return;
  }

  try {
    scanner = new Html5Qrcode("reader", {
      formatsToSupport: supportedFormats(),
      verbose: false
    });

    const config = {
      fps: 10,
      qrbox: { width: 260, height: 180 },
      aspectRatio: 1.333,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };

    // Get available cameras first
const cameras = await Html5Qrcode.getCameras();

if (!cameras || cameras.length === 0) {
  throw new Error("No cameras found");
}

// Prefer the back camera on iPhone
let cameraId = cameras[0].id;

const backCamera = cameras.find(c =>
  (c.label || "").toLowerCase().includes("back")
);

if (backCamera) {
  cameraId = backCamera.id;
}

console.log("Using camera:", cameraId);

await scanner.start(
  cameraId,
  config,
  onCodeDecoded,
  () => {}
);

    scannerRunning = true;
    scannerPaused = false;
    scansSent = 0;
    dupesIgnored = 0;
    scanMemory.clear();
    ensureAudio();
    els.resumeScannerBtn.classList.add("hidden");
    setStatus(els.phoneStatus, "Scanner running.", "ok");
  } catch (err) {
      console.error("Camera Error:", err);
      setStatus(
        els.phoneStatus,
        "Camera Error: " + (err?.message || JSON.stringify(err)),
        "bad"
  );
}
}

async function stopScanner() {
  try {
    if (scanner && scannerRunning) {
      await scanner.stop();
      await scanner.clear();
    }

    scanner = null;
    scannerRunning = false;
    scannerPaused = false;
    els.resumeScannerBtn.classList.add("hidden");
    setStatus(els.phoneStatus, "Scanner stopped.", "warn");
  } catch (err) {
    console.error(err);
    setStatus(els.phoneStatus, "Could not stop scanner cleanly.", "bad");
  }
}

async function sendManualText() {
  const value = els.manualText.value.trim();

  if (!value) {
    setStatus(els.phoneStatus, "Type something first.", "bad");
    return;
  }

  const ok = await sendScan({ type: "manual_text", value });
  if (ok) els.manualText.value = "";
}

function selectedImageFile() {
  const file = els.imageInput.files && els.imageInput.files[0];

  if (!file) {
    setStatus(els.phoneStatus, "Choose or capture an image first.", "bad");
    return null;
  }

  return file;
}

async function previewSelectedImage() {
  const file = selectedImageFile();
  if (!file) return;

  const dataUrl = await fileToCompressedDataUrl(file, 1200, 0.72);

  els.imagePreview.src = dataUrl;
  els.imagePreviewWrap.classList.remove("hidden");
  setStatus(els.phoneStatus, "Image selected.", "ok");
}

async function sendImageOnly() {
  const file = selectedImageFile();
  if (!file) return;

  setStatus(els.phoneStatus, "Compressing and sending image...", "warn");

  const dataUrl = await fileToCompressedDataUrl(file, 1200, 0.72);

  await sendScan({
    type: "image",
    value: "Image captured",
    imageDataUrl: dataUrl,
    fileName: file.name || "camera-image.jpg"
  });
}

async function ocrImageOnly() {
  const file = selectedImageFile();
  if (!file) return;

  if (!window.Tesseract) {
    setStatus(els.phoneStatus, "OCR library did not load.", "bad");
    return;
  }

  setStatus(els.phoneStatus, "Reading text from image. Keep this page open.", "warn");

  try {
    const text = await runOcr(file);

    if (!text.trim()) {
      setStatus(els.phoneStatus, "OCR finished, but no text was found.", "warn");
      return;
    }

    await sendScan({ type: "ocr_text", value: text.trim() });
    setStatus(els.phoneStatus, "OCR text sent.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(els.phoneStatus, "OCR failed on this image.", "bad");
  }
}

async function sendImageAndOcr() {
  const file = selectedImageFile();
  if (!file) return;

  if (!window.Tesseract) {
    setStatus(els.phoneStatus, "OCR library did not load.", "bad");
    return;
  }

  setStatus(els.phoneStatus, "Compressing image and reading OCR text...", "warn");

  try {
    const dataUrl = await fileToCompressedDataUrl(file, 1200, 0.72);
    const text = await runOcr(file);

    await sendScan({
      type: "image_plus_ocr",
      value: text.trim() || "Image captured. OCR found no text.",
      imageDataUrl: dataUrl,
      fileName: file.name || "camera-image.jpg"
    });

    setStatus(els.phoneStatus, "Image and OCR sent.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(els.phoneStatus, "Image or OCR failed.", "bad");
  }
}

function fileToCompressedDataUrl(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };

      img.onerror = reject;
      img.src = reader.result;
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   OCR IMAGE PREPROCESSING
   A phone photo of a label is usually dim and uneven, with a lot of
   background in frame. Feeding that straight to Tesseract produces noise.
   Pipeline: load (EXIF-safe) -> grayscale -> auto-crop to the paper ->
   upscale small text -> local adaptive threshold -> clean black on white.
   ============================================================ */

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      /* Safari without the option - fall through */
    }
    try {
      return await createImageBitmap(file);
    } catch (e) {
      /* fall through */
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function grayFromImageData(data, length) {
  const gray = new Uint8ClampedArray(length);
  for (let i = 0, p = 0; i < length; i++, p += 4) {
    gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return gray;
}

function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += i * hist[i];
    const between = wB * wF * Math.pow(sumB / wB - (sumAll - sumB) / wF, 2);
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/* Find the bright paper/label region so we don't OCR the desk or floor. */
function findBrightRegion(gray, w, h) {
  const t = otsuThreshold(gray);

  const rowFrac = new Float32Array(h);
  const colFrac = new Float32Array(w);

  for (let y = 0; y < h; y++) {
    let count = 0;
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[off + x] > t) {
        count++;
        colFrac[x] += 1;
      }
    }
    rowFrac[y] = count / w;
  }
  for (let x = 0; x < w; x++) colFrac[x] /= h;

  const span = (arr, n) => {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < n; i++) {
      if (arr[i] > 0.4) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    return [lo, hi];
  };

  const [y0, y1] = span(rowFrac, h);
  const [x0, x1] = span(colFrac, w);

  if (y0 < 0 || x0 < 0) return { x: 0, y: 0, w: w, h: h };

  const bw = x1 - x0;
  const bh = y1 - y0;

  // Only trust the crop if it keeps a meaningful chunk of the frame.
  if (bw * bh < w * h * 0.12) return { x: 0, y: 0, w: w, h: h };

  return { x: x0, y: y0, w: bw, h: bh };
}

/* Bradley-Roth adaptive threshold via integral image - handles uneven light. */
function adaptiveThreshold(gray, w, h, windowSize, tolerance) {
  const integral = new Float64Array((w + 1) * (h + 1));

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] =
        integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }

  const half = windowSize >> 1;
  const out = new Uint8ClampedArray(w * h);

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(h - 1, y + half);

    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(w - 1, x + half);
      const area = (y2 - y1 + 1) * (x2 - x1 + 1);

      const sum =
        integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
        integral[y1 * (w + 1) + (x2 + 1)] -
        integral[(y2 + 1) * (w + 1) + x1] +
        integral[y1 * (w + 1) + x1];

      out[y * w + x] =
        gray[y * w + x] * area > sum * (1 - tolerance) ? 255 : 0;
    }
  }
  return out;
}

async function prepareImageForOcr(file) {
  const bmp = await loadBitmap(file);
  const srcW = bmp.width || bmp.naturalWidth;
  const srcH = bmp.height || bmp.naturalHeight;

  // Stage 1: downscale to something a phone can process quickly.
  const maxDim = 2000;
  const s = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * s));
  const h = Math.max(1, Math.round(srcH * s));

  const c1 = document.createElement("canvas");
  c1.width = w;
  c1.height = h;
  const ctx1 = c1.getContext("2d", { willReadFrequently: true });
  ctx1.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();

  const gray1 = grayFromImageData(ctx1.getImageData(0, 0, w, h).data, w * h);

  // Stage 2: crop to the paper.
  const box = findBrightRegion(gray1, w, h);

  // Stage 3: redraw the crop, upscaling if the text would be small.
  const upscale = Math.min(2.5, Math.max(1, 1400 / box.w));
  const tw = Math.round(box.w * upscale);
  const th = Math.round(box.h * upscale);

  const c2 = document.createElement("canvas");
  c2.width = tw;
  c2.height = th;
  const ctx2 = c2.getContext("2d", { willReadFrequently: true });
  ctx2.imageSmoothingEnabled = true;
  ctx2.imageSmoothingQuality = "high";
  ctx2.drawImage(c1, box.x, box.y, box.w, box.h, 0, 0, tw, th);

  // Stage 4: adaptive threshold.
  const imgData = ctx2.getImageData(0, 0, tw, th);
  const gray2 = grayFromImageData(imgData.data, tw * th);

  let win = Math.max(15, Math.floor(tw / 20));
  if (win % 2 === 0) win += 1;

  const bw = adaptiveThreshold(gray2, tw, th, win, 0.15);

  for (let i = 0, p = 0; i < bw.length; i++, p += 4) {
    imgData.data[p] = bw[i];
    imgData.data[p + 1] = bw[i];
    imgData.data[p + 2] = bw[i];
    imgData.data[p + 3] = 255;
  }
  ctx2.putImageData(imgData, 0, 0);

  return c2;
}

async function ocrPass(image, psm) {
  const logger = (m) => {
    if (m && m.status && typeof m.progress === "number") {
      setStatus(
        els.phoneStatus,
        "OCR: " + m.status + " " + Math.round(m.progress * 100) + "%",
        "warn"
      );
    }
  };

  if (Tesseract.createWorker) {
    const worker = await Tesseract.createWorker("eng", 1, { logger: logger });
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });
      const out = await worker.recognize(image);
      return {
        text: (out && out.data && out.data.text) || "",
        confidence: (out && out.data && out.data.confidence) || 0
      };
    } finally {
      try {
        await worker.terminate();
      } catch (e) {
        /* ignore */
      }
    }
  }

  const res = await Tesseract.recognize(image, "eng", { logger: logger });
  return {
    text: (res && res.data && res.data.text) || "",
    confidence: (res && res.data && res.data.confidence) || 0
  };
}

async function runOcr(file) {
  let input = file;

  if (!els.enhanceOcr || els.enhanceOcr.checked) {
    setStatus(els.phoneStatus, "Cleaning up the image...", "warn");
    try {
      const canvas = await prepareImageForOcr(file);
      input = canvas;

      // Show what Tesseract is actually reading - makes bad photos obvious.
      els.imagePreview.src = canvas.toDataURL("image/png");
      els.imagePreviewWrap.classList.remove("hidden");
    } catch (err) {
      console.error("Preprocessing failed, using original image:", err);
      input = file;
    }
  }

  const psm = els.ocrLayout ? els.ocrLayout.value : "6";
  let best = await ocrPass(input, psm);

  // Low confidence usually means the layout mode was wrong - try once more.
  if (best.confidence < 65) {
    const fallback = psm === "6" ? "4" : "6";
    setStatus(els.phoneStatus, "Low confidence, retrying with another layout...", "warn");
    try {
      const alt = await ocrPass(input, fallback);
      if (alt.confidence > best.confidence) best = alt;
    } catch (e) {
      /* keep the first result */
    }
  }

  console.log("OCR confidence:", Math.round(best.confidence));
  return best.text;
}

function renderResults(rows) {
  els.results.innerHTML = "";

  if (!rows.length) {
    els.laptopStatus.textContent = "Waiting for scans.";
    els.latestBox.value = "";
    latestPlainText = "";
    return;
  }

  const latest = rows[0];
  latestPlainText = latest.value || "";

  els.latestBox.value = latestPlainText;
  setStatus(els.laptopStatus, "Received " + rows.length + " result(s).", "ok");

  for (const item of rows) {
    const div = document.createElement("div");
    div.className = "result-item";

    const time = item.createdAt
      ? new Date(item.createdAt).toLocaleString()
      : "Unknown time";

    const head = document.createElement("div");
    head.className = "result-head";

    const typeSpan = document.createElement("span");
    typeSpan.className = "result-type";
    typeSpan.textContent = (item.type || "unknown") + (item.format ? " - " + item.format : "");

    const timeSpan = document.createElement("span");
    timeSpan.className = "result-time";
    timeSpan.textContent = time;

    head.appendChild(typeSpan);
    head.appendChild(timeSpan);

    const valueDiv = document.createElement("div");
    valueDiv.className = "result-value";
    valueDiv.textContent = item.value || "";

    const row = document.createElement("div");
    row.className = "row";

    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary";
    copyBtn.textContent = "Copy this";
    copyBtn.addEventListener("click", async () => {
      await copyText(item.value || "");
      setStatus(els.laptopStatus, "Copied result.", "ok");
    });
    row.appendChild(copyBtn);

    div.appendChild(head);
    div.appendChild(valueDiv);
    div.appendChild(row);

    if (item.imageDataUrl) {
      const downloadBtn = document.createElement("button");
      downloadBtn.className = "secondary";
      downloadBtn.textContent = "Download image";
      downloadBtn.addEventListener("click", () => {
        downloadDataUrl(item.imageDataUrl, item.fileName || "scan-image.jpg");
      });
      row.appendChild(downloadBtn);

      const img = document.createElement("img");
      img.className = "result-img";
      img.src = item.imageDataUrl;
      img.alt = item.fileName || "Scanned image";
      div.appendChild(img);
    }

    els.results.appendChild(div);
  }
}

async function copyLatest() {
  if (!latestPlainText) {
    setStatus(els.laptopStatus, "Nothing to copy yet.", "bad");
    return;
  }

  await copyText(latestPlainText);
  setStatus(els.laptopStatus, "Latest result copied. Paste it where you need it.", "ok");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    document.body.removeChild(temp);
  }
}

function downloadCsv() {
  if (!allResults.length) {
    setStatus(els.laptopStatus, "No results to download.", "bad");
    return;
  }

  const rows = [["time", "type", "format", "value"]];

  for (const item of allResults.slice()) {
    rows.push([
      item.createdAt ? new Date(item.createdAt).toISOString() : "",
      item.type || "",
      item.format || "",
      item.value || ""
    ]);
  }

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  downloadTextFile(csv, "scanner-results.csv", "text/csv");
}

function downloadText() {
  if (!allResults.length) {
    setStatus(els.laptopStatus, "No results to download.", "bad");
    return;
  }

  const text = allResults
    .slice()
    .map((item) => {
      const time = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
      return "[" + time + "] " + (item.type || "") + "\n" + (item.value || "") + "\n";
    })
    .join("\n--------------------------\n");

  downloadTextFile(text, "scanner-results.txt", "text/plain");
}

function csvCell(value) {
  const s = String(value || "");
  return '"' + s.replace(/"/g, '""') + '"';
}

function downloadTextFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();

  URL.revokeObjectURL(url);
}

function downloadDataUrl(dataUrl, fileName) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = fileName;
  a.click();
}

async function copyModeLink(mode) {
  const room = cleanRoomCode(els.roomInput.value) || makeDefaultRoom();

  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  url.searchParams.set("mode", mode);

  // The phone needs the https address on the LAN IP, not localhost/http,
  // otherwise the camera stays blocked.
  if (mode === "phone" && serverInfo.httpsEnabled) {
    const ip = (serverInfo.ips || []).find((x) => x !== "127.0.0.1");
    if (ip) {
      url.protocol = "https:";
      url.hostname = ip;
      url.port = String(serverInfo.httpsPort);
    }
  }

  await copyText(url.toString());

  if (mode === "phone") {
    setStatus(els.connectionStatus, "Phone link copied: " + url.toString(), "ok");
  } else {
    setStatus(els.connectionStatus, "Laptop link copied.", "ok");
  }
}

async function clearRoom() {
  if (!connected) {
    setStatus(els.connectionStatus, "Connect first, then clear.", "bad");
    return;
  }

  const ok = confirm("Clear all scan results in this room?");
  if (!ok) return;

  try {
    await fetch("/api/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: currentRoom })
    });

    allResults = [];
    lastSeenId = 0;
    renderResults([]);
    setStatus(els.connectionStatus, "Room results cleared.", "ok");
  } catch (err) {
    setStatus(els.connectionStatus, "Could not clear room.", "bad");
  }
}

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.classList.remove("ok", "bad", "warn");

  if (type === "ok") el.classList.add("ok");
  if (type === "bad") el.classList.add("bad");
  if (type === "warn") el.classList.add("warn");
}
