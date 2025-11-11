// public/app.js
// 以 ESM 直接從 CDN 載入 qpdf-wasm
// 來源：@neslinesli93/qpdf-wasm（0.3.0）
import createQpdf from "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.mjs";

const QPDF_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm";

const $ = (s) => document.querySelector(s);
const log = (m) => {
  const el = $("#log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
};

let records = []; // 解析後：[{ filename, password }]
let files = [];   // Array<File>
let zipBlob = null;

// 初始化 qpdf wasm（一次）
const qpdf = await createQpdf({
  locateFile: () => QPDF_WASM_URL,
  noInitialRun: true,
  preRun: [(module) => {
    if (!module.FS) throw new Error("qpdf FS not available");
  }],
});

$("#btn-parse").addEventListener("click", async () => {
  const csvFile = $("#csv").files?.[0];
  if (!csvFile) return alert("請選擇 CSV/TXT");

  try {
    const parsedRows = await parseCsv(csvFile); // array of objects or arrays
    if (!parsedRows?.length) return alert("CSV/TXT 內容為空");

    // 轉成標準 { filename, password }
    records = normalizeRecords(parsedRows);

    files = Array.from($("#pdfs").files || []);
    if (!files.length) return alert("請選擇 PDF");

    renderPreview(records, files);
    $("#btn-start").disabled = false;
    log(`[CSV/TXT] 條目 ${records.length}；[PDF] 檔案 ${files.length}`);
  } catch (err) {
    console.error(err);
    alert("解析失敗：" + (err?.message || err));
  }
});

$("#btn-start").addEventListener("click", async () => {
  if (!records.length || !files.length)
    return alert("請先解析 CSV/TXT 與選擇 PDF");
  $("#btn-start").disabled = true;
  $("#btn-download").disabled = true;
  zipBlob = null;

  const map = new Map(records.map((r) => [r.filename, r.password]));
  const total = files.length;
  let done = 0,
    ok = 0,
    skipped = 0,
    failed = 0;

  const zip = new JSZip();

  // 併發限制，避免一次處理 100 份造成卡頓
  const CONCURRENCY = 4;
  const queue = files.slice();

  const workers = Array.from({ length: CONCURRENCY }, () =>
    (async function worker() {
      while (queue.length) {
        const file = queue.shift();
        if (!file) break;

        const pw = map.get(file.name) ?? map.get(file.name.trim());
        if (!pw) {
          skipped++;
          done++;
          updateProgress(done, total, ok, skipped, failed);
          log(`[SKIP] ${file.name}：CSV/TXT 無對應密碼`);
          continue;
        }

        try {
          // 寫入 qpdf 虛擬檔案系統
          const inPath = `/in_${crypto.randomUUID()}.pdf`;
          const outPath = `/out_${crypto.randomUUID()}.pdf`;
          const input = new Uint8Array(await file.arrayBuffer());
          qpdf.FS.writeFile(inPath, input);

          // 使用 qpdf 進行 256-bit 加密（用命名參數避免 - 開頭密碼解析問題）
          const args = [
            "--encrypt",
            `--user-password=${pw}`,
            `--owner-password=${pw}`,
            "--bits=256",
            "--",
            inPath,
            outPath,
          ];

          qpdf.callMain(args);

          // 讀出加密後檔案
          const output = qpdf.FS.readFile(outPath);
          zip.file(file.name, output);

          // 清理暫存
          try {
            qpdf.FS.unlink(inPath);
          } catch {}
          try {
            qpdf.FS.unlink(outPath);
          } catch {}

          ok++;
          done++;
          updateProgress(done, total, ok, skipped, failed);
          log(`[OK]   ${file.name}`);
        } catch (e) {
          failed++;
          done++;
          updateProgress(done, total, ok, skipped, failed);
          log(`[ERR]  ${file.name} → ${e?.message || e}`);
        }
      }
    })()
  );

  await Promise.all(workers);

  zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  $("#btn-download").disabled = false;
  log("— 全部處理完成，可下載 ZIP —");
  updateProgress(total, total, ok, skipped, failed);
});

$("#btn-download").addEventListener("click", () => {
  if (!zipBlob) return alert("尚未產生 ZIP");
  saveAs(zipBlob, `encrypted_pdfs_${Date.now()}.zip`);
});

function updateProgress(done, total, ok = 0, skipped = 0, failed = 0) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#bar").style.width = pct + "%";
  $("#stats").textContent = `進度 ${pct}%（完成 ${done}/${total}） ✓${ok}｜⏭︎${skipped}｜✗${failed}`;
}

