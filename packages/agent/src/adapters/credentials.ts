import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CredentialStore {
  get(adapterId: string, key: string): Promise<string | undefined>;
  set(adapterId: string, key: string, value: string): Promise<void>;
  delete(adapterId: string, key: string): Promise<void>;
  values(): Promise<string[]>;
  knownValues(): readonly string[];
}

export class EphemeralCredentialStore implements CredentialStore {
  readonly #values = new Map<string, string>();

  public get(adapterId: string, key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(`${adapterId}\0${key}`));
  }

  public set(adapterId: string, key: string, value: string): Promise<void> {
    this.#values.set(`${adapterId}\0${key}`, value);
    return Promise.resolve();
  }

  public delete(adapterId: string, key: string): Promise<void> {
    this.#values.delete(`${adapterId}\0${key}`);
    return Promise.resolve();
  }

  public values(): Promise<string[]> {
    return Promise.resolve([...this.#values.values()].sort());
  }

  public knownValues(): readonly string[] {
    return [...this.#values.values()].sort();
  }
}

interface CredentialRecord {
  [adapterId: string]: { [key: string]: string };
}

interface FileCredentialStoreOptions {
  userDir?: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

async function readRecord(path: string): Promise<CredentialRecord> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return {};
    throw error;
  }
  const parsed = JSON.parse(source) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Credential store root must be an object.");
  }
  const record: CredentialRecord = {};
  for (const [adapterId, keys] of Object.entries(parsed)) {
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
      throw new TypeError(`Credential entry ${adapterId} must be an object.`);
    }
    record[adapterId] = Object.fromEntries(Object.entries(keys).map(([key, value]) => {
      if (typeof value !== "string") throw new TypeError(`Credential ${adapterId}/${key} is invalid.`);
      return [key, value];
    }));
  }
  return record;
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sortedRecord(record: CredentialRecord): CredentialRecord {
  return Object.fromEntries(Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([adapterId, keys]) => [
      adapterId,
      Object.fromEntries(Object.entries(keys).sort(([left], [right]) =>
        left.localeCompare(right))),
    ]));
}

abstract class JsonCredentialStore implements CredentialStore {
  readonly #path: string;
  #knownValues: string[] = [];

  protected constructor(path: string) {
    this.#path = path;
  }

  protected abstract decode(value: string): string;
  protected abstract encode(value: string): string;

  async #decodedRecord(): Promise<CredentialRecord> {
    const encoded = await readRecord(this.#path);
    const decoded = Object.fromEntries(Object.entries(encoded).map(([adapterId, keys]) => [
      adapterId,
      Object.fromEntries(Object.entries(keys).map(([key, value]) =>
        [key, this.decode(value)])),
    ]));
    this.#knownValues = Object.values(decoded).flatMap((keys) => Object.values(keys));
    return decoded;
  }

  async #writeDecoded(record: CredentialRecord): Promise<void> {
    const encoded = Object.fromEntries(Object.entries(record).map(([adapterId, keys]) => [
      adapterId,
      Object.fromEntries(Object.entries(keys).map(([key, value]) =>
        [key, this.encode(value)])),
    ]));
    await writePrivate(this.#path, `${JSON.stringify(sortedRecord(encoded))}\n`);
    this.#knownValues = Object.values(record).flatMap((keys) => Object.values(keys));
  }

  public async get(adapterId: string, key: string): Promise<string | undefined> {
    return (await this.#decodedRecord())[adapterId]?.[key];
  }

  public async set(adapterId: string, key: string, value: string): Promise<void> {
    if (adapterId.length === 0 || key.length === 0 || value.length === 0) {
      throw new TypeError("Credential adapter, key, and value must not be empty.");
    }
    const record = await this.#decodedRecord();
    record[adapterId] = { ...record[adapterId], [key]: value };
    await this.#writeDecoded(record);
  }

  public async delete(adapterId: string, key: string): Promise<void> {
    const record = await this.#decodedRecord();
    if (record[adapterId] === undefined) return;
    delete record[adapterId]![key];
    if (Object.keys(record[adapterId]!).length === 0) delete record[adapterId];
    await this.#writeDecoded(record);
  }

  public async values(): Promise<string[]> {
    await this.#decodedRecord();
    return [...this.#knownValues].sort();
  }

  public knownValues(): readonly string[] {
    return [...this.#knownValues];
  }
}

export class FileCredentialStore extends JsonCredentialStore {
  public constructor(options: FileCredentialStoreOptions = {}) {
    super(join(options.userDir ?? join(homedir(), ".guyditor"), "state/credentials.json"));
  }

  protected decode(value: string): string {
    return value;
  }

  protected encode(value: string): string {
    return value;
  }
}

export interface SafeStorageCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface SafeStorageCredentialStoreOptions extends FileCredentialStoreOptions {
  codec: SafeStorageCodec;
}

export class SafeStorageCredentialStore extends JsonCredentialStore {
  readonly #codec: SafeStorageCodec;

  public constructor(options: SafeStorageCredentialStoreOptions) {
    if (!options.codec.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is unavailable.");
    }
    super(join(
      options.userDir ?? join(homedir(), ".guyditor"),
      "state/credentials.safe.json",
    ));
    this.#codec = options.codec;
  }

  protected decode(value: string): string {
    return this.#codec.decryptString(Buffer.from(value, "base64"));
  }

  protected encode(value: string): string {
    return this.#codec.encryptString(value).toString("base64");
  }
}
