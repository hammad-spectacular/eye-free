/* Standalone static server for the Fee Voucher Generator demo.
 *
 * The generator is a self-contained page (voucher-generator.html +
 * voucher-engine.js + voucher-demo-api.js) with no server-side API, so a
 * plain static server is all it needs. It is NOT wired into serverg.js —
 * this file exists only so the demo can be opened in a browser.
 *
 * Usage:
 *   node serve-voucher-demo.js          -> http://localhost:4310/voucher-generator.html
 *   node serve-voucher-demo.js 5000     -> use another port
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 4310);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  // The page asks whether the real fee service is there. On this standalone
  // server there is none, so it is told plainly instead of getting an error.
  if (url === '/api/fees/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ service: 'fees', signedIn: false }));
    return;
  }

  const rel = url === '/' ? 'voucher-generator.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  if (!file.startsWith(path.resolve(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('Fee Voucher Generator demo: http://localhost:' + PORT + '/voucher-generator.html');
});
