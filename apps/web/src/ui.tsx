import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/** The top of a page: its title (the page's one h1), something beside it such as a count, and a line about the page. */
export function PageHeader({
  title,
  chip,
  subtitle,
  actions,
}: {
  title: string;
  chip?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ mb: 2, justifyContent: 'space-between', alignItems: { sm: 'flex-start' } }}
    >
      <Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography component="h1" variant="h1">
            {title}
          </Typography>
          {chip}
        </Stack>
        {subtitle && (
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions}
    </Stack>
  );
}

export type Tone = 'none' | 'info' | 'wait' | 'stop' | 'done';

const TONE_COLOR = {
  none: 'default',
  info: 'info',
  wait: 'warning',
  stop: 'error',
  done: 'success',
} as const;

/** A small coloured label for where something stands. The word carries the meaning; colour only helps. */
export function StatusChip({
  label,
  tone,
  testId,
}: {
  label: ReactNode;
  tone: Tone;
  testId?: string;
}) {
  return (
    <Chip
      label={label}
      color={TONE_COLOR[tone]}
      variant={tone === 'none' ? 'outlined' : 'filled'}
      data-testid={testId}
    />
  );
}
