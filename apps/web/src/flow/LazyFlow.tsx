import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import Box from '@mui/material/Box';
import type { FlowCanvas as Canvas } from './FlowCanvas';

const Inner = lazy(() => import('./FlowCanvas').then((m) => ({ default: m.FlowCanvas })));

/** The diagram, loaded when a page first draws one, so the diagram library is not part of every page. */
export function FlowCanvas(props: ComponentProps<typeof Canvas>) {
  return (
    <Suspense
      fallback={
        <Box
          sx={{ height: props.height ?? 340, border: 1, borderColor: 'divider', borderRadius: 2 }}
        />
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
