import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import type { ReadyPreviewDto } from '@sdlc/schemas';
import { bannerHidden, clearReadyPreview, hideBanner } from './usePreviewReady';

/** What the preview is, in words: "The built app of Fernleaf" or "Pull request #12 of Fernleaf". */
export const previewName = (p: ReadyPreviewDto) => `${p.label} of ${p.initiativeTitle}`;

/** A banner on every screen when a preview the person started is ready. Closing it leaves the notice in the queue. */
export function PreviewReadyBanner({ items }: { items: ReadyPreviewDto[] }) {
  const shown = items.filter((p) => !bannerHidden(p.id));
  if (shown.length === 0) return null;
  return (
    <Stack
      spacing={1}
      data-testid="preview-ready-banner"
      sx={{
        position: 'fixed',
        top: 76,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(560px, calc(100vw - 32px))',
        zIndex: (t) => t.zIndex.drawer + 2,
      }}
    >
      {shown.map((p) => (
        <Alert
          key={p.id}
          severity="success"
          variant="filled"
          data-testid="preview-ready-alert"
          action={
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Button
                color="inherit"
                size="small"
                href={p.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => {
                  void clearReadyPreview(p.id);
                }}
              >
                Open
              </Button>
              <Button color="inherit" size="small" href="#/queue" onClick={() => hideBanner(p.id)}>
                Queue
              </Button>
              <IconButton
                color="inherit"
                size="small"
                aria-label="Close"
                onClick={() => hideBanner(p.id)}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          }
          sx={{ boxShadow: 6, alignItems: 'center' }}
        >
          <b>Preview is ready.</b> {previewName(p)}
        </Alert>
      ))}
    </Stack>
  );
}
