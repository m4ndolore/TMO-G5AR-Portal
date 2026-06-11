// Server-side 5G signal history: polls the gateway and appends samples to a
// JSONL file so the dashboard can chart signal quality over time (useful for
// finding the best antenna placement / tracking performance).
//
// Storage is a plain append-only JSONL file (one JSON sample per line) — no
// database dependency, survives restarts, and is trivial to export. Configure
// via env vars:
//   ROUTER_IP                 gateway IP to poll       (default 192.168.12.1)
//   SIGNAL_DATA_DIR           directory for the file   (default <cwd>/.data)
//   SIGNAL_MAX_ENTRIES        retained samples cap     (default 20000)
import { promises as fs } from "fs"
import path from "path"

const DATA_DIR = process.env.SIGNAL_DATA_DIR || path.join(process.cwd(), ".data")
const FILE = path.join(DATA_DIR, "signal-history.jsonl")
const MAX_ENTRIES = Number(process.env.SIGNAL_MAX_ENTRIES) || 20000

export interface SignalSample {
  t: number // epoch milliseconds
  rsrp: number
  rsrq: number
  sinr: number
  rssi: number
  bars: number
  bands: string[]
  cid: number
  gnbid: number
  reg: string // registration state
}

function routerIp(): string {
  return process.env.ROUTER_IP || "192.168.12.1"
}

// The gateway exposes get=all without authentication, so the background poller
// needs no token (it runs outside any request/cookie context).
export async function fetchSignalSample(): Promise<SignalSample | null> {
  const res = await fetch(`http://${routerIp()}/TMI/v1/gateway?get=all`, {
    cache: "no-store",
  })
  if (!res.ok) return null

  const data = await res.json()
  const s = data?.signal?.["5g"]
  if (!s || typeof s.rsrp !== "number") return null

  return {
    t: Date.now(),
    rsrp: s.rsrp,
    rsrq: s.rsrq,
    sinr: s.sinr,
    rssi: s.rssi,
    bars: s.bars,
    bands: Array.isArray(s.bands) ? s.bands : [],
    cid: s.cid,
    gnbid: s.gNBID,
    reg: data?.signal?.generic?.registration ?? "",
  }
}

async function readAll(): Promise<SignalSample[]> {
  let text: string
  try {
    text = await fs.readFile(FILE, "utf8")
  } catch {
    return [] // no history yet
  }

  const out: SignalSample[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip a partially-written / corrupt line rather than failing the read
    }
  }
  return out
}

let lastPrune = 0

// Keep the file from growing unbounded. Rewriting is O(file), so only do it
// occasionally (every ~30 min) rather than on every append.
async function maybePrune(): Promise<void> {
  const now = Date.now()
  if (now - lastPrune < 30 * 60 * 1000) return
  lastPrune = now

  const all = await readAll()
  if (all.length <= MAX_ENTRIES) return

  const trimmed = all.slice(-MAX_ENTRIES)
  await fs.writeFile(FILE, trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

// Poll the gateway once and append the sample. Returns the sample, or null if
// the gateway was unreachable / returned no 5G data.
export async function recordSample(): Promise<SignalSample | null> {
  const sample = await fetchSignalSample()
  if (!sample) return null

  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.appendFile(FILE, JSON.stringify(sample) + "\n", "utf8")
  await maybePrune()
  return sample
}

// Read samples newer than `sinceMs` (epoch ms).
export async function readHistory(sinceMs: number): Promise<SignalSample[]> {
  const all = await readAll()
  return all.filter((e) => e.t >= sinceMs)
}

// ── Background poller ──────────────────────────────────────────────────────
// A process-wide singleton interval that records a sample on a fixed cadence.
// We arm it lazily from the Node.js API routes (rather than an instrumentation
// hook) because middleware forces instrumentation into the edge runtime, where
// `fs` is unavailable. Calling ensurePoller() repeatedly is safe — it starts at
// most one interval per server process. Once armed it keeps recording for the
// life of the process, even with no browser open.
//
// Env vars:
//   SIGNAL_POLL_INTERVAL_MS   poll cadence in ms  (default 60000)
//   SIGNAL_HISTORY_DISABLED   set to "1" to disable

declare global {
  // eslint-disable-next-line no-var
  var __signalPoller: NodeJS.Timeout | undefined
}

export function ensurePoller(): void {
  if (process.env.SIGNAL_HISTORY_DISABLED === "1") return
  if (globalThis.__signalPoller) return // already armed in this process

  const intervalMs = Number(process.env.SIGNAL_POLL_INTERVAL_MS) || 60000

  const tick = async () => {
    try {
      await recordSample()
    } catch (err) {
      console.error("[signal-history] poll failed:", err)
    }
  }

  globalThis.__signalPoller = setInterval(tick, intervalMs)
  void tick() // record immediately on first arm
  console.log(`[signal-history] polling gateway every ${intervalMs}ms`)
}
