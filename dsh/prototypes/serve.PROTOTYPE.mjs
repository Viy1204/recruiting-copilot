// PROTOTYPE — 用完即弃。票 #22。
// 托管 mouse-trace 测试页并收集上报。纯本地，不联网。
//   node dsh/prototypes/serve.PROTOTYPE.mjs [port=8899]
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8899);
const LOG = join(here, 'reports.PROTOTYPE.jsonl');

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    for await (const c of req) body += c;
    await appendFile(LOG, body + '\n');
    const b = JSON.parse(body);
    console.log(`[report] ${b.tag} | moves=${b.moves} rate=${b.rate}/s gapMedian=${b.gapMedian} gapMax=${b.gapMax} jumps60=${b.jumps60} headless=${b.headless}`);
    res.writeHead(204).end();
    return;
  }
  if (req.url === '/' || req.url.startsWith('/index')) {
    const html = await readFile(join(here, 'mouse-trace.PROTOTYPE.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mouse-trace PROTOTYPE: http://127.0.0.1:${PORT}/`);
  console.log(`上报写入 ${LOG}`);
});
