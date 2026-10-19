// Runs inside the Fargate sandbox (isolated subnet, no task role) and reports what it can and cannot do.
const http = require('http'), net = require('net'), tls = require('tls'), dns = require('dns'), crypto = require('crypto');
const API = process.env.API, [PH, PP] = process.env.PROXY.split(':');
const out = (name, ok, detail) => process.stdout.write('RESULT ' + JSON.stringify({ name, ok, detail }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resolves = (h) => dns.promises.resolve4(h).then((a) => 'resolved ' + a[0], (e) => 'failed ' + e.code);
const connect = (host, to = 8000) => new Promise((res) => {
  const q = http.request({ host: PH, port: Number(PP), method: 'CONNECT', path: host + ':443', timeout: to });
  q.on('connect', (r, sock) => {
    if (r.statusCode !== 200) { sock.destroy(); return res({ status: r.statusCode }); }
    const t = tls.connect({ socket: sock, servername: host }, () => { res({ status: 200, tls: t.authorized ? 'verified' : 'unverified' }); t.destroy(); });
    t.on('error', (e) => res({ status: 200, tls: 'error ' + e.code }));
  });
  q.on('timeout', () => { res({ status: 'timeout' }); q.destroy(); });
  q.on('error', (e) => res({ status: 'error ' + e.code }));
  q.end();
});
const direct = (host, port) => new Promise((res) => {
  const c = net.connect({ host, port, timeout: 5000 }, () => { res('connected'); c.destroy(); });
  c.on('timeout', () => { res('blocked (timeout)'); c.destroy(); });
  c.on('error', (e) => res('blocked (' + e.code + ')'));
});
(async () => {
  const t0 = Date.now();
  out('no-aws-credentials', !process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && !process.env.AWS_ACCESS_KEY_ID, 'role uri: ' + (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || 'none'));
  out('private-name-resolves', (await resolves('api.sdlcs6.local')).startsWith('resolved'), await resolves('api.sdlcs6.local'));
  try { const r = await fetch(API + '/ping', { signal: AbortSignal.timeout(5000) }); out('reach-platform-by-private-name', r.status === 200, 'HTTP ' + r.status); }
  catch (e) { out('reach-platform-by-private-name', false, e.message + ' ' + (e.cause && e.cause.code)); }
  const gh = await resolves('github.com'), ex = await resolves('example.com');
  out('vpc-dns-blocks-github', gh.startsWith('failed'), gh);
  out('vpc-dns-blocks-example', ex.startsWith('failed'), ex);
  const a = await connect('github.com');
  out('proxy-allows-github-though-vpc-dns-blocks-it', a.status === 200 && a.tls === 'verified', JSON.stringify(a));
  const d = await connect('example.com');
  out('proxy-denies-unlisted-host', d.status === 403, JSON.stringify(d));
  const before = await connect('registry.npmjs.org');
  await fetch(API + '/admin/allow?host=registry.npmjs.org');
  let secs = null;
  for (let i = 0; i < 20 && secs === null; i++) { await sleep(1000); const x = await connect('registry.npmjs.org'); if (x.status === 200) secs = i + 1; }
  out('allowlist-change-applies-without-redeploy', before.status === 403 && secs !== null, 'before ' + before.status + ', allowed after ' + secs + ' s');
  out('direct-internet-blocked', (await direct('1.1.1.1', 443)).startsWith('blocked'), await direct('1.1.1.1', 443));
  out('direct-public-dns-blocked', (await direct('1.1.1.1', 53)).startsWith('blocked'), await direct('1.1.1.1', 53));
  // S3 snapshot through presigned URLs, and a bucket that must be refused.
  try {
    const data = crypto.randomBytes(50 * 1024 * 1024), hash = crypto.createHash('sha256').update(data).digest('hex');
    let t = Date.now();
    const put = await fetch(process.env.STATE_PUT_URL, { method: 'PUT', body: data, signal: AbortSignal.timeout(120000) });
    const putS = (Date.now() - t) / 1000;
    t = Date.now();
    const got = Buffer.from(await (await fetch(process.env.STATE_GET_URL, { signal: AbortSignal.timeout(120000) })).arrayBuffer());
    const getS = (Date.now() - t) / 1000;
    out('state-snapshot-roundtrip-50MB', put.status === 200 && crypto.createHash('sha256').update(got).digest('hex') === hash, 'PUT ' + put.status + ' in ' + putS + ' s, GET in ' + getS + ' s');
  } catch (e) { out('state-snapshot-roundtrip-50MB', false, e.message + ' ' + (e.cause && e.cause.code)); }
  try { const r = await fetch(process.env.OTHER_GET_URL, { signal: AbortSignal.timeout(15000) }); out('other-bucket-refused', r.status === 403, 'HTTP ' + r.status); }
  catch (e) { out('other-bucket-refused', true, 'unreachable: ' + (e.cause && e.cause.code || e.message)); }
  // A preview: the runner listens, the platform stand-in connects to it.
  const srv = http.createServer((q, r) => r.end('preview-ok')).listen(4000);
  await fetch(API + '/register?port=4000');
  let pr = '';
  for (let i = 0; i < 15 && !pr.startsWith('reached'); i++) { await sleep(1000); pr = (await (await fetch(API + '/preview-result')).json()).preview; }
  out('platform-can-reach-a-port-the-runner-opens', pr.startsWith('reached'), pr);
  srv.close();
  out('done', true, 'probe took ' + Math.round((Date.now() - t0) / 1000) + ' s');
})();
