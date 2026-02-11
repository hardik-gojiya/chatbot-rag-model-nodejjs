import axios from "axios";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

function normalizePDFText(text) {
  return text.replace(/\s+/g, " ").trim();
}

export async function parsePDFfromURL(pdfUrl) {
  try {
    const response = await axios.get(pdfUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/pdf",
      },
    });

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(response.data),
      disableFontFace: true,
    });

    const pdf = await loadingTask.promise;

    let fullText = "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      const pageText = content.items.map((item) => item.str).join(" ");

      fullText += pageText + "\n";
    }

    return {
      text: normalizePDFText(fullText),
      pages: pdf.numPages,
    };
  } catch (err) {
    console.error("PDF parse failed:", pdfUrl, err.message);
    return {
      text: "",
      pages: 0,
      error: err.message,
    };
  }
}
