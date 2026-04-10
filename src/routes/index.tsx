import { createFileRoute } from "@tanstack/react-router";
import { api } from "../../convex/_generated/api";
import { useState } from "react";
import { createActorHooks } from "../../convex/components/actors/client/react";
import {
  counter,
  wallet,
  fragile,
  jobRunner,
  pingPong,
  countdown,
  leaderboard,
  transferSaga,
} from "../../convex/actors";

const { useActor, useActorResponse } = createActorHooks(api.actorFunctions);

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
            title="Wallet Transfer (ask/reply)"
            description="The source wallet debits itself, then uses ctx.ask() to deposit into the target wallet. The reply routes back to a transferDepositResult handler that logs the confirmation — or compensates on failure."
            color="violet"
          />
          <TransferDemo />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Transfer Saga (chained ask/reply)"
            description="A separate saga actor orchestrates a two-step transfer: ask wallet A to withdraw, on success ask wallet B to deposit. Each step is a separate ask with the reply driving the next phase. Demonstrates the saga pattern with typed context carry-through."
            color="violet"
          />
          <TransferSagaDemo />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Job Runner (ask + defect handling)"
            description='Dispatches jobs to a fragile worker via ctx.ask(). Successful work echoes back through the reply handler. Crash jobs defect after 3 retries — the defect routes back too, so the runner can track failures.'
            color="red"
          />
          <JobRunnerDemo />
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
  const resp = useActorResponse(messageId);
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
  const { send, peek } = useActor(counter, name);

  return (
    <div className="flex-1 border border-gray-700 rounded-lg p-4 bg-gray-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono font-semibold text-gray-300 text-sm">
          {name}
        </h3>
        <span className="text-2xl font-bold tabular-nums">{peek?.count ?? 0}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void send("inc", { by: 1 })}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
        >
          +1
        </button>
        <button
          onClick={() => void send("inc", { by: 5 })}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
        >
          +5
        </button>
        <button
          onClick={() => void send("dec", { by: 1 })}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-medium transition-colors"
        >
          -1
        </button>
        <button
          onClick={() => void send("reset", {})}
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
  const { send, peek } = useActor(leaderboard, "main");

  const data = peek ?? { rankings: [], lastRefresh: undefined };

  const refresh = () => {
    void send("refresh", {});
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
  const { send, peek } = useActor(fragile, name);
  const [messageIds, setMessageIds] = useState<string[]>([]);

  const sendTracked = async (
    ...args: Parameters<typeof send>
  ) => {
    const id = await send(...args);
    setMessageIds((prev) => [id, ...prev].slice(0, 8));
  };

  const processed = peek?.processed ?? 0;

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
          onClick={() => void sendTracked("work", { value: "hello" })}
          className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
        >
          Send "work"
        </button>
        <button
          onClick={() => void sendTracked("crash", {})}
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
  const { peek } = useActor(pingPong, name);
  const data = peek ?? { hits: 0, log: [] as string[] };

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
  const alice = useActor(pingPong, "alice");
  const [rallies, setRallies] = useState(10);

  const serve = async () => {
    await alice.send("serve", { to: "bob", rallies });
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
  const { send, peek } = useActor(counter, "delayed");
  const [queued, setQueued] = useState<QueuedMsg[]>([]);

  const sendDelayed = async (by: number, delaySec: number) => {
    const id = await send("inc", { by }, { after: delaySec * 1000 });
    setQueued((prev) => [
      ...prev,
      { id, by, delay: delaySec, sentAt: Date.now() },
    ].slice(-10));
  };

  const count = peek?.count ?? 0;

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
  const resp = useActorResponse(msg.id);
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
  const { send, peek } = useActor(countdown, "demo");
  const [from, setFrom] = useState(5);
  const [interval, setInterval_] = useState(1);

  const data = peek ?? { remaining: 0, running: false, log: [] as string[] };

  const start = async () => {
    await send("start", { from, intervalMs: interval * 1000 });
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

// ── Job Runner ──────────────────────────────────────────────────

function JobRunnerDemo() {
  const { send, peek } = useActor(jobRunner, "demo");
  const [value, setValue] = useState("hello");

  const data = peek ?? { pending: 0, completed: [], failed: [] };

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-mono font-semibold text-gray-300">
          jobRunner:demo
        </h3>
        <div className="flex items-center gap-3">
          {data.pending > 0 && (
            <span className="text-xs bg-amber-900 text-amber-300 px-2 py-1 rounded">
              {data.pending} pending
            </span>
          )}
          <span className="text-sm text-gray-400">
            {data.completed.length} done / {data.failed.length} failed
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 mb-3">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm flex-1"
          placeholder="Job value..."
        />
        <button
          onClick={() => void send("dispatch", { worker: "w1", value })}
          className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm font-medium transition-colors"
        >
          Dispatch Work
        </button>
        <button
          onClick={() => void send("dispatchCrash", { worker: "w-crash" })}
          className="px-4 py-2 bg-red-800 hover:bg-red-700 rounded text-sm font-medium transition-colors"
        >
          Dispatch Crash
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        "Dispatch Work" asks fragile:w1 to process the value — the echo comes
        back via reply. "Dispatch Crash" asks fragile:w-crash to crash — after 3
        retries the defect routes back to the runner.
      </p>
      {data.completed.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Completed
          </p>
          {data.completed.map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="text-xs bg-emerald-900 text-emerald-300 px-2 py-0.5 rounded font-mono">
                {c.job} → {c.echo}
              </span>
            </div>
          ))}
        </div>
      )}
      {data.failed.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Failed
          </p>
          {data.failed.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className="text-xs bg-red-900 text-red-300 px-2 py-0.5 rounded font-mono">
                {f.job}: {f.error}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Transfer Saga ───────────────────────────────────────────────

function TransferSagaDemo() {
  const { send: sendSaga, peek: sagaPeek } = useActor(
    transferSaga,
    "demo-tx",
  );
  const { send: sendAlice, peek: alicePeek } = useActor(wallet, "saga-alice");
  const { send: sendBob, peek: bobPeek } = useActor(wallet, "saga-bob");
  const [amount, setAmount] = useState(25);

  const saga = sagaPeek ?? {
    phase: "init",
    from: "",
    to: "",
    amount: 0,
    failReason: undefined,
  };
  const aliceBalance = alicePeek?.balance ?? 0;
  const bobBalance = bobPeek?.balance ?? 0;

  const phaseColors: Record<string, string> = {
    init: "bg-gray-700 text-gray-300",
    withdrawing: "bg-amber-900 text-amber-300",
    depositing: "bg-blue-900 text-blue-300",
    done: "bg-emerald-900 text-emerald-300",
    failed: "bg-red-900 text-red-300",
  };

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-mono font-semibold text-gray-300">
          transferSaga:demo-tx
        </h3>
        <span
          className={`text-xs px-2 py-1 rounded font-mono ${phaseColors[saga.phase] ?? "bg-gray-700 text-gray-300"}`}
        >
          {saga.phase}
          {saga.failReason ? `: ${saga.failReason}` : ""}
        </span>
      </div>

      <div className="flex gap-4 mb-4">
        <div className="flex-1 border border-gray-700 rounded-lg p-3 bg-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-sm text-gray-300">
              wallet:saga-alice
            </span>
            <span className="font-bold tabular-nums">
              ${aliceBalance.toFixed(2)}
            </span>
          </div>
          <button
            onClick={() => void sendAlice("deposit", { amount: 100 })}
            className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
          >
            + $100
          </button>
        </div>
        <div className="flex-1 border border-gray-700 rounded-lg p-3 bg-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-sm text-gray-300">
              wallet:saga-bob
            </span>
            <span className="font-bold tabular-nums">
              ${bobBalance.toFixed(2)}
            </span>
          </div>
          <button
            onClick={() => void sendBob("deposit", { amount: 100 })}
            className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-medium transition-colors"
          >
            + $100
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
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
          onClick={() =>
            void sendSaga("start", {
              from: "saga-alice",
              to: "saga-bob",
              amount,
            })
          }
          className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded text-sm font-medium transition-colors"
        >
          Alice → Bob (saga)
        </button>
        <button
          onClick={() =>
            void sendSaga("start", {
              from: "saga-bob",
              to: "saga-alice",
              amount,
            })
          }
          className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded text-sm font-medium transition-colors"
        >
          Bob → Alice (saga)
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        The saga asks wallet A to withdraw, waits for the reply, then asks wallet
        B to deposit. Each step is a typed ask/reply. Try transferring more than
        available — the saga catches the fail reply and stops.
      </p>
    </div>
  );
}

// ── Wallet Transfer ──────────────────────────────────────────────

function WalletPanel({ name }: { name: string }) {
  const { send, peek } = useActor(wallet, name);

  const data = {
    balance: peek?.balance ?? 0,
    log: peek?.log ?? [],
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
        onClick={() => void send("deposit", { amount: 100 })}
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
  const aliceW = useActor(wallet, "alice-w");
  const bobW = useActor(wallet, "bob-w");
  const [amount, setAmount] = useState(30);
  const [messageIds, setMessageIds] = useState<string[]>([]);

  const doTransfer = async (
    sender: { send: typeof aliceW.send },
    to: string,
    amt: number,
  ) => {
    const id = await sender.send("transfer", { to, amount: amt });
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
          onClick={() => void doTransfer(aliceW, "bob-w", amount)}
          className="px-3 py-2 bg-violet-700 hover:bg-violet-600 rounded text-sm font-medium transition-colors"
        >
          Alice -&gt; Bob
        </button>
        <button
          onClick={() => void doTransfer(bobW, "alice-w", amount)}
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
