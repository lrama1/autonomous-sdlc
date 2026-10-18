// A tiny cookie jar plus the OIDC sign-in walk, for tests and the smoke check. No browser needed.

export interface FetchResult {
  status: number;
  url: string;
  text: string;
}

export class CookieJar {
  private cookies = new Map<string, string>();

  private store(url: URL, res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const key = `${url.host}|${name}`;
      const gone =
        attrs.some((a) => /^\s*max-age=0/i.test(a)) || /expires=Thu, 01 Jan 1970/i.test(sc);
      if (gone) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }

  private header(url: URL): string {
    const out: string[] = [];
    for (const [key, value] of this.cookies) {
      const [host, name] = key.split('|');
      if (host === url.host) out.push(`${name}=${value}`);
    }
    return out.join('; ');
  }

  /** Follows redirects by hand so cookies set on each hop are kept. */
  async fetch(
    input: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<FetchResult> {
    let url = new URL(input);
    let method = init.method ?? 'GET';
    let body = init.body;
    for (let hop = 0; hop < 20; hop++) {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        headers: { ...init.headers, cookie: this.header(url) },
      });
      this.store(url, res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        method = 'GET';
        body = undefined;
        continue;
      }
      return { status: res.status, url: url.href, text: await res.text() };
    }
    throw new Error('too many redirects');
  }
}

/** Signs in through the real OIDC code + PKCE flow as one of the dev personas. */
export async function signInAs(publicUrl: string, sub: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const loginPage = await jar.fetch(`${publicUrl}/auth/login`);
  if (loginPage.status !== 200 || !loginPage.url.includes('/interaction/')) {
    throw new Error(
      `expected the identity provider login page, got ${loginPage.status} at ${loginPage.url}`,
    );
  }
  const done = await jar.fetch(`${loginPage.url}/login`, {
    method: 'POST',
    body: new URLSearchParams({ sub }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (done.status !== 200)
    throw new Error(`sign-in did not complete: ${done.status} at ${done.url}`);
  return jar;
}
