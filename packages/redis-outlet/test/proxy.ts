// A TCP relay in front of the test Redis server that a test can take down and bring back, as a Redis restart or a
// network cut would: down closes every relayed connection and refuses new ones, up accepts again on the same port. It
// also keeps what the clients sent, so a test can read the commands the outlet gave Redis.
import type { Socket, TCPSocketListener } from "bun";

interface Relay { upstream: Socket<undefined> | undefined; queued: Uint8Array[] }

export interface RedisProxy {
  /** `redis://127.0.0.1:<port>`, the URL a test gives the outlet. */
  readonly url: string;
  /** Every byte the clients sent through the relay so far, as text: the RESP commands Redis was asked to run. */
  sent(): string;
  down(): void;
  up(): void;
  stop(): void;
}

export function redisProxy(target: string): RedisProxy {
  const { hostname, port } = new URL(target);
  let accepting = true;
  const open = new Set<Socket<Relay>>();
  let sent = "";
  const listener: TCPSocketListener<Relay> = Bun.listen<Relay>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        if (!accepting) { client.end(); return; }
        client.data = { upstream: undefined, queued: [] };
        open.add(client);
        try {
          const upstream = await Bun.connect({
            hostname, port: Number(port || 6379),
            socket: { data: (_socket, chunk) => { client.write(chunk); }, close: () => { client.end(); }, error: () => { client.end(); } },
          });
          client.data.upstream = upstream;
          for (const chunk of client.data.queued.splice(0)) upstream.write(chunk);
        } catch {
          client.end();
        }
      },
      data(client, chunk) {
        sent += Buffer.from(chunk).toString("latin1");
        if (client.data.upstream) client.data.upstream.write(chunk);
        else client.data.queued.push(new Uint8Array(chunk));
      },
      close(client) {
        open.delete(client);
        client.data?.upstream?.end();
      },
    },
  });
  return {
    url: `redis://127.0.0.1:${listener.port}`,
    sent: () => sent,
    down() {
      accepting = false;
      for (const client of open) client.end();
    },
    up() { accepting = true; },
    stop() {
      accepting = false;
      for (const client of open) client.end();
      listener.stop(true);
    },
  };
}
