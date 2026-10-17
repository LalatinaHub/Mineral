// @ts-nocheck
import { readFileSync } from "fs";
import { Snake } from "tgsnake";
import { Api, errors } from "telegram";
import { exit } from "process";
import { parseText } from "./parser";
import { loadLedger, mergeFound, pruneLedger, todayStamp, writeOutputs } from "./store";

const DAY_MS = 86_400_000;

// Tuning knobs. Every one of them is optional: the defaults are what CI runs with.
const RETENTION_DAYS = envNumber("MINERAL_TTL_DAYS", 7);
const HISTORY_DAYS = envNumber("MINERAL_HISTORY_DAYS", 7);
const HISTORY_PAGES = envNumber("MINERAL_HISTORY_PAGES", 5);
const PAGE_LIMIT = 100;
const REQUEST_DELAY_MS = envNumber("MINERAL_REQUEST_DELAY_MS", 150);
const MAX_RETRIES = 5;
const MAX_FLOOD_WAIT_MS = envNumber("MINERAL_MAX_FLOOD_WAIT_MS", 300_000);
const MAX_RUNTIME_MS = envNumber("MINERAL_MAX_RUNTIME_MS", 900_000);
const MAX_MEDIA_BYTES = envNumber("MINERAL_MAX_MEDIA_BYTES", 512 * 1024);
const MAX_MEDIA_FILES = envNumber("MINERAL_MAX_MEDIA_FILES", 200);

const TEXT_MIME = new Set(["text/plain", "text/csv", "application/json", "application/octet-stream"]);
const TEXT_FILE_RE = /\.(txt|json|ya?ml|conf|ini|b64|base64|sub|nodes?)$/i;

// Mirrors advertised on top of whatever we scrape. Order is preserved in sub.json.
const HARDCODED_SUBS = [
  "https://sub.pmsub.me/base64",
  "https://shadowmere.akiel.dev/api/b64sub",
  "https://raw.githubusercontent.com/anaer/Sub/main/clash.yaml",
  "https://raw.githubusercontent.com/free18/v2ray/refs/heads/main/v.txt",
  "https://raw.githubusercontent.com/yebekhe/ConfigCollector/main/sub/mix",
  "https://raw.githubusercontent.com/shabane/kamaji/master/hub/merged.txt",
  "https://raw.githubusercontent.com/LalatinaHub/Mineral/master/result/nodes",
  "https://raw.githubusercontent.com/Pawdroid/Free-servers/refs/heads/main/sub",
  "https://raw.githubusercontent.com/tbbatbb/Proxy/master/dist/v2ray.config.txt",
  "https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt",
  "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
  "https://raw.githubusercontent.com/Mahdi0024/ProxyCollector/master/sub/proxies.txt",
  "https://raw.githubusercontent.com/Leon406/SubCrawler/refs/heads/main/sub/share/a11",
  "https://raw.githubusercontent.com/Bardiafa/Free-V2ray-Config/main/All_Configs_Sub.txt",
  "https://raw.githubusercontent.com/Leon406/SubCrawler/refs/heads/main/sub/share/vless",
  "https://raw.githubusercontent.com/ALIILAPRO/v2rayNG-Config/refs/heads/main/server.txt",
  "https://raw.githubusercontent.com/w1770946466/Auto_proxy/main/Long_term_subscription_num",
  "https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/sub/sub_merge.txt",
  "https://raw.githubusercontent.com/Mahdi0024/ProxyCollector/refs/heads/master/sub/proxies.txt",
  "https://raw.githubusercontent.com/barry-far/V2ray-Configs/refs/heads/main/All_Configs_Sub.txt",
  "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/All_Configs_Sub.txt",
  "https://raw.githubusercontent.com/WilliamStar007/ClashX-V2Ray-TopFreeProxy/main/combine/v2raysub.txt",
  "https://raw.githubusercontent.com/WilliamStar007/ClashX-V2Ray-TopFreeProxy/main/combine/clashsub.txt",
  "https://raw.githubusercontent.com/Surfboardv2ray/v2ray-worker-sub/refs/heads/master/providers/providers",
];

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const bot = new Snake({
  apiHash: readFileSync("./api_hash").toString().trim(),
  apiId: parseInt(readFileSync("./api_id").toString().trim(), 10),
  session: readFileSync("./session").toString().trim(),
  tgsnakeLog: false,
  logger: "error",
});

