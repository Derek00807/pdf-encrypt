// public/app.js
// 只貼上密碼檔、多個 PDF，上述流程；輸出 ZIP 內含兩個資料夾
import createQpdf from "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.mjs";
const QPDF_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm";

const $ = (s) => document.querySelector(s);
const log = (m) => { const el = $("#log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };

let zipBlob = null;
let qpdf = null; // lazy

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

$("#btn-start").addEventListener("click", async () => {
  const text = ($("#mapping").value || "").trim();
  const files = Array.from($("#pdfs").files || []);

  if (!text) return alert("請先貼上密碼檔內容");
  if (!files.length) return alert("請選擇 PDF 檔案");
  if (files.length > 100) return alert("最多同時處理 100 份 PDF，請分批上傳");

  const mapping = parseMapping(text); // Map<filename, password>
  if (!mapping.size) return alert("未解析到任何有效的『檔名→密碼』對應");

  // UI 狀態
  $("#btn-start").disabled = true;
  $("#btn-download").disabled = true;
  zipBlob = null;
  clearProgress();

  try {
    const q = await getQpdf();
    const zip = new JSZip();

    // 兩個資料夾
    const okFolder   = zip.folder("encrypted_已加密");
    const badFolder  = zip.folder("not_encrypted_未成功加密");

    const total = files.length;
    let done = 0, ok = 0, skipped = 0, failed = 0;

    // 供 SUMMARY.txt 使用
    const reportLines = [];
    reportLines.push(`# PDF 批次加密結果`);
    reportLines.push(`# 生成時間：${new Date().toISOString()}`);
    reportLines.push(`# 規則：貼上「檔名.pdf;密碼;」→ 找不到即視為未成功加密（原檔放入 not_encrypted_未成功加密/）`);
    reportLines.push("");

    // 併發限制
    const CONCURRENCY = 4;
    const queue = files.slice();

    const workers = Array.from({ length: CONCURRENCY }, () => (async function worker() {
      while (queue.length) {
        const file = queue.shift();
        if (!file) break;

        const pw = mapping.get(file.name) ?? mapping.get(file.name.trim());
        if (!pw) {
          skipped++; done++; updateProgress(done, total, ok, skipped, failed);
          log(`[SKIP] 找不到密碼：${file.name}`);
          reportLines.push(`SKIP\t${file.name}\t找不到密碼`);
          // 把「原始 PDF」放到未成功資料夾，方便後續人工處理
          const origBytes = new Uint8Array(await file.arrayBuffer());
          badFolder.file(file.name, origBytes);
          continue;
        }

        try {
          const inPath  = `/in_${crypto.randomUUID()}.pdf`;
          const outPath = `/out_${crypto.randomUUID()}.pdf`;
          const input   = new Uint8Array(await file.arrayBuffer());
          q.FS.writeFile(inPath, input);

          // AES-256，加 user/owner 同密碼；用命名參數避免 - 開頭密碼解析問題
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
          okFolder.file(file.name, output);

          try { q.FS.unlink(inPath); } catch {}
          try { q.FS.unlink(outPath); } catch {}

          ok++; done++; updateProgress(done, total, ok, skipped, failed);
          log(`[OK]   加密完成：${file.name}`);
          reportLines.push(`OK\t${file.name}\t加密成功`);
        } catch (e) {
          failed++; done++; updateProgress(done, total, ok, skipped, failed);
          const msg = e?.message || String(e);
          log(`[ERR]  加密失敗：${file.name} → ${msg}`);
          reportLines.push(`ERR\t${file.name}\t${msg}`);

          // 失敗也把原檔放到未成功資料夾
          try {
            const origBytes = new Uint8Array(await file.arrayBuffer());
            badFolder.file(file.name, origBytes);
          } catch {}
        }
      }
    })()));

    await Promise.all(workers);

    // 寫入 SUMMARY.txt
    reportLines.push("");
    reportLines.push(`總數：${total}　成功：${ok}　找不到密碼：${skipped}　加密失敗：${failed}`);
    zip.file("SUMMARY.txt", reportLines.join("\n"));

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
  } finally {
    $("#btn-start").disabled = false;
  }
});

$("#btn-download").addEventListener("click", () => {
  if (!zipBlob) return alert("尚未產生 ZIP");
  saveAs(zipBlob, `encrypted_pdfs_${Date.now()}.zip`);
});

/* ------------ 工具們 ------------ */

function parseMapping(raw) {
  // 正規化：全形標點轉半形；CRLF→LF
  const text = raw.replaceAll("；", ";").replaceAll("，", ",").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const map = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // 空行

    // 主要使用 ';'；盡量相容 , / Tab / |
    let parts = line.split(";");
    if (parts.length < 2) {
      if (line.includes(",")) parts = line.split(",");
      else if (line.includes("\t")) parts = line.split("\t");
      else if (line.includes("|")) parts = line.split("|");
    }
    const filename = stripTrailingSemi((parts[0] || "").trim());
    const password = stripTrailingSemi((parts[1] || "").trim());

    if (!filename || !password) {
      log(`[WARN] 第 ${i + 1} 行格式不完整，已忽略：${line}`);
      continue;
    }
    map.set(filename, password); // 後者覆蓋前者
  }
  return map;
}

function stripTrailingSemi(s) {
  return s.replace(/;+$/, ""); // 去掉行尾多餘分號
}

function clearProgress() {
  updateProgress(0, 1, 0, 0, 0);
  $("#log").textContent = "";
  $("#stats").textContent = "開始處理…";
}

function updateProgress(done, total, ok = 0, skipped = 0, failed = 0) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#bar").style.width = pct + "%";
  $("#stats").textContent =
    `進度 ${pct}%（完成 ${done}/${total}） ✓${ok}｜⏭︎${skipped}｜✗${failed}`;
}