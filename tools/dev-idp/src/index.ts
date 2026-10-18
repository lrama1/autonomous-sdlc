import http from 'node:http';
import Provider from 'oidc-provider';

export interface Persona {
  sub: string;
  name: string;
  email: string;
  blurb: string;
}

// Static people for local development. Roles ("hats") live in the platform database, not here.
export const PERSONAS: Persona[] = [
  { sub: 'dev-alice', name: 'Alice Park', email: 'alice@example.test', blurb: 'Product Owner' },
  { sub: 'dev-bob', name: 'Bob Lindqvist', email: 'bob@example.test', blurb: 'Backend Engineer' },
  { sub: 'dev-cara', name: 'Cara Okafor', email: 'cara@example.test', blurb: 'Architect' },
  { sub: 'dev-admin', name: 'Dev Admin', email: 'admin@example.test', blurb: 'Platform Admin' },
];

export interface DevIdpOptions {
  port: number;
  /** Loopback by default. A container needs all interfaces so its published port works. */
  host?: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

async function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function loginPage(uid: string): string {
  const buttons = PERSONAS.map(
    (p) =>
      `<button name="sub" value="${esc(p.sub)}"><strong>${esc(p.name)}</strong><span>${esc(p.blurb)}</span></button>`,
  ).join('');
  return `<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>
<style>body{font:16px system-ui;max-width:420px;margin:12vh auto;padding:0 16px}
h1{font-size:20px}p{color:#555}form{display:grid;gap:8px}
button{display:flex;justify-content:space-between;padding:12px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer;font:inherit}
button:hover{background:#f3f6ff}span{color:#666}</style>
<h1>Development sign-in</h1><p>Local identity provider. Pick a person.</p>
<form method="post" action="/interaction/${esc(uid)}/login">${buttons}</form>`;
}

export async function startDevIdp(opts: DevIdpOptions): Promise<{ stop: () => Promise<void> }> {
  const provider = new Provider(opts.issuer, {
    clients: [
      {
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uris: opts.redirectUris,
        post_logout_redirect_uris: opts.postLogoutRedirectUris ?? [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    pkce: { required: () => true },
    scopes: ['openid', 'profile', 'email'],
    claims: { openid: ['sub'], profile: ['name'], email: ['email', 'email_verified'] },
    cookies: { keys: ['dev-only-cookie-key-not-a-secret'] },
    ttl: {
      Interaction: 600,
      Session: 3600,
      Grant: 3600,
      AccessToken: 600,
      IdToken: 600,
      AuthorizationCode: 60,
    },
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, sub) => {
      const p = PERSONAS.find((x) => x.sub === sub);
      if (!p) return undefined;
      return {
        accountId: p.sub,
        claims: async () => ({ sub: p.sub, name: p.name, email: p.email, email_verified: true }),
      };
    },
  });

  const oidc = provider.callback();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', opts.issuer);
      const m = /^\/interaction\/([^/]+)(?:\/(login))?$/.exec(url.pathname);
      if (!m) return oidc(req, res);
      const uid = m[1]!;

      if (req.method === 'GET' && !m[2]) {
        const details = await provider.interactionDetails(req, res);
        if (details.prompt.name === 'login') {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          return void res.end(loginPage(uid));
        }
        // Consent is granted automatically for the platform's own client.
        const { prompt, params, session } = details;
        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({
              accountId: session!.accountId,
              clientId: params.client_id as string,
            });
        const missingScope = prompt.details.missingOIDCScope as string[] | undefined;
        if (missingScope) grant!.addOIDCScope(missingScope.join(' '));
        const missingClaims = prompt.details.missingOIDCClaims as string[] | undefined;
        if (missingClaims) grant!.addOIDCClaims(missingClaims);
        const grantId = await grant!.save();
        return void (await provider.interactionFinished(
          req,
          res,
          { consent: { grantId } },
          { mergeWithLastSubmission: true },
        ));
      }

      if (req.method === 'POST' && m[2] === 'login') {
        const form = await readBody(req);
        const sub = form.get('sub') ?? '';
        if (!PERSONAS.some((p) => p.sub === sub)) {
          res.statusCode = 400;
          return void res.end('unknown persona');
        }
        return void (await provider.interactionFinished(
          req,
          res,
          { login: { accountId: sub } },
          { mergeWithLastSubmission: false },
        ));
      }

      res.statusCode = 404;
      res.end();
    } catch (e) {
      console.error('[dev-idp]', e);
      if (!res.headersSent) res.statusCode = 500;
      res.end('dev idp error');
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve));
  return { stop: () => new Promise((resolve) => server.close(() => resolve())) };
}
