// Run once: node setup-libs.js
// Downloads pdfjs-dist build files into libs/ so the extension works offline.

const https = require('https');
const fs = require('fs');
const path = require('path');

const LIBS_DIR = path.join(__dirname, 'libs');
if (!fs.existsSync(LIBS_DIR)) fs.mkdirSync(LIBS_DIR);

const FILES = [
  {
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs',
    dest: path.join(LIBS_DIR, 'pdf.min.mjs'),
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs',
    dest: path.join(LIBS_DIR, 'pdf.worker.min.mjs'),
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  already exists: ${path.basename(dest)}`);
      return resolve();
    }
    console.log(`  downloading: ${path.basename(dest)} …`);
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

(async () => {
  console.log('Setting up libs…');
  for (const f of FILES) await download(f.url, f.dest);
  console.log('Done. You can now load the extension in Chrome.');
})();
