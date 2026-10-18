import * as oidc from 'openid-client';
import { person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import type { FastifyInstance } from 'fastify';
import { recordActivity } from './activity.js';
import type { ApiConfig } from './config.js';
import { endSession, startSession } from './session.js';

const FLOW_COOKIE = 'sdlc_oidc';

export function registerAuthRoutes(app: FastifyInstance, config: ApiConfig, db: Db): void {
  let discovered: Promise<oidc.Configuration> | undefined;
  const getOidc = () => {
    // Plain-http issuers are accepted only in local mode (the dev identity provider).
    discovered ??= oidc.discovery(
      new URL(config.OIDC_ISSUER),
      config.OIDC_CLIENT_ID,
      config.OIDC_CLIENT_SECRET,
      undefined,
      config.SDLC_ENV === 'local' ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    return discovered;
  };
  const redirectUri = `${config.PUBLIC_URL}/auth/callback`;
  const secure = config.PUBLIC_URL.startsWith('https://');

  app.get('/auth/login', async (_request, reply) => {
    const cfg = await getOidc();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    reply.setCookie(FLOW_COOKIE, JSON.stringify({ verifier, state }), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/auth',
      maxAge: 600,
    });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
    });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', async (request, reply) => {
    const raw = request.cookies[FLOW_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) {
      return reply
        .code(400)
        .send({ error: { code: 'login_expired', message: 'Sign-in session expired. Try again.' } });
    }
    const flow = JSON.parse(unsigned.value) as { verifier: string; state: string };
    reply.clearCookie(FLOW_COOKIE, { path: '/auth' });

    const cfg = await getOidc();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(cfg, new URL(request.url, config.PUBLIC_URL), {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
      });
    } catch (e) {
      request.log.warn({ err: e }, 'oidc callback failed');
      return reply.code(400).send({ error: { code: 'login_failed', message: 'Sign-in failed.' } });
    }
    const sub = tokens.claims()?.sub;
    if (!sub)
      return reply
        .code(400)
        .send({ error: { code: 'login_failed', message: 'No subject in token.' } });
    const info = await oidc.fetchUserInfo(cfg, tokens.access_token, sub);
    if (!info.email) {
      return reply.code(400).send({
        error: { code: 'login_failed', message: 'The identity provider returned no email.' },
      });
    }

    const [row] = await db
      .insert(person)
      .values({ oidcSubject: sub, displayName: info.name ?? info.email, email: info.email })
      .onConflictDoUpdate({
        target: person.oidcSubject,
        set: { displayName: info.name ?? info.email, email: info.email },
      })
      .returning();
    if (!row) throw new Error('person upsert returned no row');

    await recordActivity(db, {
      actorType: 'person',
      actorId: row.id,
      action: 'auth.login',
      detail: { subject: sub },
    });
    startSession(reply, row.id, secure);
    return reply.redirect(config.PUBLIC_URL);
  });

  app.post('/auth/logout', async (_request, reply) => {
    endSession(reply);
    return { ok: true };
  });
}
