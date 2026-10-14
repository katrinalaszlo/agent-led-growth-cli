// A recorded URL or body is shown as-is when it does not parse: these render
// evidence, and an unparseable value is still the evidence.
export function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url || "";
  }
}

export function pretty(body, max = Infinity) {
  if (!body) return "";
  let out;
  try {
    out = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    out = String(body);
  }
  return out.length > max ? out.slice(0, max) + "\n…" : out;
}
