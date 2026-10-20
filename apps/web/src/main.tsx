import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { App } from './App';
import { theme } from './theme';

// A diagram that resizes with its box makes the browser report this harmless loop; the dev overlay should not show it.
window.addEventListener('error', (e) => {
  if (e.message.includes('ResizeObserver loop')) e.stopImmediatePropagation();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme} defaultMode="system">
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