type PeersType = Api.InputPeerChannel | Api.InputPeerChat;

interface FetchOutcome {
  bodies: string[];
  peersRead: number;
  mediaFiles: number;
  truncated: boolean;
}

let floodWaitedMs = 0;

// gramjs raises a typed FloodWaitError whose message reads "A wait of N seconds is required";
// a raw RPCError instead carries FLOOD_WAIT_N in errorMessage. Cover every shape.
const FLOOD_MESSAGE_RE = [/FLOOD_WAIT_(\d+)/, /A wait of (\d+) seconds/];
const FLOOD_FALLBACK_SECONDS = 30;

function floodSeconds(error: any, message: string): number {
  if (typeof error?.seconds === "number" && Number.isFinite(error.seconds) && error.seconds > 0) {
    return error.seconds;
  }
  const haystack = `${message} ${error?.errorMessage ?? ""}`;
  for (const pattern of FLOOD_MESSAGE_RE) {
    const match = pattern.exec(haystack);
    if (match) return Number(match[1]);
  }
  // Any remaining 420 is still a rate limit; wait a fixed interval instead of hammering.
  return error?.code === 420 ? FLOOD_FALLBACK_SECONDS : 0;
}

/** Invoke a request, absorbing FloodWait and transient RPC errors instead of dropping the peer. */
async function invokeWithRetry(request: any, label: string): Promise<any | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await bot.client.invoke(request);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      const wait = floodSeconds(error, message);
      if (wait > 0) {
        if (floodWaitedMs + wait * 1000 > MAX_FLOOD_WAIT_MS) {
          console.error(`[flood] ${label}: skipping, ${wait}s exceeds the remaining budget`);
          return null;
        }
        floodWaitedMs += wait * 1000;
        console.error(`[flood] ${label}: waiting ${wait}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep((wait + 1) * 1000);
        continue;
      }
      if (attempt >= MAX_RETRIES) {
        console.error(`[error] ${label}: ${message}`);
        return null;
      }
      await sleep(attempt * 500);
    }
  }
  return null;
}

/** Pull the text out of a document attachment when it looks like a config blob. */
async function readDocument(message: any): Promise<string | null> {
  const document = message?.media?.document;
  if (!document || document.className !== "Document") return null;
  const name: string =
    (document.attributes ?? []).find((attribute: any) => attribute.className === "DocumentAttributeFilename")
      ?.fileName ?? "";
  const mime: string = document.mimeType ?? "";
  if (!TEXT_MIME.has(mime) && !TEXT_FILE_RE.test(name)) return null;
  if (typeof document.size === "number" && document.size > MAX_MEDIA_BYTES) {
    console.error(`[media] skipping ${name || mime} (${document.size} bytes)`);
    return null;
  }
  try {
    const buffer = await bot.client.downloadMedia(message.media, { workers: 1 });
    return buffer ? buffer.toString("utf8") : null;
  } catch (error: any) {
    console.error(`[media] ${name || mime}: ${error?.message ?? error}`);
    return null;
  }
}

class Mineral {
  async getPeers(): Promise<PeersType[]> {
    const peers: PeersType[] = [];
    const seen = new Set<string>();
    try {
      for await (const dialog of bot.client.iterDialogs({})) {
        const entity: any = dialog.entity;
        if (!entity) continue;
        const key = String(entity.id);
        if (seen.has(key)) continue;
        if (dialog.isGroup) {
          seen.add(key);
          peers.push(new Api.InputPeerChat({ chatId: entity.id }));
        } else if (dialog.isChannel && entity.accessHash) {
          seen.add(key);
          peers.push(new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash }));
        }
      }
    } catch (error: any) {
      console.error(`[peers] ${error?.message ?? error}`);
    }
    return peers;
  }

  /** Walk each peer's history backwards until the retention window or the page budget is exhausted. */
  async getMessages(peers: PeersType[]): Promise<FetchOutcome> {
    const outcome: FetchOutcome = { bodies: [], peersRead: 0, mediaFiles: 0, truncated: false };
    const startedAt = Date.now();
    const cutoff = startedAt - HISTORY_DAYS * DAY_MS;

    for (const peer of peers) {
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        outcome.truncated = true;
        break;
      }
      outcome.peersRead++;
      if (outcome.peersRead % 25 === 0) {
        console.log(`[history] ${outcome.peersRead}/${peers.length} peers, ${outcome.bodies.length} messages`);
      }

      let offsetId = 0;
      for (let page = 0; page < HISTORY_PAGES; page++) {
        if (Date.now() - startedAt > MAX_RUNTIME_MS) break;
        const result = await invokeWithRetry(
          new Api.messages.GetHistory({ peer, offsetId, limit: PAGE_LIMIT }),
          `history ${outcome.peersRead}/${peers.length} page ${page + 1}`
        );
        if (!result) break;
        const batch: any[] = Array.isArray(result.messages) ? result.messages : [];
        if (!batch.length) break;

        let oldest = Infinity;
        for (const message of batch) {
          if (typeof message?.date === "number") oldest = Math.min(oldest, message.date * 1000);
          if (message?.className !== "Message") continue;
          let body: string = message.message ?? "";
          if (message.media?.className === "MessageMediaDocument" && outcome.mediaFiles < MAX_MEDIA_FILES) {
            const extracted = await readDocument(message);
            if (extracted) {
              outcome.mediaFiles++;
              body = body ? `${body}\n${extracted}` : extracted;
            }
          }
          if (body.length) outcome.bodies.push(body);
        }

        // GetHistory returns newest-first, so the tail of the batch is the oldest message seen.
        const nextOffset = typeof batch[batch.length - 1]?.id === "number" ? batch[batch.length - 1].id : 0;
        if (!nextOffset || nextOffset === offsetId) break;
        offsetId = nextOffset;
        if (batch.length < PAGE_LIMIT) break;
        if (Number.isFinite(oldest) && oldest < cutoff) break;
        await sleep(REQUEST_DELAY_MS);
      }
    }

    return outcome;
  }
}

const mineral = new Mineral();

(async () => {
  const startedAt = Date.now();
  const today = todayStamp();
  const ledger = loadLedger();
  console.log(
    `[load] ${ledger.nodes.size} nodes / ${ledger.subs.size} subs from ./result` +
      (ledger.loaded.droppedNodes + ledger.loaded.droppedSubs > 0
        ? ` (dropped ${ledger.loaded.droppedNodes} node + ${ledger.loaded.droppedSubs} sub lines)`
        : "")
  );

  const fetch: FetchOutcome = { bodies: [], peersRead: 0, mediaFiles: 0, truncated: false };
  let connected = false;
  try {
    await bot.start();
    connected = true;
    const peers = await mineral.getPeers();
    const outcome = await mineral.getMessages(peers);
    fetch.bodies = outcome.bodies;
    fetch.peersRead = outcome.peersRead;
    fetch.mediaFiles = outcome.mediaFiles;
    fetch.truncated = outcome.truncated;
  } catch (error: any) {
    console.error(`[fatal] ${error?.message ?? error}`);
  }

  if (connected) await bot.disconnect().catch(() => {});

  if (fetch.bodies.length === 0) {
    // Never trade a known-good list for an empty one just because the fetch failed.
    console.error("[abort] no messages fetched, ./result left untouched");
    exit(1);
  }

  const report = parseText(fetch.bodies.join("\n"));
  const { newNodeCount, newSubCount } = mergeFound(ledger, report, today);
  const pruned = pruneLedger(ledger, RETENTION_DAYS, today);

  if (ledger.nodes.size === 0) {
    console.error("[abort] merged node list is empty, ./result left untouched");
    exit(1);
  }

  const written = writeOutputs(ledger, RETENTION_DAYS, HARDCODED_SUBS);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    [
      `[done] ${elapsed}s`,
      `peers=${fetch.peersRead}`,
      `messages=${fetch.bodies.length}`,
      `documents=${fetch.mediaFiles}`,
      `parsed=${report.nodes.length}/${report.subs.length}`,
      `rejected=${report.rejected}`,
      `new=${newNodeCount}/${newSubCount}`,
      `retired=${pruned.nodes}/${pruned.subs}`,
      `total=${ledger.nodes.size}/${ledger.subs.size}`,
      `urls=${written.urls}`,
      floodWaitedMs > 0 ? `flood=${Math.round(floodWaitedMs / 1000)}s` : "",
      fetch.truncated ? "truncated=runtime" : "",
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (report.rejectedSamples.length) console.log(`[rejected] ${report.rejectedSamples.join(" | ")}`);
  console.log("Process completed !");
  exit(0);
})();
