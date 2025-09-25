export async function extractTextFromImage(base64Image: string): Promise<string> {
  const apiKey = import.meta.env.VITE_VISION_API_KEY; // la chiave la leggeremo da GitHub/Env
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  return data.responses?.[0]?.fullTextAnnotation?.text || "";
}
