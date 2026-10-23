import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

export const OUT_DIR = ".alg";

export function historyPath(baseDir) {
  return join(baseDir, OUT_DIR, "history.jsonl");
}

export function readHistory(baseDir, target) {
  const path = historyPath(baseDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!target) return lines;
  return lines.filter((l) => sameTarget(l.target, target));
}

export function appendHistory(baseDir, line) {
  const path = historyPath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n");
  return path;
}

export function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.url && b.url) return hostOf(a.url) === hostOf(b.url);
  return a.dir && b.dir && a.dir === b.dir;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function runDir(baseDir, target, runId) {
  const key = target.url ? hostOf(target.url) : "local";
  return join(baseDir, OUT_DIR, key, runId);
}
