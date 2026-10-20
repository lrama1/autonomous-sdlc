import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
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
