// public/app.js
// 延遲載入 qpdf-wasm（開始加密時才初始化）
import createQpdf from "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.mjs";
const QPDF_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm";

const $ = (s) => document.querySelector(s);
const log = (m) => { const el = $("#log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };

// 狀態
let records = [];   // [{ filename, password }]
let files = [];     // Array<File>
let zipBlob = null;
let qpdf = null;    // lazy init

// 輸入方式切換（file / paste）
document.querySelectorAll('input[name="mode"]').forEach(r => {
  r.addEventListener('change', () => {
    const mode = getMode();
    $("#file-block").style.display  = (mode === 'file')  ? '' : 'none';
    $("#paste-block").style.display = (mode === 'paste') ? '' : 'none';
  });
});
function getMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'file';
}

// 解析（可用上傳或貼上）
$("#btn-parse").addEventListener("click", async () => {
  try {
    const mode = getMode();

    let parsedRows = [];
    if (mode === 'file') {
      const csvFile = $("#csv").files?.[0];
      if (!csvFile) return alert("請選擇 CSV/TXT 檔案或改用貼上模式");
      parsedRows = await parseCsvFile(csvFile);
    } else {
      const text = $("#csv-text").value || "";
      if (!text.trim()) return alert("請先貼上內容");
      parsedRows = await parseCsvText(text);
    }

    if (!parsedRows?.length) {
      log("[CSV] 內容為空或解析不到資料列");
      return alert("沒有解析到任何資料列");
    }

    records = normalizeRecords(parsedRows);
    files = Array.from($("#pdfs").files || []);
    if (!files.length) return alert("請選擇 PDF");

    renderPreview(records, files);
    $("#btn-start").disabled = false;
    log(`[CSV/TXT] 條目 ${records.length}；[PDF] 檔案 ${files.length}`);
    log("[CSV] 解析完成。");
  } catch (err) {
    console.error(err);
    log("[CSV] 解析失敗：" + (err?.message || err));
    alert("解析失敗：" + (err?.message || err));
  }
});

// 開始加密
$("#btn-start").addEventListener("click", async () => {
  if (!records.length || !files.length)
    return alert("請先解析並選擇 PDF");

  $("#btn-start").disabled = true;
  $("#btn-download").disabled = true;
  zipBlob = null;

  try {
    const q = await getQpdf(); // 此處才載入 qpdf
    const zip = new JSZip();

    const map = new Map(records.map(r => [r.filename, r.password]));
    const total = files.length;
    let done = 0, ok = 0, skipped = 0, failed = 0;

    const CONCURRENCY = 4; // 併發限制
    const queue = files.slice();

    const workers = Array.from({ length: CONCURRENCY }, () => (async function worker() {
      while (queue.length) {
        const file = queue.shift();
        if (!file) break;

        const pw = map.get(file.name) ?? map.get(file.name.trim());
        if (!pw) {
          skipped++; done++; updateProgress(done, total, ok, skipped, failed);
          log(`[SKIP] ${file.name}：無對應密碼`);
          continue;
        }

        try {
          const inPath = `/in_${crypto.randomUUID()}.pdf`;
          const outPath = `/out_${crypto.randomUUID()}.pdf`;
          const input = new Uint8Array(await file.arrayBuffer());
          q.FS.writeFile(inPath, input);

          q.callMain([
            "--encrypt",
            `--user-password=${pw}`,
            `--owner-password=${pw}`,
            "--bits=256",
            "--",
            inPath,
            outPath,
          ]);

          const output = q.FS.readFile(outPath);
          zip.file(file.name, output);

          try { q.FS.unlink(inPath); } catch {}
          try { q.FS.unlink(outPath); } catch {}

          ok++; done++; updateProgress(done, total, ok, skipped, failed);
          log(`[OK]   ${file.name}`);
        } catch (e) {
          failed++; done++; updateProgress(done, total, ok, skipped, failed);
          log(`[ERR]  ${file.name} → ${e?.message || e}`);
        }
      }
    })()));

    await Promise.all(workers);

    zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    $("#btn-download").disabled = false;
    log("— 全部處理完成，可下載 ZIP —");
    updateProgress(total, total, ok, skipped, failed);
  } catch (e) {
    log("[RUN] 執行失敗：" + (e?.message || e));
    alert("執行失敗：" + (e?.message || e));
  }
});

