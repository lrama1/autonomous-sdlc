import { dnsResolver, parseForwards, startEgress } from './egress.js';
import { startAllowlist } from './allowlist.js';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// EGRESS_ALLOW is the list until the platform answers (EGRESS_ALLOW_URL, with EGRESS_ALLOW_TOKEN). EGRESS_DNS names the
// resolvers to ask, for a network whose own resolver only answers an allowlist.
const allow = startAllowlist({
  initial: list(process.env.EGRESS_ALLOW),
  url: process.env.EGRESS_ALLOW_URL || undefined,
  token: process.env.EGRESS_ALLOW_TOKEN || undefined,
  intervalMs: Number(process.env.EGRESS_ALLOW_INTERVAL_MS ?? 5000),
  log: (l) => console.log(l),
});
const dnsServers = list(process.env.EGRESS_DNS);

const egress = await startEgress({
  allowHosts: () => allow.current(),
  forwards: parseForwards(process.env.EGRESS_FORWARDS ?? ''),
  proxyPort: Number(process.env.EGRESS_PROXY_PORT ?? 3128),
  resolve: dnsServers.length > 0 ? dnsResolver(dnsServers) : undefined,
});

const stop = () => {
  allow.stop();
  void egress.stop().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
