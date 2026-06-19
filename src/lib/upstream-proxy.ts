import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const agentCache = new Map<string, Dispatcher>();
let roundRobinCursor = 0;

export type UpstreamProxyEntry = {
  id: string;
  index: number;
  source: "UPSTREAM_PROXY_LIST" | "UPI_PROXY_LIST" | "UPSTREAM_PROXY";
  url: string;
  redactedUrl: string;
  scheme: string;
  host: string;
  port: string;
};

function splitProxyList(value: string) {
  return value
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProxyUrl(rawUrl: string, index: number, source: UpstreamProxyEntry["source"]): UpstreamProxyEntry | null {
  const value = rawUrl.trim();
  if (!value) return null;
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `socks5://${value}`;

  try {
    const url = new URL(normalized);
    return {
      id: String(index),
      index,
      source,
      url: normalized,
      redactedUrl: redactProxyUrl(normalized),
      scheme: url.protocol.replace(/:$/, ""),
      host: url.hostname,
      port: url.port,
    };
  } catch {
    return null;
  }
}

export function redactProxyUrl(rawUrl: string) {
  if (!rawUrl) return "DIRECT";
  try {
    const url = new URL(rawUrl);
    const username = url.username ? decodeURIComponent(url.username) : "";
    const auth = username ? `${username}${url.password ? ":<PASSWORD_REDACTED>" : ""}@` : "";
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return `${url.protocol}//${auth}${url.host}${path}${url.search}${url.hash}`;
  } catch {
    return rawUrl.replace(/(:\/\/[^:@/]+):([^@/]+)@/, "$1:<PASSWORD_REDACTED>@");
  }
}

export function describeUpstreamProxy(rawUrl?: string) {
  return rawUrl ? redactProxyUrl(rawUrl) : "DIRECT";
}

export function getConfiguredUpstreamProxies(): UpstreamProxyEntry[] {
  const pairs: Array<[UpstreamProxyEntry["source"], string]> = [
    ["UPSTREAM_PROXY_LIST", process.env.UPSTREAM_PROXY_LIST || ""],
    ["UPI_PROXY_LIST", process.env.UPI_PROXY_LIST || ""],
    ["UPSTREAM_PROXY", process.env.UPSTREAM_PROXY || ""],
  ];

  const seen = new Set<string>();
  const entries: UpstreamProxyEntry[] = [];
  for (const [source, value] of pairs) {
    for (const proxy of splitProxyList(value)) {
      if (seen.has(proxy)) continue;
      seen.add(proxy);
      const parsed = parseProxyUrl(proxy, entries.length, source);
      if (parsed) entries.push(parsed);
    }
  }
  return entries;
}

export async function getUpstreamProxyPlan() {
  const proxies = getConfiguredUpstreamProxies();
  if (proxies.length === 0) return [] as UpstreamProxyEntry[];

  const start = roundRobinCursor % proxies.length;
  roundRobinCursor = (roundRobinCursor + 1) % Math.max(proxies.length, 1);
  return [...proxies.slice(start), ...proxies.slice(0, start)];
}

function proxyAgent(proxyUrl: string) {
  if (!agentCache.has(proxyUrl)) {
    const protocol = (() => {
      try {
        return new URL(proxyUrl).protocol.toLowerCase();
      } catch {
        return "";
      }
    })();
    agentCache.set(proxyUrl, protocol === "socks5:" || protocol === "socks:" ? new Socks5ProxyAgent(proxyUrl) : new ProxyAgent(proxyUrl));
  }
  return agentCache.get(proxyUrl);
}

export async function fetchWithUpstreamProxy(url: string, init: RequestInit = {}, proxyUrl = "") {
  const dispatcher = proxyUrl ? proxyAgent(proxyUrl) : undefined;
  if (!dispatcher) return fetch(url, init);
  return undiciFetch(url, {
    ...init,
    dispatcher,
  } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
