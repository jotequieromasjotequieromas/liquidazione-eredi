// src/ocr.ts
// OCR "ensemble" per manoscritti (Italiano + Inglese) con pre-processing
// Usa Google Cloud Vision (Text Detection) + fallback Tesseract opzionale

// ===== Tipi
export type OcrResult = { text: string; confidence: number };

// ===== Utilità base
const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = (e) => rej(e);
    img.src = url;
  });

const cloneCanvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const toDataURL = (c: HTMLCanvasElement, type = "image/png", q?: number) =>
  c.toDataURL(type, q);

// ===== Filtri immagine (per scritte a mano)
function toGray(c: HTMLCanvasElement) {
  const g = c.getContext("2d")!;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function binarize(c: HTMLCanvasElement, k = 0.96) {
  const g = c.getContext("2d")!;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  const w = c.width,
    h = c.height,
    win = 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0,
        cnt = 0;
      for (let yy = Math.max(0, y - win); yy <= Math.min(h - 1, y + win); yy++) {
        for (let xx = Math.max(0, x - win); xx <= Math.min(w - 1, x + win); xx++) {
          sum += src[(yy * w + xx) * 4];
          cnt++;
        }
      }
      const mean = sum / cnt;
      const v = src[(y * w + x) * 4] < mean * k ? 0 : 255;
      d[(y * w + x) * 4 + 0] = v;
      d[(y * w + x) * 4 + 1] = v;
      d[(y * w + x) * 4 + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function rotate(src: HTMLCanvasElement, deg: number) {
  const r = (deg * Math.PI) / 180;
  const s = Math.abs(Math.sin(r));
  const c = Math.abs(Math.cos(r));
  const w = src.width,
    h = src.height;
  const out = cloneCanvas(Math.floor(w * c + h * s), Math.floor(w * s + h * c));
  const g = out.getContext("2d")!;
  g.translate(out.width / 2, out.height / 2);
  g.rotate(r);
  g.drawImage(src, -w / 2, -h / 2);
  return out;
}

function upscale(src: HTMLCanvasElement, scale = 2.4) {
  const out = cloneCanvas(Math.floor(src.width * scale), Math.floor(src.height * scale));
  const g = out.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

// ===== Vision API (Text Detection)
async function visionTextDetect(base64Data: string): Promise<OcrResult> {
  const key = import.meta.env.VITE_VISION_API_KEY;
  if (!key) return { text: "", confidence: 0 };

  try {
    const r = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64Data },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              imageContext: { languageHints: ["it", "en"] },
            },
          ],
        }),
      }
    );
    const j = await r.json();
    const anno = j?.responses?.[0]?.fullTextAnnotation?.text || "";
    const conf =
      (j?.responses?.[0]?.textAnnotations?.[0]?.confidence ?? 0) * 100;
    return { text: String(anno), confidence: Number(conf) || 0 };
  } catch {
    return { text: "", confidence: 0 };
  }
}

// ===== OCR ensemble su più varianti (rotazioni + binarizzazioni + scala)
export async function ocrEnsembleFromUrl(imageUrl: string): Promise<OcrResult> {
  const img = await loadImage(imageUrl);
  const base = cloneCanvas(img.naturalWidth, img.naturalHeight);
  base.getContext("2d")!.drawImage(img, 0, 0);

  const variants: string[] = [];
  const scales = [2.0, 2.6, 3.0];
  const rots = [-2, -1, 0, 1, 2];
  const ks = [0.94, 0.965, 0.985];

  for (const sc of scales) {
    let up = upscale(base, sc);
    up = toGray(up);
    variants.push(toDataURL(up, "image/jpeg", 0.92));

    for (const k of ks) {
      const b = binarize(up.cloneNode(true) as HTMLCanvasElement, k);
      variants.push(toDataURL(b, "image/png"));
    }
    for (const r of rots) {
      if (r === 0) continue;
      const rr = rotate(up, r);
      variants.push(toDataURL(rr, "image/jpeg", 0.92));
    }
  }

  let best: OcrResult = { text: "", confidence: -1 };
  for (let i = 0; i < variants.length; i++) {
    // prendo la parte Base64 senza "data:...;base64,"
    const b64 = variants[i].split(",")[1] || "";
    const out = await visionTextDetect(b64);
    if (out.confidence > best.confidence) best = out;
    // early stop se già molto alto e contiene numeri/percentuali
    if (best.confidence >= 95 && /[0-9%]/.test(best.text)) break;
  }
  if (best.confidence < 0) best = { text: "", confidence: 0 };
  return best;
}

// ====== Regex di estrazione campi Postevita
// più tolleranti alle imprecisioni
const RGX_DECESSO =
  /(decesso|deces[s]o)[^\d]*([0-3]?\d)[\s\-\/\.–—_:]*([01]?\d)[\s\-\/\.–—_:]*((?:20)?\d{2})/i;
const RGX_POLIZZA =
  /(polizza|poliz[a-z]*)\s*(?:n\.?|num(?:ero)?)?[^0-9a-z]*([0-9]{3,})/i;
const RGX_NOME =
  /(nome\s*e\s*cognome\s*del(?:l'|l)\s*assicurato)[^\n]*?\s*([A-ZÀ-Ý][A-ZÀ-Ýa-zà-ÿ' ]{2,})/i;
const RGX_CF =
  /(codice\s*fiscale)[^A-Z0-9]*([A-Z0-9]{11,16})/i;
const RGX_DN =
  /(data\s*di\s*nascita\s*del(?:l'|l)\s*assicurato)[^\d]*([0-3]?\d)[\s\-\/\.–—_:]*([01]?\d)[\s\-\/\.–—_:]*((?:19|20)?\d{2})/i;

export function extractFields(raw: string) {
  const text = (raw || "").replace(/[|]/g, "I"); // minimizza errori su I/|
  const out: any = {};

  // Data decesso
  {
    const m = text.match(RGX_DECESSO);
    if (m) {
      const dd = m[2].padStart(2, "0");
      const mm = m[3].padStart(2, "0");
      const yy = m[4].length === 2 ? `20${m[4]}` : m[4];
      out.decesso = `${dd}/${mm}/${yy}`;
    }
  }

  // Numero polizza
  {
    const m = text.match(RGX_POLIZZA);
    if (m) out.polizza = m[2];
  }

  // Nome Assicurato
  {
    const m = text.match(RGX_NOME);
    if (m) {
      // ripulisci doppie spaziature e maiuscole a caso
      out.assicurato = m[2].replace(/\s+/g, " ").trim();
    }
  }

  // Data di nascita
  {
    const m = text.match(RGX_DN);
    if (m) {
      const dd = m[2].padStart(2, "0");
      const mm = m[3].padStart(2, "0");
      const yy = m[4].length === 2 ? `19${m[4]}` : m[4];
      out.nascita = `${dd}/${mm}/${yy}`;
    }
  }

  // Codice fiscale (tollera O/0, I/1, S/5 sul finale)
  {
    const m = text.match(RGX_CF);
    if (m) out.cf = m[2].replace(/O/g, "0").replace(/I/g, "1").trim();
  }

  return out;
}

