import { CookieJar } from './signin.js';

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#x3D;/g, '=')
    .replace(/&quot;/g, '"');

/**
 * Signs in to a deployed platform through the Cognito hosted page: the same steps a browser takes, over HTTP. The
 * page's form carries a CSRF token that has to be sent back with the cookie that came with the page.
 */
export async function signInCognito(
  publicUrl: string,
  username: string,
  password: string,
): Promise<CookieJar> {
  const jar = new CookieJar();
  const page = await jar.fetch(`${publicUrl}/auth/login`);
  const tag = /<form[^>]*name="cognitoSignInForm"[^>]*>/.exec(page.text)?.[0];
  if (page.status !== 200 || !tag)
    throw new Error(`expected the Cognito sign-in page, got ${page.status} at ${page.url}`);
  const inner = page.text.slice(page.text.indexOf(tag) + tag.length);
  const body = new URLSearchParams();
  for (const m of inner.slice(0, inner.indexOf('</form>')).matchAll(/<input[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name && !body.has(name)) body.set(name, decode(value));
  }
  body.set('username', username);
  body.set('password', password);
  const action = /action="([^"]+)"/.exec(tag)?.[1];
  const target = action ? new URL(decode(action), page.url).href : page.url;
  const done = await jar.fetch(target, {
    method: 'POST',
    body: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (done.status !== 200 || done.url.includes('amazoncognito.com'))
    throw new Error(`sign-in did not complete: ${done.status} at ${done.url.slice(0, 100)}`);
  return jar;
}