function renderPreview(rows, files) {
  const set = new Set(rows.map((r) => r.filename));
  const matched = files.filter((f) => set.has(f.name)).length;
  const html = `
    <div>CSV/TXT 條目：<b>${rows.length}</b>，PDF 檔案：<b>${files.length}</b>，可匹配：<b>${matched}</b></div>
    <ul>
      ${files
        .slice(0, 10)
        .map(
          (f) => `<li>${f.name} ${set.has(f.name) ? "✅" : "⚠️ 無密碼"}</li>`
        )
        .join("")}
    </ul>
    ${files.length > 10 ? '<div class="muted">（僅示前 10 筆）</div>' : ""}
  `;
  $("#preview").innerHTML = html;
}

/**
 * 解析 CSV/TXT：
 * - 支援 .csv 與 .txt
 * - 自動偵測分隔符（, ; \t |）
 * - 可處理「無表頭」與行尾多一個分號 ';'
 * - 允許中文分號/逗號（；，）並先正規化
 */
async function parseCsv(file) {
  // 讀文字做前處理（為了把全形 ;、, 轉半形）
  const rawText = await file.text();
  const normalized = rawText
    .replaceAll("；", ";")
    .replaceAll("，", ",")
    .replace(/\r\n/g, "\n"); // 正規化換行

  // 用 PapaParse 解析字串（不是檔案物件），才能吃到我們正規化後的內容
  return new Promise((resolve, reject) => {
    Papa.parse(normalized, {
      header: true, // 先假設有表頭
      skipEmptyLines: true,
      delimitersToGuess: [",", ";", "\t", "|"],
      complete: (res) => {
        if (Array.isArray(res?.data) && res.data.length) {
          resolve(res.data);
        } else {
          resolve([]);
        }
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * 將 PapaParse 的結果轉成標準 { filename, password }
 * - 若偵測無表頭（或表頭未知），以第一欄、第二欄為 filename/password
 * - 移除欄位值尾端多餘分號
 */
function normalizeRecords(rows) {
  // 1) 判斷是否有表頭
  const hasHeader =
    rows.length &&
    rows[0] &&
    (Object.prototype.hasOwnProperty.call(rows[0], "filename") ||
      Object.prototype.hasOwnProperty.call(rows[0], "FILENAME") ||
      Object.prototype.hasOwnProperty.call(rows[0], "檔名") ||
      Object.prototype.hasOwnProperty.call(rows[0], "password") ||
      Object.prototype.hasOwnProperty.call(rows[0], "PASSWORD") ||
      Object.prototype.hasOwnProperty.call(rows[0], "密碼"));

  // 2) 轉換
  let out = [];
  if (hasHeader) {
    out = rows.map((r) => {
      const filename =
        (r.filename ?? r.FILENAME ?? r["檔名"] ?? "").toString().trim();
      const password =
        (r.password ?? r.PASSWORD ?? r["密碼"] ?? "").toString().trim();
      return {
        filename: stripTrailingSemi(filename),
        password: stripTrailingSemi(password),
      };
    });
  } else {
    // 無表頭：把每列物件的前兩個值當作 filename/password
    out = rows
      .map((r) => {
        const vals = Object.values(r);
        if (vals.length < 2) return null;
        const filename = stripTrailingSemi(vals[0]?.toString().trim() || "");
        const password = stripTrailingSemi(vals[1]?.toString().trim() || "");
        if (!filename || !password) return null;
        return { filename, password };
      })
      .filter(Boolean);
  }

  // 3) 移除空列、去重（以最後一次為準）
  const map = new Map();
  for (const row of out) {
    if (!row.filename || !row.password) continue;
    map.set(row.filename, row.password);
  }
  return Array.from(map, ([filename, password]) => ({ filename, password }));
}

// 去除字尾多餘分號（常見：最後一欄以 ; 結尾）
function stripTrailingSemi(s) {
  return s.replace(/;+$/, "");
}