import { useCallback, useEffect, useState } from 'react';
import type { Me, ModelSettingsDto, ModelTestDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ApiProblem, getModelSettings, setAliasModel, testModel } from './api';
import { PageHeader } from './ui';

type Alias = ModelSettingsDto['aliases'][number];
type Model = ModelSettingsDto['models'][number];

const usd = (n: number) => `$${n}`;
const priceLine = (m: Model) =>
  `${usd(m.price.input)} in, ${usd(m.price.output)} out per million tokens`;

/** What choosing `next` instead of `now` does to the bill: output tokens dominate agent cost, so say that. */
function costNote(now: Model, next: Model): string {
  if (now.id === next.id) return 'This is the model in use now.';
  const r = next.price.output / now.price.output;
  const how =
    r === 1
      ? 'the same'
      : r > 1
        ? `${+r.toFixed(2)} times as much`
        : `${+(1 / r).toFixed(2)} times less`;
  return `Output costs ${how} as ${now.label}. A run's budget does not change, so a dearer model reaches it sooner.`;
}

function AliasCard({
  alias,
  models,
  admin,
  onSaved,
}: {
  alias: Alias;
  models: Model[];
  admin: boolean;
  onSaved: (v: ModelSettingsDto, note: string) => void;
}) {
  const [choice, setChoice] = useState(alias.model);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<(ModelTestDto & { model: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const byId = new Map(models.map((m) => [m.id, m]));
  const current = byId.get(alias.model)!;
  const next = byId.get(choice) ?? current;
  const tested = result?.model === choice ? result : null;

  const save = async (model: string) => {
    setSaving(true);
    setError(null);
    try {
      const v = await setAliasModel(alias.alias, model);
      setChoice(model);
      onSaved(v, `${alias.alias} now uses ${byId.get(model)?.label ?? model}.`);
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card sx={{ mb: 2 }} data-testid="alias-card" aria-label={alias.alias}>
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}
        >
          <Typography component="h2" variant="h3">
            <Box component="code">{alias.alias}</Box>
          </Typography>
          {alias.model !== alias.defaultModel && (
            <Chip size="small" color="warning" label="changed from the default" />
          )}
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          {alias.purpose}
        </Typography>
        <Typography component="div" variant="body2" sx={{ mt: 1 }}>
          Used by:{' '}
          {alias.usedBy.length
            ? alias.usedBy.map((a) => (
                <Chip key={a} size="small" variant="outlined" label={a} sx={{ mr: 0.5 }} />
              ))
            : 'no agent directly'}
        </Typography>
        <Typography variant="body2" sx={{ mt: 1 }} data-testid="current-model">
          In use now: <b>{current.label}</b> ({priceLine(current)})
          {alias.changedAt && alias.changedBy
            ? `. Changed by ${alias.changedBy} on ${alias.changedAt.slice(0, 10)}.`
            : '.'}
        </Typography>

        {admin ? (
          <>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              sx={{ mt: 2, alignItems: { md: 'center' } }}
            >
              <TextField
                select
                label="Model"
                value={choice}
                onChange={(e) => {
                  setChoice(e.target.value);
                  setError(null);
                }}
                slotProps={{
                  select: { native: true },
                  htmlInput: { 'aria-label': `Model for ${alias.alias}` },
                }}
                sx={{ minWidth: 300 }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.id === alias.defaultModel ? ' (default)' : ''}
                  </option>
                ))}
              </TextField>
              <Button
                variant="outlined"
                disabled={testing}
                sx={{ whiteSpace: 'nowrap' }}
                onClick={async () => {
                  setTesting(true);
                  setError(null);
                  try {
                    setResult({ ...(await testModel(choice)), model: choice });
                  } catch (e) {
                    setError(e instanceof ApiProblem ? e.message : String(e));
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? 'Testing…' : 'Test model'}
              </Button>
              <Button
                variant="contained"
                disabled={saving || choice === alias.model}
                sx={{ whiteSpace: 'nowrap' }}
                onClick={() => void save(choice)}
              >
                Save
              </Button>
              {alias.model !== alias.defaultModel && (
                <Button
                  disabled={saving}
                  sx={{ whiteSpace: 'nowrap' }}
                  onClick={() => void save(alias.defaultModel)}
                >
                  Reset to default
                </Button>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {next.note} {priceLine(next)}. {costNote(current, next)}
            </Typography>
            {tested && (
              <Alert
                severity={tested.ok ? 'success' : 'warning'}
                sx={{ mt: 1.5 }}
                data-testid="test-result"
              >
                {tested.ok
                  ? `${byId.get(choice)?.label} answered “${tested.answer}” in ${((tested.ms ?? 0) / 1000).toFixed(1)} s. The test cost about $${((tested.costMicros ?? 0) / 1_000_000).toFixed(5)}.`
                  : `The test failed${tested.status ? ` (${tested.status})` : ''}: ${tested.error ?? 'no answer'}. Do not save this model until it passes.`}
              </Alert>
            )}
            {error && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {error}
              </Alert>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function Settings({ me }: { me: Me }) {
  const [data, setData] = useState<ModelSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const admin = me.roles.includes('platform_admin');

  const load = useCallback(async () => {
    try {
      setData(await getModelSettings());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Which model each agent thinks with. Agents ask for an alias, and the choice here decides which model answers."
      />
      <Alert severity="info" sx={{ mb: 2 }}>
        Only Claude models are offered. The agents run on Claude Code, which needs a model that
        speaks the Anthropic protocol with tool use, and the gateway sends every call to Anthropic
        with no fallback. A change reaches the next model call, including runs already in progress.
      </Alert>
      {!admin && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Only a Platform Admin changes these. You can see what is in use.
        </Alert>
      )}
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {note && (
        <Alert severity="success" sx={{ mb: 2 }} data-testid="note">
          {note}
        </Alert>
      )}
      {data?.aliases.map((a) => (
        <AliasCard
          key={`${a.alias}-${a.model}`}
          alias={a}
          models={data.models}
          admin={admin}
          onSaved={(v, n) => {
            setData(v);
            setNote(n);
          }}
        />
      ))}
    </>
  );
}
