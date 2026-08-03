// Minimal websocket client for the Block Scholes wsAPI staging deployment: authenticate,
// subscribe to one SUI-signed value batch and one SUI-signed SVI batch as a "Deepbook"
// client, and resolve as soon as both have streamed their first signed payload. Uses
// Node's native WebSocket (stable since Node 22) — no new dependency needed.
//
// Auth is message-based (`{"method":"authenticate"}`), not header-based: the native
// WebSocket API (unlike Node's `ws` package) has no way to set request headers on the
// handshake, matching the browser spec.

import type { WireBatchData } from "./wire_convert.js";

/// Staging by default; `SUI_WSAPI_URL` points the same flow at another
/// deployment. Each environment holds its own signing secret, so the batches a
/// given endpoint returns only verify against the registry that environment's
/// signer is registered in — the endpoint and the on-chain deployment are one
/// choice, not two.
const DEFAULT_WSAPI_URL = "wss://staging-websocket-api.blockscholes.com/";
export const WSAPI_URL = process.env["SUI_WSAPI_URL"] ?? DEFAULT_WSAPI_URL;

export interface SuiWireResult {
  data: WireBatchData;
  signature: { r: string; s: string; v: string };
  client_id: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string; code: number };
  params?: unknown;
}

/// Unique per run: a client_id carries the subscription BS already resolved for it,
/// and re-subscribing under one reuses that. A `21d` tenor resolves to a different
/// absolute expiry each time, so a reused id is rejected as contradicting itself.
const RUN_ID = Math.random().toString(36).slice(2, 10);
const clientId = (label: string) => `sui-e2e-${label}-${RUN_ID}`;

/// The identity fields these subscriptions carry. Exported because the e2e derives
/// the same two sids on-chain to compare against the ones BS derives — one
/// definition, so the request and the check cannot describe different series.
///
/// `index.px` takes `blockscholes` or `binance`, not `composite`; the defaults that
/// exist off-chain are spelled out here because an on-chain caller cannot resolve
/// them.
const TENOR_UNIT_MS: Record<string, bigint> = { d: 86_400_000n, h: 3_600_000n };

/// The tenor's duration in ms, derived from its own spelling rather than
/// restated: the sid is keyed by the duration and the request carries the
/// string, so two constants would be two chances to disagree.
function tenorToMs(tenor: string): bigint {
  const unit = TENOR_UNIT_MS[tenor.slice(-1).toLowerCase()];
  if (unit === undefined) throw new Error(`unsupported tenor unit in ${tenor} (expected d or h)`);
  return BigInt(tenor.slice(0, -1)) * unit;
}

/// Overridable because a tenor sid is currently single-use upstream: the first
/// subscription pins the resolved absolute expiry against it, and every later
/// one resolves the same tenor to a new instant and is refused. A fresh tenor
/// is the way to re-run this end to end until that is fixed.
const TENOR = process.env["SUI_TENOR"] ?? "21d";

export const SUBSCRIPTION = {
  decimals: 9,
  baseAsset: "BTC",
  quoteAsset: "USD",
  // Asset classes are named, not assumed: a non-crypto underlying suffixes them
  // (`spot-equity`, `option-equity`), and the sid derivation must be handed the
  // same spelling this subscription sends.
  indexAsset: "spot",
  modelAsset: "option",
  indexExchange: "blockscholes",
  modelExchange: "composite",
  model: "SVI",
  tenor: TENOR,
  tenorMs: tenorToMs(TENOR),
} as const;

function suiSignature(network: string) {
  return {
    type: "SUI",
    pkg_ver: 1,
    signature_schema: "ecdsa",
    domain: { network },
  };
}

function batchOptions(network: string) {
  return {
    format: { timestamp: "ms", hexify: false, decimals: SUBSCRIPTION.decimals },
    signature: suiSignature(network),
  };
}

/// One feed to subscribe to, and the name its signed batch comes back under.
export interface FeedRequest {
  label: string;
  item: Record<string, unknown>;
}

/// An absolute instant, deliberately not a tenor: a tenor sid can be subscribed
/// only once upstream, and this test should stay re-runnable. Computed relative
/// to now rather than a fixed date, which would eventually name an expired
/// instrument and fail this test with an unrelated 60s timeout instead of data.
const FUTURE_EXPIRY_DAYS_AHEAD = 90;
const FUTURE_EXPIRY = new Date(Date.now() + FUTURE_EXPIRY_DAYS_AHEAD * 86_400_000).toISOString();

/// The two marks: a perpetual (no expiry) and a dated future (absolute expiry).
/// Same feed and same base asset, so the asset class and the expiry are the only
/// reason these are two series rather than one.
export const MARK_SUBSCRIPTION = {
  perpetual: { asset: "perpetual", exchange: "blockscholes", baseAsset: "BTC" },
  future: {
    asset: "future",
    exchange: "deribit",
    baseAsset: "BTC",
    expiry: FUTURE_EXPIRY,
    // Parsed from the spelling above rather than restated: the request carries
    // the string and the sid is keyed by the instant, so a second constant would
    // just be a second chance to disagree.
    expiryMs: BigInt(Date.parse(FUTURE_EXPIRY)),
  },
} as const;

