// 以 ESM 直接從 CDN 載入 qpdf-wasm
import createQpdf from "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.mjs";

const QPDF_WASM_URL = "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm";

const $ = (s) => document.querySelector(s);
const log = (m) => { const el = $('#log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; };

let records = [];  // CSV 解析後 [{ filename, password }]
let files = [];    // Array<File>
let zipBlob = null;

// 初始化 qpdf wasm
const qpdf = await createQpdf({
  locateFile: () => QPDF_WASM_URL,
  noInitialRun: true,
  preRun: [ (module) => {
    if (!module.FS) throw new Error('qpdf FS not available');
  }]
});

$('#btn-parse').addEventListener('click', async () => {
  const csvFile = $('#csv').files?.[0];
  if (!csvFile) return alert('請選擇 CSV');

  const parsed = await parseCsv(csvFile);
  if (!parsed?.length) return alert('CSV 內容為空');

  // 正規化欄位名，允許大小寫/中英文
  records = parsed.map(r => ({
    filename: String(r.filename ?? r.FILENAME ?? r['檔名'] ?? '').trim(),
    password: String(r.password ?? r.PASSWORD ?? r['密碼'] ?? '').trim(),
  })).filter(r => r.filename && r.password);

  files = Array.from($('#pdfs').files || []);
  if (!files.length) return alert('請選擇 PDF');

  renderPreview(records, files);
  $('#btn-start').disabled = false;
  log(`[CSV] 條目 ${records.length}；[PDF] 檔案 ${files.length}`);
});

$('#btn-start').addEventListener('click', async () => {
  if (!records.length || !files.length) return alert('請先解析 CSV 與選擇 PDF');
  $('#btn-start').disabled = true;
  $('#btn-download').disabled = true;
  zipBlob = null;

  const map = new Map(records.map(r => [r.filename, r.password]));
  const total = files.length;
  let done = 0, ok = 0, skipped = 0, failed = 0;

  const zip = new JSZip();

  // 併發限制，避免 100 份同時處理造成卡頓
  const CONCURRENCY = 4;
  const queue = files.slice();

  const workers = Array.from({ length: CONCURRENCY }, () => (async function worker(){
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;

      const pw = map.get(file.name);
      if (!pw) {
        skipped++; done++; updateProgress(done, total, ok, skipped, failed);
        log(`[SKIP] ${file.name}：CSV 無對應密碼`);
        continue;
      }

      try {
        // 將原始 PDF 寫入 qpdf 虛擬檔案系統
        const inPath = `/in_${crypto.randomUUID()}.pdf`;
        const outPath = `/out_${crypto.randomUUID()}.pdf`;
        const input = new Uint8Array(await file.arrayBuffer());
        qpdf.FS.writeFile(inPath, input);

        // 使用 qpdf 進行 256-bit 加密
        const user = pw;          // 使用者密碼
        const owner = pw;         // 擁有者密碼（同 user）
        const args = [
          "--encrypt",
          `--user-password=${user}`,
          `--owner-password=${owner}`,
          "--bits=256",
          "--",
          inPath,
          outPath
        ];

        qpdf.callMain(args);

        // 讀出加密後檔案
        const output = qpdf.FS.readFile(outPath);
        zip.file(file.name, output);

        // 清理暫存
        try { qpdf.FS.unlink(inPath); } catch {}
        try { qpdf.FS.unlink(outPath); } catch {}

        ok++; done++; updateProgress(done, total, ok, skipped, failed);
        log(`[OK]   ${file.name}`);
      } catch (e) {
        failed++; done++; updateProgress(done, total, ok, skipped, failed);
        log(`[ERR]  ${file.name} → ${e?.message || e}`);
      }
    }
  })());

  await Promise.all(workers);

  zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  $('#btn-download').disabled = false;
  log('— 全部處理完成，可下載 ZIP —');
  updateProgress(total, total, ok, skipped, failed);
});

$('#btn-download').addEventListener('click', () => {
  if (!zipBlob) return alert('尚未產生 ZIP');
  saveAs(zipBlob, `encrypted_pdfs_${Date.now()}.zip`);
});

function updateProgress(done, total, ok = 0, skipped = 0, failed = 0) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#bar').style.width = pct + '%';
  $('#stats').textContent = `進度 ${pct}%（完成 ${done}/${total}） ✓${ok}｜⏭︎${skipped}｜✗${failed}`;
}

function renderPreview(rows, files) {
  const set = new Set(rows.map(r => r.filename));
  const matched = files.filter(f => set.has(f.name)).length;
  const html = `
    <div>CSV 條目：<b>${rows.length}</b>，PDF 檔案：<b>${files.length}</b>，可匹配：<b>${matched}</b></div>
    <ul>
      ${files.slice(0, 10).map(f => `<li>${f.name} ${set.has(f.name) ? '✅' : '⚠️ 無密碼'}</li>`).join('')}
    </ul>
    ${files.length > 10 ? '<div class="muted">（僅示前 10 筆）</div>' : ''}
  `;
  $('#preview').innerHTML = html;
}

async function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      delimiter: ';',
      skipEmptyLines: true,
      complete: (res) => resolve(res.data || []),
      error: (err) => reject(err)
    });
  });
}
