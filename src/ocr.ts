// src/ocr.ts
// Usa Google Cloud Vision se c'è la chiave; altrimenti non ritorna testo

export type OCRResult = { text: string; confidence: number };

function dataUrlToBase64(dataUrl: string) {
  return (dataUrl.split(",")[1] || "").trim();
}

export async function ocrImageFromDataUrl(dataUrl: string): Promise<OCRResult> {
  const apiKey = import.meta.env.VITE_VISION_API_KEY as string | undefined;
  if (!apiKey) return { text: "", confidence: 0 };

  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: [
      {
        image: { content: dataUrlToBase64(dataUrl) },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: ["it", "en"] }
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  const ann = json?.responses?.[0]?.fullTextAnnotation;
  const text: string = ann?.text || json?.responses?.[0]?.textAnnotations?.[0]?.description || "";
  // confidenza media stimata (se disponibile)
  let conf = 0, n = 0;
  for (const p of ann?.pages || []) for (const b of p.blocks || []) {
    if (typeof b.confidence === "number") { conf += b.confidence * 100; n++; }
  }
  const confidence = n ? conf / n : (text ? 95 : 0);
  return { text, confidence };
}
