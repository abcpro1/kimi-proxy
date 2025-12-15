import { existsSync } from "node:fs";
import path from "node:path";
import { rgCountMatches } from "./blobSearch/ripgrep.js";

export type LogSearchBlobKind =
  | "request"
  | "response"
  | "provider-request"
  | "provider-response";

export interface LogBlobSearchOptions {
  blobRoot: string;
  query: string;
  kinds?: LogSearchBlobKind[];
  limit?: number;
  caseSensitive?: boolean;
  timeoutMs?: number;
}

export interface LogBlobSearchResult {
  engine: "rg";
  requestIds: string[];
  truncated: boolean;
}

const DEFAULT_KINDS: LogSearchBlobKind[] = [
  "request",
  "response",
  "provider-request",
  "provider-response",
];

const KIND_GLOBS: Record<LogSearchBlobKind, string> = {
  request: "**/request.json",
  response: "**/response.json",
  "provider-request": "**/provider-request.json",
  "provider-response": "**/provider-response.json",
};

export async function searchLogBlobs(
  options: LogBlobSearchOptions,
): Promise<LogBlobSearchResult> {
  const blobRoot = options.blobRoot;
  if (!existsSync(blobRoot)) {
    return { engine: "rg", requestIds: [], truncated: false };
  }

  const limit = Math.max(1, Math.min(5000, options.limit ?? 200));
  const timeoutMs = Math.max(250, Math.min(120000, options.timeoutMs ?? 10000));
  const caseSensitive = options.caseSensitive ?? false;
  const kinds = normalizeKinds(options.kinds);
  const terms = extractNonFieldTerms(options.query);
  if (!terms.length) {
    return { engine: "rg", requestIds: [], truncated: false };
  }

  const uniqueTerms = dedupeTerms(terms, caseSensitive).sort(
    (a, b) => b.length - a.length,
  );

  const globs = kinds.map((kind) => KIND_GLOBS[kind]);
  const deadline = Date.now() + timeoutMs;
  let truncated = false;

  type Candidate = { dir: string; score: number };
  let candidates = new Map<string, Candidate>();

  for (let index = 0; index < uniqueTerms.length; index += 1) {
    const term = uniqueTerms[index]!;
    const remainingTerms = uniqueTerms.length - index;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { engine: "rg", requestIds: [], truncated: true };
    }

    const termTimeoutMs = Math.max(1, Math.floor(remainingMs / remainingTerms));
    const termCandidates = new Map<string, Candidate>();
    const candidateDirs =
      index === 0 ? ["."] : Array.from(candidates.values(), (c) => c.dir);

    const { timedOut } = await rgCountMatches({
      cwd: blobRoot,
      term,
      globs,
      caseSensitive,
      timeoutMs: termTimeoutMs,
      maxMatchesPerFile: 250,
      paths: candidateDirs,
      onMatch: ({ filePath, count }) => {
        const requestDir = path.dirname(filePath);
        const requestId = path.basename(requestDir);
        if (!requestId) return;

        if (index > 0) {
          const prev = candidates.get(requestId);
          if (!prev) return;
          const next = termCandidates.get(requestId) ?? {
            dir: prev.dir,
            score: prev.score,
          };
          next.score += count;
          termCandidates.set(requestId, next);
          return;
        }

        const next = termCandidates.get(requestId) ?? {
          dir: requestDir,
          score: 0,
        };
        next.score += count;
        termCandidates.set(requestId, next);
      },
    });

    if (timedOut) truncated = true;

    candidates = termCandidates;
    if (!candidates.size) {
      return { engine: "rg", requestIds: [], truncated };
    }
  }

  const ranked = Array.from(candidates.entries())
    .sort((a, b) => {
      const scoreDiff = b[1].score - a[1].score;
      if (scoreDiff !== 0) return scoreDiff;
      return a[0].localeCompare(b[0]);
    })
    .map(([requestId]) => requestId);

  if (ranked.length > limit) {
    truncated = true;
  }

  return { engine: "rg", requestIds: ranked.slice(0, limit), truncated };
}

function normalizeKinds(kinds?: LogSearchBlobKind[]): LogSearchBlobKind[] {
  const normalized = kinds?.length ? kinds : DEFAULT_KINDS;
  const allowed = new Set(DEFAULT_KINDS);
  const deduped = Array.from(new Set(normalized)).filter((kind) =>
    allowed.has(kind),
  );
  return deduped.length ? deduped : DEFAULT_KINDS;
}

function extractNonFieldTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const terms: string[] = [];
  for (const token of tokens) {
    const clean = token.replace(/^"(.*)"$/, "$1").trim();
    if (!clean) continue;
    if (/^(and|or|not)$/i.test(clean)) continue;
    if (/^\w+:.+/.test(clean)) continue;
    terms.push(clean);
  }
  return terms;
}

function dedupeTerms(terms: string[], caseSensitive: boolean): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const normalized = caseSensitive ? term : term.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(term);
  }
  return unique;
}
