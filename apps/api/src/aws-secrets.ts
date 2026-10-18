import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretsStore } from './secrets.js';

/** The part of the AWS client this adapter uses, so tests can stand in for AWS. */
export interface SecretsManagerLike {
  send(command: unknown): Promise<{ SecretString?: string }>;
}

/**
 * The secrets port on AWS: one Secrets Manager secret per name, under a prefix (for example "sdlc/dev/").
 * The task role may touch only that prefix.
 */
export class AwsSecrets implements SecretsStore {
  constructor(
    private readonly prefix: string,
    private readonly client: SecretsManagerLike = new SecretsManagerClient(
      {},
    ) as SecretsManagerLike,
  ) {}

  private id(name: string): string {
    return `${this.prefix}${name}`;
  }

  async get(name: string): Promise<string | undefined> {
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: this.id(name) }));
      return out.SecretString;
    } catch (e) {
      if (
        e instanceof ResourceNotFoundException ||
        (e as { name?: string }).name === 'ResourceNotFoundException'
      )
        return undefined;
      throw e;
    }
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  async put(name: string, value: string): Promise<void> {
    try {
      await this.client.send(
        new PutSecretValueCommand({ SecretId: this.id(name), SecretString: value }),
      );
    } catch (e) {
      if (
        !(e instanceof ResourceNotFoundException) &&
        (e as { name?: string }).name !== 'ResourceNotFoundException'
      )
        throw e;
      try {
        await this.client.send(
          new CreateSecretCommand({ Name: this.id(name), SecretString: value }),
        );
      } catch (e2) {
        // Another process created it between our two calls.
        if (
          !(e2 instanceof ResourceExistsException) &&
          (e2 as { name?: string }).name !== 'ResourceExistsException'
        )
          throw e2;
        await this.client.send(
          new PutSecretValueCommand({ SecretId: this.id(name), SecretString: value }),
        );
      }
    }
  }
}
