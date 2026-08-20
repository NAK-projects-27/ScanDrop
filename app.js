/*
  Private Scanner - client logic
  ==============================
  Talks ONLY to the local Python server (server.py) on your own network.
  No Firebase, no cloud, no external database.

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
  manualText: document.getElementById("manualText"),
  sendTextBtn: document.getElementById("sendTextBtn"),

  imageInput: document.getElementById("imageInput"),
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
els.sendTextBtn.addEventListener("click", sendManualText);

els.imageInput.addEventListener("change", previewSelectedImage);
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

  try {
    const formats = [
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

    scanner = new Html5Qrcode("reader", {
      formatsToSupport: formats,
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
  async (decodedText, decodedResult) => {
    await sendScan({
      type: "barcode_or_qr",
      value: decodedText,
      format:
        decodedResult &&
        decodedResult.result &&
        decodedResult.result.format
          ? decodedResult.result.format.formatName
          : "Unknown"
    });
  },
  () => {}
);

    scannerRunning = true;
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

async function runOcr(file) {
  const result = await Tesseract.recognize(file, "eng", {
    logger: (m) => {
      if (m.status && typeof m.progress === "number") {
        const pct = Math.round(m.progress * 100);
        setStatus(els.phoneStatus, "OCR: " + m.status + " " + pct + "%", "warn");
      }
    }
  });

  return (result && result.data && result.data.text) ? result.data.text : "";
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

  await copyText(url.toString());

  if (mode === "phone") {
    setStatus(els.connectionStatus, "Phone link copied. Open it on your phone (same Wi-Fi).", "ok");
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
