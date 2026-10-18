import { describe, expect, it } from 'vitest';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { AwsSecrets } from './aws-secrets.js';

type Cmd = { constructor: { name: string }; input: Record<string, string> };

// Stands in for Secrets Manager: PutSecretValue fails until the secret has been created.
function fakeAws() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  let racing = false;
  return {
    store,
    calls,
    raceOnCreate: () => (racing = true),
    client: {
      async send(command: unknown) {
        const c = command as Cmd;
        const name = c.input.SecretId ?? c.input.Name!;
        calls.push(`${c.constructor.name} ${name}`);
        if (command instanceof GetSecretValueCommand) {
          if (!store.has(name))
            throw new ResourceNotFoundException({ message: 'no', $metadata: {} });
          return { SecretString: store.get(name) };
        }
        if (command instanceof PutSecretValueCommand) {
          if (!store.has(name))
            throw new ResourceNotFoundException({ message: 'no', $metadata: {} });
          store.set(name, c.input.SecretString!);
          return {};
        }
        if (command instanceof CreateSecretCommand) {
          if (racing) {
            store.set(name, 'someone else');
            throw new ResourceExistsException({ message: 'exists', $metadata: {} });
          }
          store.set(name, c.input.SecretString!);
          return {};
        }
        throw new Error('unexpected command');
      },
    },
  };
}

describe('AwsSecrets', () => {
  it('keeps every secret under its prefix', async () => {
    const aws = fakeAws();
    const s = new AwsSecrets('sdlc/dev/', aws.client);
    await s.put('github/agent/private_key', 'PEM');
    expect([...aws.store.keys()]).toEqual(['sdlc/dev/github/agent/private_key']);
    expect(await s.get('github/agent/private_key')).toBe('PEM');
  });

  it('creates a secret the first time and updates it afterwards', async () => {
    const aws = fakeAws();
    const s = new AwsSecrets('p/', aws.client);
    await s.put('a', '1');
    await s.put('a', '2');
    expect(await s.get('a')).toBe('2');
    expect(aws.calls.filter((c) => c.startsWith('CreateSecretCommand'))).toHaveLength(1);
  });

  it('reports a missing secret as undefined, not an error', async () => {
    const s = new AwsSecrets('p/', fakeAws().client);
    expect(await s.get('missing')).toBeUndefined();
    expect(await s.has('missing')).toBe(false);
  });

  it('survives another process creating the same secret at the same moment', async () => {
    const aws = fakeAws();
    aws.raceOnCreate();
    const s = new AwsSecrets('p/', aws.client);
    await s.put('a', 'mine');
    expect(await s.get('a')).toBe('mine');
  });

  it('passes other AWS errors on', async () => {
    const s = new AwsSecrets('p/', {
      send: async () => {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
      },
    });
    await expect(s.get('a')).rejects.toThrow('AccessDenied');
    await expect(s.put('a', 'x')).rejects.toThrow('AccessDenied');
  });
});
