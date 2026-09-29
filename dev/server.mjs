// Local test server: `OFFICE_DEV=1 node dev/server.mjs` runs the site with no Supabase and a stand-in Claude.
// Without OFFICE_DEV it serves the real endpoints, reading settings from the environment.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const mem = globalThis.__officeDev ||= { docs: new Map(), blobs: new Map(), version: 0 };

const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith('/api/') && !url.pathname.slice(5).startsWith('_')) {
      const mod = await import(join(root, 'api', url.pathname.slice(5).replace(/[^a-z-]/g, '') + '.js'));
      const handler = mod[req.method];
      if (!handler) return send(res, 405, { code: 'method_not_allowed' });
      const ctl = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
      const buf = ['GET', 'HEAD'].includes(req.method) ? undefined : await body(req);
      const out = await handler(new Request(url, { method: req.method, headers: req.headers, body: buf, signal: ctl.signal }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (out.body) for await (const chunk of out.body) res.write(chunk);
      return res.end();
    }
    if (process.env.OFFICE_DEV === '1' && url.pathname === '/dev/db') {
      if (req.method === 'GET' && url.searchParams.has('version')) return send(res, 200, { version: mem.version });
      if (req.method === 'GET') return send(res, 200, [...mem.docs.values()].filter(d => d.collection === url.searchParams.get('coll')).map(d => ({ id: d.id, data: d.data })));
      if (req.method === 'PUT') { const { coll, id, data } = JSON.parse(await body(req)); mem.docs.set(coll + '/' + id, { collection: coll, id, data }); mem.version++; return send(res, 200, {}); }
      if (req.method === 'DELETE') { mem.docs.delete(url.searchParams.get('coll') + '/' + url.searchParams.get('id')); mem.version++; return send(res, 200, {}); }
    }
    if (process.env.OFFICE_DEV === '1' && url.pathname.startsWith('/dev/blob/')) {
      const id = url.pathname.slice(10);
      if (req.method === 'PUT') { mem.blobs.set(id, { bytes: await body(req), type: req.headers['content-type'] }); return send(res, 200, {}); }
      const b = mem.blobs.get(id); return b ? send(res, 200, b.bytes, b.type) : send(res, 404, {});
    }
    if (process.env.OFFICE_DEV === '1' && url.pathname === '/dev/seed' && !mem.seeded) {
      mem.seeded = true;
      [['Juno', 'Frontend engineer'], ['Ren', 'Product designer'], ['Theo', 'Copywriter']].forEach(([name, role], i) =>
        mem.docs.set('staff/starter' + i, { collection: 'staff', id: 'starter' + i, data: { name, role, instructions: '', color: ['#3fa37a', '#e06fa6', '#5a8de0'][i], hiredAt: i } }));
      mem.version++; return send(res, 200, {});
    }
    const file = normalize(join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(join(root, 'public'))) return send(res, 403, {});
    send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, 'Not found', 'text/plain');
    console.error(err); if (!res.headersSent) send(res, 500, { code: 'server_error' }); else res.end();
  }
}).listen(port, () => console.log(`AI Office running at http://localhost:${port}`));
