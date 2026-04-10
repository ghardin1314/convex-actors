import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import { convexQuery } from "@convex-dev/react-query";
import { api } from "../../convex/_generated/api";
import { useState, useCallback } from "react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-10">
        <div>
          <h1 className="text-3xl font-bold">Convex Actors Demo</h1>
          <p className="text-gray-400 mt-1">
            Showcasing success, domain errors, defects, cross-actor messaging,
            self-sends, delayed delivery, and stub.peek().
          </p>
        </div>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Counters + Leaderboard"
            description="Three independent counter actors. The leaderboard actor uses stub.peek() to read all their projections and build a ranked snapshot — peek is read-only, no mutations."
            color="emerald"
          />
          <div className="flex gap-4">
            <CounterActor name="alice" />
            <CounterActor name="bob" />
            <CounterActor name="charlie" />
          </div>
          <LeaderboardPanel />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Delayed Messages + Drain Reschedule"
            description="Messages with opts.after are delivered in the future. If a closer message arrives while a far one is pending, the drain reschedules to fire earlier — then continues to process the later one when its time comes."
            color="emerald"
          />
          <DelayedCounterDemo />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Wallet Transfer"
            description="The source wallet owns the transfer: balance check + debit + send deposit all happen in one handler — no TOCTOU race. Fails via ctx.fail() if funds are insufficient."
            color="violet"
          />
          <TransferDemo />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Fragile Service"
            description='Unhandled throws become "defect" responses after 3 retry attempts. The "work" message succeeds; "crash" always throws.'
            color="red"
          />
          <FragileActor name="demo" />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Countdown Timer"
            description="Uses ctx.sendSelf() with { after } to tick down once per interval. The actor schedules its own future work."
            color="cyan"
          />
          <CountdownDemo />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Ping Pong"
            description="Two actors rally a ball back and forth using ctx.stub().send(). Each hit decrements a counter; when it reaches 0 the rally stops."
            color="blue"
          />
          <PingPongDemo />
        </section>
      </div>
    </main>
  );
}

// ── Shared ────────────────────────────────────────────────────────

function SectionHeader({
  title,
  description,
  color,
}: {
  title: string;
  description: string;
  color: string;
}) {
  const borderColor: string = {
    emerald: "border-emerald-700",
    amber: "border-amber-700",
    red: "border-red-700",
    blue: "border-blue-700",
    violet: "border-violet-700",
    cyan: "border-cyan-700",
  }[color] ?? "border-gray-700";
  return (
    <div className={`border-l-4 ${borderColor} pl-4`}>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-gray-400 text-sm">{description}</p>
    </div>
  );
}

type Response = {
  messageId: string;
  response:
    | { kind: "success"; value: unknown }
    | { kind: "fail"; reason: string; details?: unknown }
    | { kind: "defect"; error: string; attempts: number };
};

function useActorSend() {
  const sendMut = useMutation(api.actorFunctions.send);
  return useCallback(
    async (
      actorType: string,
      name: string,
      msgType: string,
      payload: Record<string, unknown>,
      opts?: { at?: number; after?: number },
    ) => {
      return await sendMut({ actorType, name, msgType, payload, opts });
    },
    [sendMut],
  );
}

function usePeek(actorType: string, name: string) {
  const { data } = useSuspenseQuery(
    convexQuery(api.actorFunctions.peek, { actorType, name }),
  );
  return data;
}

function ResponseBadge({ response }: { response: Response["response"] }) {
  if (response.kind === "success") {
    return (
      <span className="text-xs bg-emerald-900 text-emerald-300 px-2 py-1 rounded font-mono">
        success{" "}
        {response.value != null ? JSON.stringify(response.value) : "null"}
      </span>
    );
  }
  if (response.kind === "fail") {
    return (
      <span className="text-xs bg-amber-900 text-amber-300 px-2 py-1 rounded font-mono">
        fail: {response.reason}{" "}
        {response.details ? JSON.stringify(response.details) : ""}
      </span>
    );
  }
  return (
    <span className="text-xs bg-red-900 text-red-300 px-2 py-1 rounded font-mono">
      defect ({response.attempts} attempts): {response.error}
    </span>
  );
}

