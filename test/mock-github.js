// Fake GitHub Releases API for updater tests. mode: good | badsum | none | same
const http = require('http'); const crypto = require('crypto');
module.exports = (mode) => new Promise(res => {
  const payload = crypto.randomBytes(3 * 1024 * 1024);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const srv = http.createServer((req, r) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url === '/latest') {
      if (mode === 'none') { r.writeHead(404); return r.end('{}'); }
      if (mode === 'ratelimit') { r.writeHead(403); return r.end('{}'); }
      const ver = mode === 'same' ? '1.1.0' : '1.2.0';
      r.writeHead(200, { 'content-type': 'application/json' });
      return r.end(JSON.stringify({ tag_name: 'v' + ver, body: 'Нове', assets: [
        { name: `Mirrorly-Setup-${ver}.exe`, size: payload.length, browser_download_url: base + '/dl', digest: 'sha256:' + (mode === 'badsum' ? 'ab'.repeat(32) : sha) }] }));
    }
    if (req.url === '/dl') {
      r.writeHead(200, { 'content-length': payload.length });
      let i = 0; const t = setInterval(() => { r.write(payload.subarray(i, i + 256 * 1024)); i += 256 * 1024; if (i >= payload.length) { clearInterval(t); r.end(); } }, 60);
      return;
    }
    r.writeHead(404); r.end();
  });
  srv.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${srv.address().port}/latest`));
});
