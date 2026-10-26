import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Health, Me, Ready } from '@sdlc/schemas';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AutoModeOutlinedIcon from '@mui/icons-material/AutoModeOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Assumptions } from './Assumptions';
import { Autopilot } from './Autopilot';
import { Bugs } from './Bugs';
import { BudgetBanner, Costs } from './Costs';
import { Portfolio } from './Portfolio';
import { Integrations } from './Integrations';
import { MapPage } from './MapPage';
import { Landing, SignInCard } from './Landing';
import { Interruptions } from './Interruptions';
import { Queue } from './Queue';
import { Repositories } from './Repositories';
import { getHealth, getMe, getReady, signOut } from './api';
import { AgentFlow } from './flow/AgentFlow';
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
  | { page: 'repositories' }
  | { page: 'bugs' }
  | { page: 'costs' }
  | { page: 'portfolio' }
  | { page: 'map'; initiativeId: string | null };

function parseRoute(hash: string): Route {
  const [, page, id] = hash.replace(/^#/, '').split('/');
  if (page === 'queue') return { page: 'queue', openId: id ?? null };
  if (page === 'assumptions') return { page: 'assumptions' };
  if (page === 'interruptions') return { page: 'interruptions' };
  if (page === 'autopilot') return { page: 'autopilot' };
  if (page === 'integrations') return { page: 'integrations' };
  if (page === 'repositories') return { page: 'repositories' };
  if (page === 'bugs') return { page: 'bugs' };
  if (page === 'costs') return { page: 'costs' };
  if (page === 'portfolio') return { page: 'portfolio' };
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

const NAV: Array<{ page: Route['page']; href: string; label: string; icon: ReactElement }> = [
  { page: 'home', href: '#/', label: 'Home', icon: <HomeOutlinedIcon /> },
  { page: 'portfolio', href: '#/portfolio', label: 'Portfolio', icon: <DashboardOutlinedIcon /> },
  { page: 'map', href: '#/map', label: 'Map', icon: <AccountTreeOutlinedIcon /> },
  { page: 'queue', href: '#/queue', label: 'Attention queue', icon: <InboxOutlinedIcon /> },
  {
    page: 'assumptions',
    href: '#/assumptions',
    label: 'Assumptions and decisions',
    icon: <RuleOutlinedIcon />,
  },
  { page: 'autopilot', href: '#/autopilot', label: 'Autopilot', icon: <AutoModeOutlinedIcon /> },
  {
    page: 'interruptions',
    href: '#/interruptions',
    label: 'Interruptions',
    icon: <NotificationsActiveOutlinedIcon />,
  },
  { page: 'bugs', href: '#/bugs', label: 'Bugs', icon: <BugReportOutlinedIcon /> },
  { page: 'costs', href: '#/costs', label: 'Costs', icon: <PaymentsOutlinedIcon /> },
  {
    page: 'integrations',
    href: '#/integrations',
    label: 'Integrations',
    icon: <ExtensionOutlinedIcon />,
  },
  {
    page: 'repositories',
    href: '#/repositories',
    label: 'Repositories',
    icon: <FolderOpenOutlinedIcon />,
  },
];

const DRAWER_WIDTH = 252;

export function App() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up('md'));

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

  useEffect(() => setMenuOpen(false), [route]);

  const signedIn = state.phase === 'ready' && state.me !== null;
  const me = state.phase === 'ready' ? state.me : null;
  const atHome = !signedIn || route.page === 'home';

  const nav = (
    <List component="nav" aria-label="Main" sx={{ px: 1, py: 1.5 }}>
      {NAV.map((n) => (
        <ListItemButton
          key={n.page}
          component="a"
          href={n.href}
          selected={route.page === n.page}
          aria-current={route.page === n.page ? 'page' : undefined}
          data-testid={`nav-${n.page}`}
          sx={{ borderRadius: 2, mb: 0.25 }}
        >
          <ListItemIcon sx={{ minWidth: 38 }}>{n.icon}</ListItemIcon>
          <ListItemText primary={n.label} slotProps={{ primary: { variant: 'body2' } }} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        sx={{
          zIndex: (t) => t.zIndex.drawer + 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {signedIn && !desktop && (
            <IconButton edge="start" aria-label="Open the menu" onClick={() => setMenuOpen(true)}>
              <MenuIcon />
            </IconButton>
          )}
          <Typography component="div" variant="h3" sx={{ flexGrow: 1 }}>
            Autonomous SDLC
          </Typography>
          {me && (
            <>
              {desktop && (
                <Chip variant="outlined" label={me.displayName} data-testid="user-chip" />
              )}
              <Button
                variant="outlined"
                size="small"
                onClick={async () => {
                  await signOut();
                  await load();
                }}
              >
                Sign out
              </Button>
            </>
          )}
        </Toolbar>
      </AppBar>
      {signedIn && (
        <Drawer
          variant={desktop ? 'permanent' : 'temporary'}
          open={desktop || menuOpen}
          onClose={() => setMenuOpen(false)}
          sx={{
            width: desktop ? DRAWER_WIDTH : undefined,
            flexShrink: 0,
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
          }}
        >
          <Toolbar />
          {nav}
        </Drawer>
      )}
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 } }}>
        <Toolbar />
        <Container maxWidth={atHome ? (signedIn ? 'md' : 'lg') : 'xl'} disableGutters>
          {signedIn && state.phase === 'ready' && state.me?.roles.includes('platform_admin') && (
            <BudgetBanner />
          )}
          {atHome && (
            <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
              Autonomous SDLC
            </Typography>
          )}
          {state.phase === 'loading' && (
            <Box>
              <LinearProgress sx={{ mb: 1 }} />
              <Typography>Loading{'\u2026'}</Typography>
            </Box>
          )}
          {state.phase === 'error' && (
            <Alert severity="error" role="alert" data-testid="error">
              Could not reach the platform: {state.message}
            </Alert>
          )}
          {state.phase === 'ready' && state.me && route.page === 'queue' && (
            <Queue openId={route.openId} />
          )}
          {state.phase === 'ready' && state.me && route.page === 'assumptions' && <Assumptions />}
          {state.phase === 'ready' && state.me && route.page === 'interruptions' && (
            <Interruptions />
          )}
          {state.phase === 'ready' && state.me && route.page === 'autopilot' && <Autopilot />}
          {state.phase === 'ready' && state.me && route.page === 'integrations' && <Integrations />}
          {state.phase === 'ready' && state.me && route.page === 'repositories' && (
            <Repositories me={state.me} />
          )}
          {state.phase === 'ready' && state.me && route.page === 'bugs' && <Bugs me={state.me} />}
          {state.phase === 'ready' && state.me && route.page === 'costs' && <Costs />}
          {state.phase === 'ready' && state.me && route.page === 'portfolio' && <Portfolio />}
          {state.phase === 'ready' && state.me && route.page === 'map' && (
            <MapPage initiativeId={route.initiativeId} me={state.me} />
          )}
          {state.phase === 'ready' && !state.me && route.page === 'home' && (
            <Stack spacing={2}>
              <Card aria-label="Status">
                <CardContent>
                  <Typography data-testid="api-status">
                    API: <strong>{state.health.status}</strong> {'\u00b7'} database:{' '}
                    <strong>{state.ready.checks.database}</strong> {'\u00b7'} v
                    {state.health.version}
                  </Typography>
                </CardContent>
              </Card>
              <Landing signIn={<SignInCard />} />
            </Stack>
          )}
          {state.phase === 'ready' && state.me && route.page === 'home' && (
            <Stack spacing={2}>
              <Card aria-label="Status">
                <CardContent>
                  <Typography data-testid="api-status">
                    API: <strong>{state.health.status}</strong> {'\u00b7'} database:{' '}
                    <strong>{state.ready.checks.database}</strong> {'\u00b7'} v
                    {state.health.version}
                  </Typography>
                </CardContent>
              </Card>
              {state.me && (
                <>
                  <Card aria-label="Signed in">
                    <CardContent>
                      <Typography data-testid="signed-in" gutterBottom>
                        Signed in as <strong>{state.me.displayName}</strong> ({state.me.email})
                      </Typography>
                      <Typography data-testid="roles" color="text.secondary">
                        Hats:{' '}
                        {state.me.roles.length
                          ? state.me.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')
                          : 'none yet'}
                      </Typography>
                      {state.me.roles.includes('platform_admin') && (
                        <Button
                          component="a"
                          href="/admin/github"
                          data-testid="github-setup"
                          sx={{ mt: 1 }}
                        >
                          GitHub setup
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                  <Card aria-label="How work flows">
                    <CardContent>
                      <Typography component="h2" variant="h2" gutterBottom>
                        How work flows
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                        Agents do the work; people decide at the orange steps.
                      </Typography>
                      <AgentFlow />
                    </CardContent>
                  </Card>
                </>
              )}
            </Stack>
          )}
          {state.phase === 'ready' && !state.me && route.page !== 'home' && (
            <Typography color="text.secondary">Sign in to see this page.</Typography>
          )}
        </Container>
      </Box>
    </Box>
  );
}
