import { readFileSync } from "node:fs";

// One fetch helper for every probe: bounded time and size, honest UA, never follows to a different host silently, never submits forms.
// Read once from package.json so the UA, the smoke browser and the served OpenAPI document never disagree with the release.
export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const USER_AGENT = `agent-led-growth/${VERSION} (+https://github.com/katrinalaszlo/agent-led-growth-cli)`;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const bareHost = (hostname) => hostname.toLowerCase().replace(/^www\./, "");

export async function get(url, { method = "GET", timeoutMs = 10000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: controller.signal, headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers } });
    let text = "";
    if (method !== "HEAD" && method !== "OPTIONS" && res.body) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of res.body) {
        bytes += chunk.length;
        // Leaving the loop cancels the body stream, which closes the connection; no abort needed.
        if (bytes > MAX_BODY_BYTES) {
          return { ok: false, status: res.status, url: res.url, contentType: res.headers.get("content-type") || "", headers: {}, text: "", error: `response body larger than ${MAX_BODY_BYTES} bytes` };
        }
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    const out = { ok: true, status: res.status, url: res.url, contentType: res.headers.get("content-type") || "", headers: Object.fromEntries(res.headers.entries()), text };
    // fetch follows redirects on its own; a hop to another host (www. aside) is marked so no caller mistakes it for the requested site.
    if (res.url && bareHost(new URL(res.url).hostname) !== bareHost(new URL(url).hostname)) {
      out.redirectedTo = res.url;
      out.crossHost = true;
    }
    return out;
  } catch (err) {
    return { ok: false, status: 0, url, contentType: "", headers: {}, text: "", error: err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}` };
  } finally {
    clearTimeout(timer);
  }
}

export function isHtml(res) {
  return /text\/html/i.test(res.contentType) || /^\s*<!doctype html|^\s*<html/i.test(res.text.slice(0, 200));
}

// null means "not JSON"; callers turn that into their own finding (e.g. pricing_json: "is not valid JSON").
export function parseJson(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

export function joinUrl(base, path) {
  return new URL(path, base).toString();
}

export function excerpt(text, n = 200) {
  return String(text).replace(/\s+/g, " ").slice(0, n);
}
