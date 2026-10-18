import { useEffect, useState } from 'react';
import type { Health, Me, Ready } from '@sdlc/schemas';
import { Assumptions } from './Assumptions';
import { Autopilot } from './Autopilot';
import { Bugs } from './Bugs';
import { BudgetBanner, Costs } from './Costs';
import { Integrations } from './Integrations';
import { MapPage } from './MapPage';
import { Interruptions } from './Interruptions';
import { Queue } from './Queue';
import { getHealth, getMe, getReady, signOut } from './api';
import { ROLE_LABEL } from './labels';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; me: Me | null; health: Health; ready: Ready };

type Route =
  | { page: 'home' }
  | { page: 'queue'; openId: string | null }
  | { page: 'assumptions' }
  | { page: 'interruptions' }
  | { page: 'autopilot' }
  | { page: 'integrations' }
  | { page: 'bugs' }
  | { page: 'costs' }
  | { page: 'map'; initiativeId: string | null };

function parseRoute(hash: string): Route {
  const [, page, id] = hash.replace(/^#/, '').split('/');
  if (page === 'queue') return { page: 'queue', openId: id ?? null };
  if (page === 'assumptions') return { page: 'assumptions' };
  if (page === 'interruptions') return { page: 'interruptions' };
  if (page === 'autopilot') return { page: 'autopilot' };
  if (page === 'integrations') return { page: 'integrations' };
  if (page === 'bugs') return { page: 'bugs' };
  if (page === 'costs') return { page: 'costs' };
  if (page === 'map') return { page: 'map', initiativeId: id ?? null };
  return { page: 'home' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const NAV: Array<{ page: Route['page']; href: string; label: string }> = [
  { page: 'home', href: '#/', label: 'Home' },
  { page: 'map', href: '#/map', label: 'Map' },
  { page: 'queue', href: '#/queue', label: 'Attention queue' },
  { page: 'assumptions', href: '#/assumptions', label: 'Assumptions and decisions' },
  { page: 'autopilot', href: '#/autopilot', label: 'Autopilot' },
  { page: 'interruptions', href: '#/interruptions', label: 'Interruptions' },
  { page: 'bugs', href: '#/bugs', label: 'Bugs' },
  { page: 'costs', href: '#/costs', label: 'Costs' },
  { page: 'integrations', href: '#/integrations', label: 'Integrations' },
];

export function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const route = useRoute();

  const load = async () => {
    try {
      const [health, ready, me] = await Promise.all([getHealth(), getReady(), getMe()]);
      setState({ phase: 'ready', me, health, ready });
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const signedIn = state.phase === 'ready' && state.me !== null;
  const wide = signedIn && route.page !== 'home';

  return (
    <main className={wide ? 'wide' : undefined}>
      {signedIn && (
        <nav aria-label="Main">
          {NAV.map((n) => (
            <a
              key={n.page}
              href={n.href}
              aria-current={route.page === n.page ? 'page' : undefined}
              data-testid={`nav-${n.page}`}
            >
              {n.label}
            </a>
          ))}
        </nav>
      )}
      {signedIn && state.phase === 'ready' && state.me?.roles.includes('platform_admin') && (
        <BudgetBanner />
      )}
      {(!signedIn || route.page === 'home') && <h1>Autonomous SDLC</h1>}
      {state.phase === 'loading' && <p>Loading…</p>}
      {state.phase === 'error' && (
        <p role="alert" data-testid="error">
          Could not reach the platform: {state.message}
        </p>
      )}
      {state.phase === 'ready' && state.me && route.page === 'queue' && (
        <Queue openId={route.openId} />
      )}
      {state.phase === 'ready' && state.me && route.page === 'assumptions' && <Assumptions />}
      {state.phase === 'ready' && state.me && route.page === 'interruptions' && <Interruptions />}
      {state.phase === 'ready' && state.me && route.page === 'autopilot' && <Autopilot />}
      {state.phase === 'ready' && state.me && route.page === 'integrations' && <Integrations />}
      {state.phase === 'ready' && state.me && route.page === 'bugs' && <Bugs me={state.me} />}
      {state.phase === 'ready' && state.me && route.page === 'costs' && <Costs />}
      {state.phase === 'ready' && state.me && route.page === 'map' && (
        <MapPage initiativeId={route.initiativeId} me={state.me} />
      )}
      {state.phase === 'ready' && (!state.me || route.page === 'home') && (
        <>
          <section aria-label="Status">
            <p data-testid="api-status">
              API: <strong>{state.health.status}</strong> · database:{' '}
              <strong>{state.ready.checks.database}</strong> · v{state.health.version}
            </p>
          </section>
          {state.me ? (
            <section aria-label="Signed in">
              <p data-testid="signed-in">
                Signed in as <strong>{state.me.displayName}</strong> ({state.me.email})
              </p>
              <p data-testid="roles">
                Hats:{' '}
                {state.me.roles.length
                  ? state.me.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')
                  : 'none yet'}
              </p>
              {state.me.roles.includes('platform_admin') && (
                <p>
                  <a href="/admin/github" data-testid="github-setup">
                    GitHub setup
                  </a>
                </p>
              )}
              <button
                onClick={async () => {
                  await signOut();
                  await load();
                }}
              >
                Sign out
              </button>
            </section>
          ) : (
            <section aria-label="Signed out">
              <p>You are not signed in.</p>
              <a className="button" href="/auth/login" data-testid="sign-in">
                Sign in
              </a>
            </section>
          )}
        </>
      )}
      {state.phase === 'ready' && !state.me && route.page !== 'home' && (
        <p className="muted">Sign in to see this page.</p>
      )}
    </main>
  );
}
