import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface RipgrepCountMatchesOptions {
  cwd: string;
  term: string;
  globs: string[];
  caseSensitive: boolean;
  timeoutMs: number;
  paths: string[];
  maxMatchesPerFile?: number;
  onMatch: (match: { filePath: string; count: number }) => void;
}

export interface RipgrepCountMatchesResult {
  timedOut: boolean;
}

const DEFAULT_MAX_PATH_CHARS = 80_000;

export async function rgCountMatches(
  options: RipgrepCountMatchesOptions,
): Promise<RipgrepCountMatchesResult> {
  const paths = options.paths.length ? options.paths : ["."];
  const chunks = chunkPaths(paths, DEFAULT_MAX_PATH_CHARS);
  const deadline = Date.now() + options.timeoutMs;

  let timedOut = false;
  for (const chunk of chunks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }

    const { timedOut: chunkTimedOut } = await rgCountMatchesChunk({
      ...options,
      timeoutMs: remaining,
      paths: chunk,
    });
    if (chunkTimedOut) {
      timedOut = true;
      break;
    }
  }

  return { timedOut };
}

async function rgCountMatchesChunk(
  options: RipgrepCountMatchesOptions,
): Promise<RipgrepCountMatchesResult> {
  const args = [
    "--count-matches",
    "--color",
    "never",
    "--no-messages",
    "--fixed-strings",
  ];
  if (!options.caseSensitive) {
    args.push("--ignore-case");
  }
  if (options.maxMatchesPerFile !== undefined) {
    args.push("--max-count", String(options.maxMatchesPerFile));
  }
  args.push("--regexp", options.term);
  for (const glob of options.globs) {
    args.push("--glob", glob);
  }
  args.push("--");
  args.push(...options.paths);

  const proc = await spawnChecked("rg", args, options.cwd);

  const stderr: string[] = [];
  let stderrBytes = 0;
  proc.stderr.on("data", (chunk) => {
    if (stderrBytes > 8192) return;
    const text = chunk.toString();
    stderrBytes += text.length;
    stderr.push(text);
  });

  const rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Infinity,
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    rl.close();
  }, options.timeoutMs);

  try {
    for await (const line of rl) {
      const parsed = parseCountLine(String(line).trim());
      if (!parsed) continue;
      options.onMatch(parsed);
    }
  } finally {
    clearTimeout(timeout);
    rl.close();
  }

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });

  if (!timedOut && exit.code && exit.code > 1) {
    throw new Error(`rg failed (${exit.code}): ${stderr.join("").trim()}`);
  }

  // Exit code 1 means "no matches", which isn't an error here.
  return { timedOut };
}

function parseCountLine(
  line: string,
): { filePath: string; count: number } | null {
  if (!line) return null;
  const match = line.match(/^(.*):(\d+)$/);
  if (!match) return null;
  const filePath = match[1]?.trim();
  const count = Number(match[2]);
  if (!filePath || !Number.isFinite(count)) return null;
  return { filePath, count };
}

function chunkPaths(paths: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const raw of paths) {
    const item = raw.trim();
    if (!item) continue;
    const itemChars = item.length + 1;
    if (current.length > 0 && currentChars + itemChars > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [["."]];
}

function spawnChecked(
  command: string,
  args: string[],
  cwd: string,
): Promise<ChildProcessWithoutNullStreams> {
  const proc = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin.end();

  return new Promise((resolve, reject) => {
    proc.once("spawn", () => resolve(proc));
    proc.once("error", (error) => reject(error));
  });
}