function ResponseLog({ messageIds }: { messageIds: string[] }) {
  if (messageIds.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <p className="text-xs text-gray-500 uppercase tracking-wide">
        Responses
      </p>
      {messageIds.map((id) => (
        <ResponseRow key={id} messageId={id} />
      ))}
    </div>
  );
}

function ResponseRow({ messageId }: { messageId: string }) {
  const { data } = useQuery(
    convexQuery(api.actorFunctions.getResponse, { messageId }),
  );
  const resp = data as Response | null | undefined;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-600 font-mono text-xs">
        {messageId.slice(0, 12)}...
      </span>
      {resp ? (
        <ResponseBadge response={resp.response} />
      ) : (
        <span className="text-xs text-gray-600 italic">pending...</span>
      )}
    </div>
  );
}

// ── Counter ──────────────────────────────────────────────────────

function CounterActor({ name }: { name: string }) {
  const projection = usePeek("counter", name);
  const send = useActorSend();

  const sendMsg = (msgType: string, payload: Record<string, unknown>) => {
    void send("counter", name, msgType, payload);
  };

  const count =
    projection && typeof projection === "object" && "count" in projection
      ? (projection as { count: number }).count
      : 0;

  return (
    <div className="flex-1 border border-gray-700 rounded-lg p-4 bg-gray-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono font-semibold text-gray-300 text-sm">
          {name}
        </h3>
        <span className="text-2xl font-bold tabular-nums">{count}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => sendMsg("inc", { by: 1 })}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
        >
          +1
        </button>
        <button
          onClick={() => sendMsg("inc", { by: 5 })}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
        >
          +5
        </button>
        <button
          onClick={() => sendMsg("dec", { by: 1 })}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
        >
          -1
        </button>
        <button
          onClick={() => sendMsg("reset", {})}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
        >
          0
        </button>
      </div>
    </div>
  );
}

// ── Leaderboard ──────────────────────────────────────────────────

