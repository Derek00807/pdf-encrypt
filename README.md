# pdf-encrypt — 本地 PDF 批次加密＋ZIP 下載（Cloudflare Pages / CDN 版）

- **GitHub 只放程式碼**；**Cloudflare Pages 只跑前端**；**不儲存任何檔案在雲端**。
- 依 CSV（`filename;password`）對應每個 PDF 的加密密碼。
- 使用 qpdf-wasm（CDN）在瀏覽器端進行 256-bit 加密，最後打包 ZIP 下載。

## 使用方式
1. 將本專案推到 GitHub（repo 名稱建議：`pdf-encrypt`）。
2. 在 Cloudflare Pages 建專案，**Build output directory 設成 `public/`**（無需 build 指令）。
3. 開啟部署網址，上傳 CSV 與 PDF → 解析 → 開始加密 → 下載 ZIP。

## CSV 範例（需含表頭）
```csv
filename;password
王曉明.pdf;A123456789
簡小德.pdf;B123456789
```

## 注意事項
- 若 CSV 沒有該 PDF 的密碼，該檔會被標示為 SKIP（不會進入 zip）。
- 預設 user 與 owner 密碼相同，並使用命名參數避免 `-` 開頭密碼解析問題。
- 批次量大（~100 份）時可在 `public/app.js` 調整 `CONCURRENCY`（預設 4）。
- 所有加密與壓縮都在瀏覽器記憶體中進行，請使用桌面版現代瀏覽器。

## 相依（CDN）
- @neslinesli93/qpdf-wasm 0.3.0（qpdf WASM）
- PapaParse、JSZip、FileSaver
