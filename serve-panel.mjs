/** 极简静态服务器，只为了给面板预览页截图。 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 17794;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'panel-preview.html');
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${PORT}/panel-preview.html`));
