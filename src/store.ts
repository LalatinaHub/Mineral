// Result persistence: load previous output, merge new finds, retire stale entries, write everything back.
// Retention works by remembering *when a node first went missing* rather than a timestamp per node,
// which keeps result/state.json small and keeps git diffs tied to real content changes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { normalizeSubUrl, parseNodeText, parseSubText, type NodeEntry, type SubEntry } from "./parser";

export const RESULT_DIR = process.env.MINERAL_RESULT_DIR || "./result";
const NODES_FILE = `${RESULT_DIR}/nodes`;
const SUBS_FILE = `${RESULT_DIR}/subs`;
const SUB_JSON_FILE = `${RESULT_DIR}/sub.json`;
const STATE_FILE = `${RESULT_DIR}/state.json`;
const STATE_VERSION = 1;

const DAY_MS = 86_400_000;

export function todayStamp(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dayValue(stamp: string): number {
  const parsed = Date.parse(`${stamp}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function sortedObject(map: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) as string;
  return out;
}

export interface Ledger {
  /** identity -> link text. */
  nodes: Map<string, string>;
  subs: Map<string, string>;
  /** identity -> date the entry was first missed. Entries here are on the retirement clock. */
  carriedNodes: Map<string, string>;
  carriedSubs: Map<string, string>;
  loaded: { nodes: number; subs: number; droppedNodes: number; droppedSubs: number };
}

export function loadLedger(): Ledger {
  const ledger: Ledger = {
    nodes: new Map(),
    subs: new Map(),
    carriedNodes: new Map(),
    carriedSubs: new Map(),
    loaded: { nodes: 0, subs: 0, droppedNodes: 0, droppedSubs: 0 },
  };

  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
      for (const bucket of ["carriedNodes", "carriedSubs"] as const) {
        const values = state[bucket];
        if (!values || typeof values !== "object") continue;
        const target = bucket === "carriedNodes" ? ledger.carriedNodes : ledger.carriedSubs;
        for (const [identity, stamp] of Object.entries(values as Record<string, unknown>)) {
          if (typeof stamp === "string") target.set(identity, stamp);
        }
      }
    } catch (error) {
      console.error(`[store] state.json unreadable, starting fresh: ${(error as Error).message}`);
    }
  }

  for (const line of readLines(NODES_FILE)) {
    // Re-parsing also repairs entries written by older versions of the scraper.
    const entry = parseNodeText(line);
    if (!entry) {
      ledger.loaded.droppedNodes++;
      continue;
    }
    if (!ledger.nodes.has(entry.identity)) {
      ledger.nodes.set(entry.identity, entry.text);
      ledger.loaded.nodes++;
    }
  }

  for (const line of readLines(SUBS_FILE)) {
    const entry = parseSubText(line);
    if (!entry) {
      ledger.loaded.droppedSubs++;
      continue;
    }
    if (!ledger.subs.has(entry.identity)) {
      ledger.subs.set(entry.identity, entry.text);
      ledger.loaded.subs++;
    }
  }

  return ledger;
}

/** Fold this run's findings in and start the retirement clock for anything we did not see again. */
export function mergeFound(
  ledger: Ledger,
  found: { nodes: NodeEntry[]; subs: SubEntry[] },
  today: string
): { newNodeCount: number; newSubCount: number; missedNodes: number } {
  let newNodeCount = 0;
  let newSubCount = 0;

  const seenNodes = new Set<string>();
  for (const node of found.nodes) {
    if (!ledger.nodes.has(node.identity)) newNodeCount++;
    ledger.nodes.set(node.identity, node.text);
    ledger.carriedNodes.delete(node.identity);
    seenNodes.add(node.identity);
  }

  const seenSubs = new Set<string>();
  for (const sub of found.subs) {
    if (!ledger.subs.has(sub.identity)) newSubCount++;
    ledger.subs.set(sub.identity, sub.text);
    ledger.carriedSubs.delete(sub.identity);
    seenSubs.add(sub.identity);
  }

  let missedNodes = 0;
  for (const identity of ledger.nodes.keys()) {
    if (seenNodes.has(identity)) continue;
    missedNodes++;
    if (!ledger.carriedNodes.has(identity)) ledger.carriedNodes.set(identity, today);
  }
  for (const identity of ledger.subs.keys()) {
    if (seenSubs.has(identity)) continue;
    if (!ledger.carriedSubs.has(identity)) ledger.carriedSubs.set(identity, today);
  }

  return { newNodeCount, newSubCount, missedNodes };
}

/** Drop entries that have been missing for longer than the retention window. */
export function pruneLedger(ledger: Ledger, ttlDays: number, today: string): { nodes: number; subs: number } {
  const cutoff = dayValue(today) - ttlDays * DAY_MS;
  const pruned = { nodes: 0, subs: 0 };

  for (const [identity, since] of [...ledger.carriedNodes]) {
    if (!ledger.nodes.has(identity)) {
      ledger.carriedNodes.delete(identity);
      continue;
    }
    if (dayValue(since) <= cutoff) {
      ledger.nodes.delete(identity);
      ledger.carriedNodes.delete(identity);
      pruned.nodes++;
    }
  }

  for (const [identity, since] of [...ledger.carriedSubs]) {
    if (!ledger.subs.has(identity)) {
      ledger.carriedSubs.delete(identity);
      continue;
    }
    if (dayValue(since) <= cutoff) {
      ledger.subs.delete(identity);
      ledger.carriedSubs.delete(identity);
      pruned.subs++;
    }
  }

  return pruned;
}

export function writeOutputs(ledger: Ledger, ttlDays: number, hardcodedSubs: string[]): { urls: number } {
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });

  const nodes = [...ledger.nodes.values()].sort();
  writeFileSync(NODES_FILE, nodes.length ? `${nodes.join("\n")}\n` : "");

  const subs = [...ledger.subs.values()].sort();
  writeFileSync(SUBS_FILE, subs.length ? `${subs.join("\n")}\n` : "");

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of [...hardcodedSubs, ...subs]) {
    const identity = normalizeSubUrl(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    urls.push(candidate);
  }

  writeFileSync(
    SUB_JSON_FILE,
    `${JSON.stringify(
      [
        {
          id: 0,
          remarks: "LalatinaHub/Mineral",
          site: "https://github.com/LalatinaHub/Mineral",
          url: urls.join("|"),
          update_method: "auto",
          enabled: true,
        },
      ],
      null,
      2
    )}\n`
  );

  writeFileSync(
    STATE_FILE,
    `${JSON.stringify(
      {
        version: STATE_VERSION,
        ttlDays,
        carriedNodes: sortedObject(ledger.carriedNodes),
        carriedSubs: sortedObject(ledger.carriedSubs),
      },
      null,
      2
    )}\n`
  );

  return { urls: urls.length };
}
