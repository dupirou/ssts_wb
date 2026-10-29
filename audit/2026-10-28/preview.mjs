// Local-only adapter for the unmodified production Worker and static baseline.
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import worker from '../../src/worker.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const mime = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json'};
async function asset(input) {
  try {
    const url = new URL(input.url || input);
    let path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) return new Response('Forbidden', {status:403});
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    return new Response(await readFile(path), {headers:{'Content-Type':mime[extname(path)] || 'application/octet-stream'}});
  } catch (_) {return new Response('Not found', {status:404});}
}
const env = {ASSETS:{fetch:asset}};
createServer(async (req,res) => {
  try {
    const response = await worker.fetch(new Request('http://127.0.0.1:8767' + req.url, {method:req.method}), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {res.writeHead(500);res.end(String(error));}
}).listen(8767, '127.0.0.1', () => console.log('Local audit preview http://127.0.0.1:8767'));