// 下載 ZIP
$("#btn-download").addEventListener("click", () => {
  if (!zipBlob) return alert("尚未產生 ZIP");
  saveAs(zipBlob, `encrypted_pdfs_${Date.now()}.zip`);
});

// 延遲初始化 qpdf
async function getQpdf() {
  if (qpdf) return qpdf;
  log("[INIT] 下載/初始化加密引擎（qpdf-wasm）中…");
  qpdf = await createQpdf({
    locateFile: () => QPDF_WASM_URL,
    noInitialRun: true,
    preRun: [(module) => {
      if (!module.FS) throw new Error("qpdf FS not available");
    }],
  });
  log("[INIT] 加密引擎就緒。");
  return qpdf;
}

// UI
function updateProgress(done, total, ok = 0, skipped = 0, failed = 0) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#bar").style.width = pct + "%";
  $("#stats").textContent = `進度 ${pct}%（完成 ${done}/${total}） ✓${ok}｜⏭︎${skipped}｜✗${failed}`;
}
function renderPreview(rows, files) {
  const set = new Set(rows.map(r => r.filename));
  const matched = files.filter(f => set.has(f.name)).length;
  const html = `
    <div>條目：<b>${rows.length}</b>，PDF：<b>${files.length}</b>，可匹配：<b>${matched}</b></div>
    <ul>
      ${files.slice(0, 10).map(f => `<li>${f.name} ${set.has(f.name) ? "✅" : "⚠️ 無密碼"}</li>`).join("")}
    </ul>
    ${files.length > 10 ? '<div class="muted">（僅示前 10 筆）</div>' : ""}
  `;
  $("#preview").innerHTML = html;
}

/* ---------- 解析與正規化 ---------- */

// 解析「上傳檔案」
async function parseCsvFile(file) {
  const text = await file.text();
  return parseCsvText(text);
}

// 解析「貼上文字」
async function parseCsvText(rawText) {
  const normalized = rawText
    .replaceAll("；", ";")
    .replaceAll("，", ",")
    .replace(/\r\n/g, "\n");

  return new Promise((resolve, reject) => {
    Papa.parse(normalized, {
      header: true,                  // 先假設有表頭（normalizeRecords 會處理無表頭）
      skipEmptyLines: true,
      delimitersToGuess: [",", ";", "\t", "|"],
      complete: (res) => resolve(res.data || []),
      error: (err) => reject(err),
    });
  });
}

// 把 PapaParse 結果轉成 { filename, password }
function normalizeRecords(rows) {
  const hasHeader =
    rows.length && rows[0] &&
    (Object.prototype.hasOwnProperty.call(rows[0], "filename") ||
     Object.prototype.hasOwnProperty.call(rows[0], "FILENAME") ||
     Object.prototype.hasOwnProperty.call(rows[0], "檔名") ||
     Object.prototype.hasOwnProperty.call(rows[0], "password") ||
     Object.prototype.hasOwnProperty.call(rows[0], "PASSWORD") ||
     Object.prototype.hasOwnProperty.call(rows[0], "密碼"));

  let out = [];
  if (hasHeader) {
    out = rows.map(r => {
      const filename = (r.filename ?? r.FILENAME ?? r["檔名"] ?? "").toString().trim();
      const password = (r.password ?? r.PASSWORD ?? r["密碼"] ?? "").toString().trim();
      return { filename: stripTrailingSemi(filename), password: stripTrailingSemi(password) };
    });
  } else {
    out = rows.map(r => {
      const vals = Object.values(r);
      if (vals.length < 2) return null;
      const filename = stripTrailingSemi((vals[0] ?? "").toString().trim());
      const password = stripTrailingSemi((vals[1] ?? "").toString().trim());
      if (!filename || !password) return null;
      return { filename, password };
    }).filter(Boolean);
  }

  // 去重（後者覆蓋前者）
  const map = new Map();
  for (const row of out) {
    if (!row.filename || !row.password) continue;
    map.set(row.filename, row.password);
  }
  return Array.from(map, ([filename, password]) => ({ filename, password }));
}

function stripTrailingSemi(s) { return s.replace(/;+$/, ""); }