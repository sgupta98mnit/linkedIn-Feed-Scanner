// Run with Node.js to generate PNG icons from the SVG
// Usage: node generate-icons.js
// Requires: npm install sharp

const fs = require('fs');
const path = require('path');

async function generate() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('sharp not found. Using fallback: copying SVG as placeholder.');
    // Fallback: create minimal 1x1 transparent PNGs so the extension loads
    const { createCanvas } = require('canvas');
    for (const size of [16, 48, 128]) {
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0a66c2';
      ctx.roundRect(0, 0, size, size, size * 0.18);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.fillRect(size * 0.17, size * 0.25, size * 0.66, size * 0.1);
      ctx.fillRect(size * 0.17, size * 0.42, size * 0.5, size * 0.09);
      ctx.fillRect(size * 0.17, size * 0.57, size * 0.56, size * 0.09);
      const buf = canvas.toBuffer('image/png');
      fs.writeFileSync(path.join(__dirname, `icon${size}.png`), buf);
      console.log(`Generated icon${size}.png`);
    }
    return;
  }

  const svgBuf = fs.readFileSync(path.join(__dirname, 'icon.svg'));
  for (const size of [16, 48, 128]) {
    await sharp(svgBuf)
      .resize(size, size)
      .png()
      .toFile(path.join(__dirname, `icon${size}.png`));
    console.log(`Generated icon${size}.png`);
  }
}

generate().catch(console.error);