function LeaderboardPanel() {
  const projection = usePeek("leaderboard", "main");
  const send = useActorSend();

  const data =
    projection && typeof projection === "object" && "rankings" in projection
      ? (projection as {
          rankings: { name: string; count: number }[];
          lastRefresh?: number;
        })
      : { rankings: [] as { name: string; count: number }[], lastRefresh: undefined };

  const refresh = () => {
    void send("leaderboard", "main", "refresh", {});
  };

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono font-semibold text-gray-300 text-sm">
          leaderboard:main
        </h3>
        <button
          onClick={refresh}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
        >
          Refresh (peek all)
        </button>
      </div>
      {data.rankings.length === 0 ? (
        <p className="text-xs text-gray-600 italic">
          Click refresh to peek at all counters
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {data.rankings.map((r, i) => (
            <div key={r.name} className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 w-5 text-right">
                {i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}
              </span>
              <span className="font-mono text-gray-300 flex-1">{r.name}</span>
              <span className="font-bold tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      )}
      {data.lastRefresh && (
        <p className="text-xs text-gray-600 mt-2">
          snapshot from {new Date(data.lastRefresh).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// ── Fragile ──────────────────────────────────────────────────────

function FragileActor({ name }: { name: string }) {
  const projection = usePeek("fragile", name);
  const send = useActorSend();
  const [messageIds, setMessageIds] = useState<string[]>([]);

  const sendMsg = async (msgType: string, payload: Record<string, unknown>) => {
    const id = await send("fragile", name, msgType, payload);
    setMessageIds((prev) => [id, ...prev].slice(0, 8));
  };

  const processed =
    projection && typeof projection === "object" && "processed" in projection
      ? (projection as { processed: number }).processed
      : 0;

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-mono font-semibold text-gray-300">
          fragile:{name}
        </h3>
        <span className="text-sm text-gray-400">
          {processed} processed
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void sendMsg("work", { value: "hello" })}
          className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
        >
          Send "work"
        </button>
        <button
          onClick={() => void sendMsg("crash", {})}
          className="px-4 py-2 bg-red-800 hover:bg-red-700 rounded text-sm font-medium transition-colors"
        >
          Send "crash"
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        "crash" throws every time. After 3 failed attempts it becomes a defect
        response.
      </p>
      <ResponseLog messageIds={messageIds} />
    </div>
  );
}

// ── Ping Pong ────────────────────────────────────────────────────

function PingPongPanel({ name }: { name: string }) {
  const projection = usePeek("pingPong", name);
  const data =
    projection && typeof projection === "object" && "hits" in projection
      ? (projection as { hits: number; log: string[] })
      : { hits: 0, log: [] as string[] };

  return (
    <div className="flex-1 border border-gray-700 rounded-lg p-4 bg-gray-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono font-semibold text-gray-300">{name}</h3>
        <span className="text-2xl font-bold tabular-nums">{data.hits}</span>
      </div>
      {data.log.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {data.log.map((entry, i) => (
            <span key={i} className="text-xs text-gray-500 font-mono">
              {entry}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PingPongDemo() {
  const send = useActorSend();
  const [rallies, setRallies] = useState(10);

  const serve = async () => {
    await send("pingPong", "alice", "serve", {
      to: "bob",
      rallies: rallies,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">Rallies:</label>
        <input
          type="number"
          value={rallies}
          onChange={(e) => setRallies(Math.max(0, Number(e.target.value) || 0))}
          className="w-20 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-center text-sm"
          min={0}
        />
        <button
          onClick={() => void serve()}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded text-sm font-medium transition-colors"
        >
          Serve to Alice
        </button>
      </div>
      <div className="flex gap-4">
        <PingPongPanel name="alice" />
        <PingPongPanel name="bob" />
      </div>
    </div>
  );
}

// ── Delayed Counter ──────────────────────────────────────────────

type QueuedMsg = {
  id: string;
  by: number;
  delay: number;
  sentAt: number;
};

function DelayedCounterDemo() {
  const projection = usePeek("counter", "delayed");
  const send = useActorSend();
  const [queued, setQueued] = useState<QueuedMsg[]>([]);

  const sendDelayed = async (by: number, delaySec: number) => {
    const id = await send(
      "counter",
      "delayed",
      "inc",
      { by },
      { after: delaySec * 1000 },
    );
    setQueued((prev) => [
      ...prev,
      { id, by, delay: delaySec, sentAt: Date.now() },
    ].slice(-10));
  };

  const count =
    projection && typeof projection === "object" && "count" in projection
      ? (projection as { count: number }).count
      : 0;

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-mono font-semibold text-gray-300">
          counter:delayed
        </h3>
        <span className="text-4xl font-bold tabular-nums">{count}</span>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => void sendDelayed(1, 10)}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
          >
            +1 in 10s
          </button>
          <button
            onClick={() => void sendDelayed(10, 3)}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
          >
            +10 in 3s
          </button>
          <button
            onClick={() => void sendDelayed(100, 1)}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
          >
            +100 in 1s
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Try clicking "+1 in 10s" first, then "+10 in 3s". The drain
          reschedules to the earlier delivery time — the +10 fires first, then
          the +1 still completes when its time comes. Both messages are
          delivered.
        </p>
      </div>

      {queued.length > 0 && (
        <div className="mt-4 flex flex-col gap-1">
          <p className="text-xs text-gray-500 uppercase tracking-wide">
            Queued messages
          </p>
          {queued.map((q) => (
            <QueuedRow key={q.id} msg={q} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueuedRow({ msg }: { msg: QueuedMsg }) {
  const { data } = useQuery(
    convexQuery(api.actorFunctions.getResponse, { messageId: msg.id }),
  );
  const resp = data as Response | null | undefined;
  const delivered = resp?.response?.kind === "success";

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-mono text-xs text-gray-600 w-16">
        +{msg.by} in {msg.delay}s
      </span>
      {delivered ? (
        <span className="text-xs bg-emerald-900 text-emerald-300 px-2 py-0.5 rounded">
          delivered
        </span>
      ) : (
        <span className="text-xs text-gray-600 italic">
          waiting...
        </span>
      )}
    </div>
  );
}

// ── Countdown Timer ──────────────────────────────────────────────

function CountdownDemo() {
  const projection = usePeek("countdown", "demo");
  const send = useActorSend();
  const [from, setFrom] = useState(5);
  const [interval, setInterval_] = useState(1);

  const data =
    projection && typeof projection === "object" && "remaining" in projection
      ? (projection as { remaining: number; running: boolean; log: string[] })
      : { remaining: 0, running: false, log: [] as string[] };

  const start = async () => {
    await send("countdown", "demo", "start", {
      from,
      intervalMs: interval * 1000,
    });
  };

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-mono font-semibold text-gray-300">
          countdown:demo
        </h3>
        <div className="flex items-center gap-3">
          {data.running && (
            <span className="text-xs bg-cyan-900 text-cyan-300 px-2 py-1 rounded">
              running
            </span>
          )}
          <span className="text-4xl font-bold tabular-nums">
            {data.remaining}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">From:</label>
        <input
          type="number"
          value={from}
          onChange={(e) => setFrom(Math.max(1, Number(e.target.value) || 1))}
          className="w-16 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-center text-sm"
          min={1}
        />
        <label className="text-sm text-gray-400">Every:</label>
        <input
          type="number"
          value={interval}
          onChange={(e) =>
            setInterval_(Math.max(0.5, Number(e.target.value) || 1))
          }
          className="w-16 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-center text-sm"
          min={0.5}
          step={0.5}
        />
        <span className="text-sm text-gray-500">sec</span>
        <button
          onClick={() => void start()}
          className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 rounded text-sm font-medium transition-colors"
          disabled={data.running}
        >
          Start
        </button>
      </div>
      {data.log.length > 0 && (
        <div className="mt-3 flex flex-col gap-0.5">
          {data.log.map((entry, i) => (
            <span key={i} className="text-xs text-gray-500 font-mono">
              {entry}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Wallet Transfer ──────────────────────────────────────────────

function WalletPanel({ name }: { name: string }) {
  const projection = usePeek("wallet", name);
  const send = useActorSend();

  const raw =
    projection && typeof projection === "object" && "balance" in projection
      ? (projection as { balance: number; log?: string[] })
      : null;
  const data = {
    balance: raw?.balance ?? 0,
    log: raw?.log ?? [],
  };

  return (
    <div className="flex-1 border border-gray-700 rounded-lg p-4 bg-gray-800">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-sm text-gray-300">wallet:{name}</span>
        <span className="font-bold tabular-nums text-xl">
          ${data.balance.toFixed(2)}
        </span>
      </div>
      <button
        onClick={() => void send("wallet", name, "deposit", { amount: 100 })}
        className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
      >
        + $100
      </button>
      {data.log.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          {data.log.map((entry, i) => (
            <span
              key={i}
              className={`text-xs font-mono ${entry.startsWith("REJECTED") ? "text-amber-400" : "text-gray-500"}`}
            >
              {entry}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TransferDemo() {
  const send = useActorSend();
  const [amount, setAmount] = useState(30);
  const [messageIds, setMessageIds] = useState<string[]>([]);

  const doTransfer = async (from: string, to: string, amt: number) => {
    const id = await send("wallet", from, "transfer", { to, amount: amt });
    setMessageIds((prev) => [id, ...prev].slice(0, 8));
  };

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex gap-4 mb-4">
        <WalletPanel name="alice-w" />
        <WalletPanel name="bob-w" />
      </div>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-sm text-gray-400">Transfer</span>
        <span className="text-sm text-gray-500">$</span>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
          className="w-20 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-center text-sm"
          min={1}
        />
        <button
          onClick={() => void doTransfer("alice-w", "bob-w", amount)}
          className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded text-sm font-medium transition-colors"
        >
          Alice -&gt; Bob
        </button>
        <button
          onClick={() => void doTransfer("bob-w", "alice-w", amount)}
          className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded text-sm font-medium transition-colors"
        >
          Bob -&gt; Alice
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        The transfer message goes directly to the source wallet. Balance check +
        debit + send deposit all happen in one handler — atomic, no races. Try
        transferring more than available.
      </p>
      <ResponseLog messageIds={messageIds} />
    </div>
  );
}
