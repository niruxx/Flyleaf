'use strict';
// Renders the app icons in public/icons from an inline SVG (requires sharp).
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const out = path.join(__dirname, '..', 'public', 'icons');

function svg({ rounded = true, scale = 1 } = {}) {
  const t = (512 - 512 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6a5ae0"/>
      <stop offset="1" stop-color="#3b2f99"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 116 : 0}" fill="url(#bg)"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <path d="M92 170c62-30 122-28 156 6v214c-36-30-96-32-156-6z" fill="#ffffff"/>
    <path d="M420 170c-62-30-122-28-156 6v214c36-30 96-32 156-6z" fill="#e4dfff"/>
    <path d="M330 150h44v132l-22-18-22 18z" fill="#ff8a7a"/>
  </g>
</svg>`;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.svg'), svg());
  const jobs = [
    ['icon-192.png', 192, svg()],
    ['icon-512.png', 512, svg()],
    ['icon-maskable-512.png', 512, svg({ rounded: false, scale: 0.78 })],
    ['apple-touch-icon.png', 180, svg({ rounded: false, scale: 0.86 })],
  ];
  for (const [name, size, src] of jobs) {
    await sharp(Buffer.from(src)).resize(size, size).png().toFile(path.join(out, name));
    console.log('wrote', name);
  }
})();
