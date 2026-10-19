// The egress proxy as the real one would be: the allowlist comes from the platform and changes at run time, names are
// resolved with a public resolver (not the VPC one, which is firewalled), and every decision is written to stdout.
const http = require('http'), net = require('net'), dns = require('dns');
const resolver = new dns.promises.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);
let allow = [];
const log = (l) => process.stdout.write(l + '\n');
async function refresh() {
  try {
    const r = await fetch(process.env.ALLOW_URL, { signal: AbortSignal.timeout(3000) });
    const next = (await r.json()).hosts;
    if (JSON.stringify(next) !== JSON.stringify(allow)) { allow = next; log('ALLOWLIST ' + allow.join(',')); }
  } catch (e) { log('allowlist refresh failed: ' + e.message); }
}
setInterval(refresh, 3000); refresh();
const ok = (h) => allow.some((a) => h === a || h.endsWith('.' + a));
const s = http.createServer((q, r) => { log('DENY plain-http ' + q.url); r.writeHead(403); r.end('plain http denied'); });
s.on('connect', async (q, c, head) => {
  const [h, p] = q.url.split(':');
  if (!ok(h) || p !== '443') { log('DENY ' + q.url); c.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  try {
    const [ip] = await resolver.resolve4(h);
    const u = net.connect(443, ip, () => {
      log('ALLOW ' + q.url + ' -> ' + ip);
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      u.write(head); u.pipe(c); c.pipe(u);
    });
    u.on('error', () => c.destroy()); c.on('error', () => u.destroy());
  } catch (e) { log('DNSFAIL ' + q.url + ' ' + e.code); c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
});
s.listen(3128, () => log('proxy up'));
