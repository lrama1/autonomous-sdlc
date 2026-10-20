import { createTheme } from '@mui/material/styles';

/**
 * One theme for the whole app. Colours follow the computer's light or dark setting (no flash, no toggle), and the
 * accent is the one the app has always used.
 */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'media' },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#2f5fd0' },
        background: { default: '#f6f8fb', paper: '#ffffff' },
        text: { primary: '#1c2430', secondary: '#667085' },
        divider: '#dde3ec',
      },
    },
    dark: {
      palette: {
        primary: { main: '#8fb0ff' },
        background: { default: '#10141b', paper: '#171c25' },
        text: { primary: '#e6eaf1', secondary: '#9aa4b5' },
        divider: '#2a3342',
      },
    },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 14,
    h1: { fontSize: '1.6rem', fontWeight: 700 },
    h2: { fontSize: '1.15rem', fontWeight: 600 },
    h3: { fontSize: '1.02rem', fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiPaper: { defaultProps: { variant: 'outlined' } },
    MuiCard: { defaultProps: { variant: 'outlined' } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiAppBar: { defaultProps: { elevation: 0, color: 'default' } },
  },
});
