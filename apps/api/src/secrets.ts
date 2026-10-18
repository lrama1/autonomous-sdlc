import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The secrets port. Local mode keeps a git-ignored file. AWS will use Secrets Manager (not built yet). */
export interface SecretsStore {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
  has(name: string): Promise<boolean>;
}

export class FileSecrets implements SecretsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read())[name];
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  // Writes are serialized and atomic (write a temp file, then rename) so a crash cannot leave half a file.
  put(name: string, value: string): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.read();
      all[name] = value;
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export class MemorySecrets implements SecretsStore {
  private data = new Map<string, string>();
  async get(name: string) {
    return this.data.get(name);
  }
  async has(name: string) {
    return this.data.has(name);
  }
  async put(name: string, value: string) {
    this.data.set(name, value);
  }
}
