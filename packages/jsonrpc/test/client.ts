// A raw test client: writes bytes to the server's socket and reads back whole lines.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";

/** A temporary directory for sockets, removed by `remove()`. Short, so the socket path fits the platform's limit. */
export async function socketDir(): Promise<{ path: (name?: string) => string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "jsonrpc-"));
  return {
    path: (name = "s.sock") => join(dir, name),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

/** How long a test waits for a line before it decides none is coming. */
const WAIT_MS = 2_000;

export class Client {
  readonly #socket: Socket<undefined>;
  readonly #lines: string[] = [];
  readonly #waiting: ((line: string) => void)[] = [];
  #pending: Uint8Array = new Uint8Array(0);
  #closed = false;
  readonly #closedWaiters: (() => void)[] = [];

  private constructor(socket: Socket<undefined>) {
    this.#socket = socket;
  }

  static async open(path: string): Promise<Client> {
    let client: Client | undefined;
    const early: Uint8Array[] = [];
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, chunk) {
          if (client) client.#receive(chunk);
          else early.push(new Uint8Array(chunk));
        },
        close() {
          if (client) client.#markClosed();
        },
      },
    });
    client = new Client(socket);
    for (const chunk of early) client.#receive(chunk);
    return client;
  }

  /** Writes raw text or bytes, exactly as given. */
  write(data: string | Uint8Array): void {
    const written = this.#socket.write(data);
    const length = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
    if (written !== length) throw new Error(`the test client wrote ${written} of ${length} bytes`);
  }

  /** Writes one request line. */
  send(message: unknown): void {
    this.write(JSON.stringify(message) + "\n");
  }

  /** The next line the server wrote, parsed. */
  async next(): Promise<any> {
    return JSON.parse(await this.nextLine());
  }

  /** The next line the server wrote, as text. Rejects when none arrives in time. */
  nextLine(): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        reject(new Error("no line from the server"));
      }, WAIT_MS);
      const waiter = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.#waiting.push(waiter);
    });
  }

  /** Resolves when the server closes the connection. */
  closed(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#closedWaiters.push(resolve));
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  end(): void {
    this.#socket.end();
  }

  #receive(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.length);
    let start = 0;
    for (let end = joined.indexOf(0x0a); end !== -1; end = joined.indexOf(0x0a, start)) {
      const line = new TextDecoder().decode(joined.subarray(start, end));
      start = end + 1;
      const waiter = this.#waiting.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    }
    this.#pending = joined.slice(start);
  }

  #markClosed(): void {
    this.#closed = true;
    for (const resolve of this.#closedWaiters.splice(0)) resolve();
  }
}

/** A promise with its resolve function, for a method the test finishes by hand. */
export function gate<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