/// Fetch one signed SUI batch per request, resolving once every one has streamed.
///
/// No request carries a `sid`: BS derives one from the identity fields, which is
/// the value the on-chain derivation is checked against. Every defaulted field is
/// spelled out for the same reason — an unstated default is one the consumer would
/// have to guess to reproduce the id.
export async function fetchSuiFeeds(
  apiKey: string,
  network: string,
  requests: FeedRequest[],
  wsUrl: string = WSAPI_URL,
): Promise<Record<string, SuiWireResult>> {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const results = new Map<string, SuiWireResult>();
  const wanted = new Map(requests.map((r) => [clientId(r.label), r.label]));
  let settled = false;

  function send(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  return new Promise<Record<string, SuiWireResult>>((resolve, reject) => {
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      // Settle anything still in flight: an awaited send() would otherwise hang
      // forever, holding its closure alive after the caller has already failed.
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      reject(err);
    };

    const timeout = setTimeout(() => fail(new Error("timed out waiting for wsAPI to stream every SUI batch")), 60_000);

    ws.addEventListener("error", () => fail(new Error("websocket connection error")));
    ws.addEventListener("close", (event) => {
      if (!settled) fail(new Error(`websocket closed before every batch arrived (code=${event.code})`));
    });

    ws.addEventListener("open", () => {
      void (async () => {
        try {
          await send("authenticate", { api_key: apiKey });
          await send(
            "subscribe",
            requests.map((r) => ({
              frequency: "1000ms",
              client_id: clientId(r.label),
              batch: [r.item],
              options: batchOptions(network),
            })),
          );
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    ws.addEventListener("message", (event) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(String(event.data)) as JsonRpcMessage;
      } catch (err) {
        fail(new Error(`wsAPI sent a non-JSON message frame: ${String(event.data)} (${String(err)})`));
        return;
      }

      const msgId = msg.id;
      const pendingEntry = typeof msgId === "number" ? pending.get(msgId) : undefined;
      if (pendingEntry && typeof msgId === "number") {
        const { resolve: resolveSend, reject: rejectSend } = pendingEntry;
        pending.delete(msgId);
        if (msg.error) {
          rejectSend(new Error(`wsAPI error (code ${msg.error.code}): ${msg.error.message}`));
        } else {
          resolveSend(msg.result);
        }
        return;
      }

      if (msg.method === "subscription" && Array.isArray(msg.params)) {
        for (const payload of msg.params as SuiWireResult[]) {
          const label = wanted.get(payload.client_id);
          if (label !== undefined) results.set(label, payload);
        }
        if (results.size === wanted.size && !settled) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve(Object.fromEntries(results));
        }
      }
    });
  });
}

/// Every requested label must have streamed for `fetchSuiFeeds` to resolve, so a
/// miss here is a wiring mistake rather than a timeout — say which one.
function take(got: Record<string, SuiWireResult>, label: string): SuiWireResult {
  const found = got[label];
  if (!found) throw new Error(`wsAPI returned no batch labelled ${label}`);
  return found;
}

/// The original pair: a spot index value batch and an SVI batch.
export async function fetchSuiBatches(
  apiKey: string,
  network: string,
  wsUrl: string = WSAPI_URL,
): Promise<{ value: SuiWireResult; svi: SuiWireResult }> {
  const got = await fetchSuiFeeds(
    apiKey,
    network,
    [
      {
        label: "value",
        item: {
          feed: "index.px",
          asset: SUBSCRIPTION.indexAsset,
          exchange: SUBSCRIPTION.indexExchange,
          base_asset: SUBSCRIPTION.baseAsset,
          quote_asset: SUBSCRIPTION.quoteAsset,
        },
      },
      {
        label: "svi",
        item: {
          feed: "model.params",
          asset: SUBSCRIPTION.modelAsset,
          exchange: SUBSCRIPTION.modelExchange,
          base_asset: SUBSCRIPTION.baseAsset,
          model: SUBSCRIPTION.model,
          expiry: SUBSCRIPTION.tenor,
        },
      },
    ],
    wsUrl,
  );
  return { value: take(got, "value"), svi: take(got, "svi") };
}

/// The two marks, both greek-free so each is a single number and rides a value
/// batch. A mark carrying greeks answers with several numbers per sid and has no
/// signable shape — `ValueUpdate` holds one `u128`.
export async function fetchMarkBatches(
  apiKey: string,
  network: string,
  wsUrl: string = WSAPI_URL,
): Promise<{ perpetual: SuiWireResult; future: SuiWireResult }> {
  const { perpetual, future } = MARK_SUBSCRIPTION;
  const got = await fetchSuiFeeds(
    apiKey,
    network,
    [
      {
        label: "perpetual",
        item: {
          feed: "mark.px",
          asset: perpetual.asset,
          exchange: perpetual.exchange,
          base_asset: perpetual.baseAsset,
          quote_asset: SUBSCRIPTION.quoteAsset,
        },
      },
      {
        label: "future",
        item: {
          feed: "mark.px",
          asset: future.asset,
          exchange: future.exchange,
          base_asset: future.baseAsset,
          quote_asset: SUBSCRIPTION.quoteAsset,
          expiry: future.expiry,
        },
      },
    ],
    wsUrl,
  );
  return { perpetual: take(got, "perpetual"), future: take(got, "future") };
}
