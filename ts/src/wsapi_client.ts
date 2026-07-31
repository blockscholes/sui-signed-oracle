// Minimal websocket client for the Block Scholes wsAPI staging deployment: authenticate,
// subscribe to one SUI-signed value batch and one SUI-signed SVI batch as a "Deepbook"
// client, and resolve as soon as both have streamed their first signed payload. Uses
// Node's native WebSocket (stable since Node 22) — no new dependency needed.
//
// Auth is message-based (`{"method":"authenticate"}`), not header-based: the native
// WebSocket API (unlike Node's `ws` package) has no way to set request headers on the
// handshake, matching the browser spec.

import type { WireBatchData } from "./wire_convert.js";

const DEFAULT_WSAPI_URL = "wss://staging-websocket-api.blockscholes.com/";

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
/// and re-subscribing under one reuses that. A `30d` tenor resolves to a different
/// absolute expiry each time, so a reused id is rejected as contradicting itself.
const RUN_ID = Math.random().toString(36).slice(2, 10);
const SVI_CLIENT_ID = `sui-e2e-svi-${RUN_ID}`;
const VALUE_CLIENT_ID = `sui-e2e-value-${RUN_ID}`;

/// The identity fields these subscriptions carry. Exported because the e2e derives
/// the same two sids on-chain to compare against the ones BS derives — one
/// definition, so the request and the check cannot describe different series.
///
/// `index.px` takes `blockscholes` or `binance`, not `composite`; the defaults that
/// exist off-chain are spelled out here because an on-chain caller cannot resolve
/// them.
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
  tenor: "21d",
  tenorMs: 1_814_400_000n,
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

/// Fetch one signed SUI value batch (spot index) and one signed SVI batch (30d
/// composite BTC smile) from wsAPI staging, gated on the given API key.
///
/// Neither request carries a `sid`: BS derives one from the identity fields, which
/// is the value the on-chain derivation is checked against. Every defaulted field
/// is spelled out for the same reason — an unstated default is one the consumer
/// would have to guess to reproduce the id.
export async function fetchSuiBatches(
  apiKey: string,
  network: string,
  wsUrl: string = DEFAULT_WSAPI_URL,
): Promise<{ value: SuiWireResult; svi: SuiWireResult }> {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const results = new Map<string, SuiWireResult>();
  let settled = false;

  function send(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  return new Promise<{ value: SuiWireResult; svi: SuiWireResult }>((resolve, reject) => {
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(err);
    };

    const timeout = setTimeout(() => fail(new Error("timed out waiting for wsAPI to stream both SUI batches")), 60_000);

    ws.addEventListener("error", () => fail(new Error("websocket connection error")));
    ws.addEventListener("close", (event) => {
      if (!settled) fail(new Error(`websocket closed before both batches arrived (code=${event.code})`));
    });

    ws.addEventListener("open", () => {
      void (async () => {
        try {
          await send("authenticate", { api_key: apiKey });

          await send("subscribe", [
            {
              frequency: "1000ms",
              client_id: VALUE_CLIENT_ID,
              batch: [
                {
                  feed: "index.px",
                  asset: SUBSCRIPTION.indexAsset,
                  exchange: SUBSCRIPTION.indexExchange,
                  base_asset: SUBSCRIPTION.baseAsset,
                  quote_asset: SUBSCRIPTION.quoteAsset,
                },
              ],
              options: batchOptions(network),
            },
            {
              frequency: "1000ms",
              client_id: SVI_CLIENT_ID,
              batch: [
                {
                  feed: "model.params",
                  asset: SUBSCRIPTION.modelAsset,
                  exchange: SUBSCRIPTION.modelExchange,
                  base_asset: SUBSCRIPTION.baseAsset,
                  model: SUBSCRIPTION.model,
                  expiry: SUBSCRIPTION.tenor,
                },
              ],
              options: batchOptions(network),
            },
          ]);
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
        const { resolve, reject } = pendingEntry;
        pending.delete(msgId);
        if (msg.error) {
          reject(new Error(`wsAPI error (code ${msg.error.code}): ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
        return;
      }

      if (msg.method === "subscription" && Array.isArray(msg.params)) {
        for (const payload of msg.params as SuiWireResult[]) {
          if (payload.client_id === VALUE_CLIENT_ID || payload.client_id === SVI_CLIENT_ID) {
            results.set(payload.client_id, payload);
          }
        }
        const value = results.get(VALUE_CLIENT_ID);
        const svi = results.get(SVI_CLIENT_ID);
        if (value && svi && !settled) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ value, svi });
        }
      }
    });
  });
}
