// Web Worker — PDF processing using pdf.js (ES module worker)
// pdfWorkerUrl must be passed in the first message payload because
// chrome.runtime is not available inside Web Workers.

import { getDocument, GlobalWorkerOptions } from '../libs/pdf.min.mjs';

self.onmessage = async (e) => {
  const { mode, buffer, pdfWorkerUrl } = e.data;

  // Set pdf.js worker src from the URL passed by the main thread
  if (pdfWorkerUrl) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }

  try {
    if (mode === 'extract') {
      const text = await extractText(buffer);
      self.postMessage({ text });
    } else if (mode === 'render') {
      const pages = await renderPages(buffer);
      self.postMessage({ pages });
    } else {
      self.postMessage({ error: `Unknown mode: ${mode}` });
    }
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

async function loadDoc(buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  return await loadingTask.promise;
}

// ── Mode 1: embedded text extraction ────────────────────────────────────────

async function extractText(buffer) {
  const pdf = await loadDoc(buffer);
  const pageTexts = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/ {2,}/g, ' ')
      .trim();
    if (pageText) pageTexts.push(pageText);
  }

  return pageTexts.join('\n\n');
}

// ── Mode 2: render pages to base64 JPEG (scanned PDF OCR via Ollama) ────────

async function renderPages(buffer) {
  const pdf = await loadDoc(buffer);
  const pages = [];
  const SCALE = 2;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const arrayBuf = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
    pages.push(base64);

    self.postMessage({ progress: { page: i, total: pdf.numPages } });
  }

  return pages;
}
