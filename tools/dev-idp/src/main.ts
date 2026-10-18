import { startDevIdp } from './index.js';

const port = Number(process.env.DEV_IDP_PORT ?? 9000);
await startDevIdp({
  port,
  host: process.env.DEV_IDP_HOST,
  issuer: process.env.OIDC_ISSUER ?? `http://localhost:${port}`,
  clientId: process.env.OIDC_CLIENT_ID ?? 'sdlc-web',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'dev-client-secret',
  redirectUris: [process.env.OIDC_REDIRECT_URI ?? 'http://localhost:8080/auth/callback'],
});
console.log(`dev idp listening on http://localhost:${port}`);
