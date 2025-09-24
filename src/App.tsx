import React, { useState } from "react";
import Tesseract from "tesseract.js";

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [imgUrls, setImgUrls] = useState<string[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [status, setStatus] = useState("Pronto");
  const [ocrText, setOcrText] = useState("");

  async function fileToDataUrl(f: File) {
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onerror = () => rej(new Error("lettura file"));
      fr.onload = () => res(String(fr.result || ""));
      fr.readAsDataURL(f);
    });
  }

  async function preparaAnteprima() {
    if (!files.length) { alert("Seleziona almeno un file"); return; }
    setStatus("Conversione…");
    const f = files[0];
    const name = f.name.toLowerCase();
    const type = (f.type || "").toLowerCase();
    const isImg = /^image\//.test(type) || /\.(png|jpe?g|webp|bmp|gif|tif?f|heic)$/.test(name);
    try {
      if (isImg) {
        const url = await fileToDataUrl(f);
        setImgUrls([url]); setPageIdx(0); setStatus("Pronto");
      } else {
        setImgUrls([]);
        setStatus("Anteprima PDF non disponibile qui. Carica un'immagine (JPG/PNG) per provare l’OCR.");
      }
    } catch { setStatus("Errore conversione"); }
  }

  async function leggiQuestaPagina() {
    if (!imgUrls.length) { alert("Nessuna immagine"); return; }
    setStatus("OCR in corso…"); setOcrText("");
    try {
      const r: any = await Tesseract.recognize(imgUrls[pageIdx], "ita+eng", { logger: () => {} });
      setOcrText(String(r?.data?.text || ""));
      setStatus(`Fatto (confidenza: ${Math.round(Number(r?.data?.confidence || 0))}%)`);
    } catch { setStatus("Errore OCR"); }
  }

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, Arial, sans-serif" }}>
      <h2 style={{ marginTop: 0 }}>Liquidazione polizza – Riparto eredi</h2>
      <div style={{ color: "#6b7280", marginBottom: 12 }}>{status}</div>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, background: "#f3f4f6", cursor: "pointer" }}>
        📁 Scegli i file
        <input type="file" multiple onChange={(e) => { setFiles(Array.from(e.target.files || [])); setImgUrls([]); setOcrText(""); setStatus("Pronto"); }} style={{ display: "none" }}/>
      </label>

      <div style={{ display: "inline-flex", gap: 8, marginLeft: 8 }}>
        <button onClick={preparaAnteprima} disabled={!files.length}>Prepara anteprima</button>
        <button onClick={leggiQuestaPagina} disabled={!imgUrls.length}>Leggi questa pagina</button>
      </div>

      {imgUrls.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, color: "#6b7280", fontSize: 12 }}>
            <div>Pagina {pageIdx + 1} di {imgUrls.length}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={pageIdx <= 0}>◀</button>
              <button onClick={() => setPageIdx((i) => Math.min(imgUrls.length - 1, i + 1))} disabled={pageIdx >= imgUrls.length - 1}>▶</button>
            </div>
          </div>
          <img src={imgUrls[pageIdx]} alt="pagina" style={{ maxWidth: "100%", border: "1px solid #ddd" }} />
        </div>
      )}

      {ocrText && (
        <details style={{ marginTop: 12 }} open>
          <summary>Testo OCR</summary>
          <textarea value={ocrText} onChange={(e) => setOcrText(e.target.value)} style={{ width: "100%", height: 160 }} />
        </details>
      )}
    </div>
  );
}
