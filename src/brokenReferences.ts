import { readFile, readdir, stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { findSkillMdFilename } from "./skillMdFile.js";

/**
 * Which kinds of reference to look for. Three independent switches (matching the three
 * choices offered in the interactive "extra checks" prompt) rather than a single level,
 * because they differ in kind, not just in aggressiveness:
 *   links -- markdown [text](path), ![alt](path), and [id]: path definitions. Explicit
 *            syntax, so high precision.
 *   prose -- path-shaped mentions in prose, inline code, and shell code blocks. Heuristic by
 *            nature (prose can mention a path purely as an example), so reported as such.
 *   urls  -- http(s) markdown links. The only one that touches the network.
 */
export interface ReferenceCheckOptions {
  links: boolean;
  prose: boolean;
  urls: boolean;
}

export type ReferenceKind =
  | "markdown-link"
  | "markdown-image"
  | "markdown-definition"
  | "autolink"
  | "inline-code"
  | "prose-path"
  | "code-block-path"
  | "command-script";

export type BrokenReason =
  | "missing"
  | "case-mismatch"
  | "wrong-kind"
  | "escapes-skill"
  | "url-not-found"
  | "url-unreachable";

export interface BrokenReference {
  /** The skill directory this was found in -- one skill name can have several instances. */
  instance: string;
  /** Path of the file containing the reference, relative to `instance`. */
  file: string;
  line: number;
  /** The reference exactly as written (minus any #fragment/?query for local paths). */
  target: string;
  kind: ReferenceKind;
  reason: BrokenReason;
  /** True for kinds found by pattern-matching prose rather than explicit link syntax. */
  heuristic: boolean;
  /** Plain-language elaboration, e.g. the real on-disk spelling for a case mismatch. */
  detail?: string;
}

export interface ReferenceCheckResult {
  filesChecked: number;
  referencesChecked: number;
  broken: BrokenReference[];
}

export const NO_REFERENCE_CHECKS: ReferenceCheckOptions = { links: false, prose: false, urls: false };

export function anyReferenceCheck(options: ReferenceCheckOptions): boolean {
  return options.links || options.prose || options.urls;
}

type Category = "link" | "prose" | "url";
type Expect = "file" | "dir";

interface Candidate {
  raw: string;
  line: number;
  kind: ReferenceKind;
  category: Category;
  expect?: Expect;
}

const MAX_DESTINATION_CHARS = 512; // same ceiling SkillSpector uses for a markdown destination
// A single markdown line this long is a minified/data blob, not prose; skipping it keeps the
// worst case on hostile input linear instead of quadratic in the inline-code/link scans.
const MAX_LINE_CHARS = 20_000;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".svn", ".hg"]);
const MARKDOWN_EXT = /\.(md|markdown)$/i;

const SEG = "[A-Za-z0-9_.-]+";
const NAME_WITH_EXT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,12}";
// The extension must contain a letter so version/ratio-looking text ("1.5/2.0") never
// reads as a file, and a path needs a directory part or "./" so a bare "package.json" or
// "manage.py" -- which usually means the *user's* project, not the skill -- is never flagged.
const PATH_BODY = `(?:\\.{1,2}/(?:${SEG}/)*|(?:${SEG}/)+)${NAME_WITH_EXT}|\\./${NAME_WITH_EXT}`;
const PROSE_PATH = new RegExp(`(?<![\\w:/.@~$%\\\\-])(${PATH_BODY})(?![\\w/@-]|\\.\\w)`, "g");
const STRICT_PATH = new RegExp(`^(?:${PATH_BODY})$`);
const INTERPRETER = new RegExp(
  `(?:^|[\\s;&|(])(?:python[\\d.]*|py|node|deno|bun|bash|sh|zsh|fish|ruby|perl|php|pwsh|powershell|tsx|ts-node|source)` +
    `\\s+(?:-{1,2}[A-Za-z][\\w-]*(?:=\\S+)?\\s+)*(${PATH_BODY})(?![\\w/@-]|\\.\\w)`,
);

const FENCE_OPEN = /^[\s>]*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "fish", "console", "terminal", "shell-session", "sh-session", "powershell", "pwsh", "ps1"]);
const DEFINITION = /^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/gi;

// A path that is the *target* of a write, not a thing the skill expects to already exist.
const OUTPUT_CONTEXT = /(?:>>?|\s-[oO]|--(?:out|output|outfile|output-file|dest|destination|to|target|into)(?:[= ])|\btee(?:\s+-a)?|\bmkdir(?:\s+-p)?|\btouch|\bgit\s+clone\b[^\n]*)\s*$/;
const COPY_LIKE = /^\s*(?:\$\s+)?(?:sudo\s+)?(?:cp|mv|rsync|scp|install|ln)\b/;

const PLACEHOLDER_SEGMENT = /^(?:foo|bar|baz|qux|xxx+|yyy+|example|sample|your[-_].*|my[-_].*|name|dir|folder|directory|path|project|repo|user|username|skill[-_]name|file|filename)$/i;
const DOMAIN_TLD = /\.(?:com|org|net|io|dev|ai|app|co|gov|edu|me|xyz)$/i;
const PLACEHOLDER_HOST = /^(?:(?:.+\.)?example\.(?:com|org|net)|localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.(?:invalid|test|example|local|localhost))$/i;

/** Blanks out `code spans` (same length, so offsets stay valid) and returns their contents. */
function maskInlineCode(line: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  let masked = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      masked += line[i++];
      continue;
    }
    let runEnd = i;
    while (line[runEnd] === "`") runEnd++;
    const run = line.slice(i, runEnd);
    // The closer must be a backtick run of exactly the opener's length.
    let close = line.indexOf(run, runEnd);
    while (close !== -1 && (line[close + run.length] === "`" || line[close - 1] === "`")) {
      let skipTo = close;
      while (line[skipTo] === "`") skipTo++;
      close = line.indexOf(run, skipTo);
    }
    if (close === -1) {
      masked += run;
      i = runEnd;
      continue;
    }
    const closeEnd = close + run.length;
    spans.push(line.slice(runEnd, close));
    masked += " ".repeat(closeEnd - i);
    i = closeEnd;
  }
  return { masked, spans };
}

/** Applies all ranges in one pass -- masking per match would re-copy the whole line each time. */
function maskRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    out += text.slice(cursor, from) + " ".repeat(end - from);
    cursor = end;
  }
  return out + text.slice(cursor);
}

function parseDestination(s: string, from: number): { dest: string; end: number } | undefined {
  let pos = from;
  while (s[pos] === " " || s[pos] === "\t") pos++;
  let dest: string;
  if (s[pos] === "<") {
    const close = s.indexOf(">", pos);
    if (close === -1) return undefined;
    dest = s.slice(pos + 1, close);
    pos = close + 1;
  } else {
    const start = pos;
    let depth = 0;
    while (pos < s.length && s[pos] !== " " && s[pos] !== "\t" && s[pos] !== "\n") {
      if (pos - start > MAX_DESTINATION_CHARS || (s[pos] === "]" && s[pos + 1] === "(")) return undefined;
      if (s[pos] === "\\") {
        pos += 2;
        continue;
      }
      if (s[pos] === "(") depth++;
      else if (s[pos] === ")") {
        if (depth === 0) break;
        depth--;
      }
      pos++;
    }
    dest = s.slice(start, pos);
  }
  while (s[pos] === " " || s[pos] === "\t") pos++;
  const quote = s[pos];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    const close = s.indexOf(closer, pos + 1);
    if (close === -1) return undefined;
    pos = close + 1;
    while (s[pos] === " " || s[pos] === "\t") pos++;
  }
  if (s[pos] !== ")") return undefined;
  return { dest, end: pos + 1 };
}

/** Pairs every `]` with its `[` in one pass, so nested `[![alt](img)](url)` resolves right
 * and the cost stays linear however many brackets a hostile line contains. */
function pairBrackets(s: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "[") {
      stack.push(i);
    } else if (ch === "]" && stack.length > 0) {
      pairs.set(i, stack.pop()!);
    }
  }
  return pairs;
}

type Destination = { type: "local"; path: string } | { type: "url"; url: string };

function classifyDestination(rawInput: string): Destination | undefined {
  const raw = rawInput.trim();
  if (!raw || raw.startsWith("#")) return undefined;
  if (/^https?:\/\//i.test(raw)) {
    if (/[{}<>$]/.test(raw)) return undefined;
    const url = raw.replace(/#.*$/, "");
    try {
      if (PLACEHOLDER_HOST.test(new URL(url).hostname)) return undefined;
    } catch {
      return undefined;
    }
    return { type: "url", url };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return undefined; // mailto:, data:, C:\..., etc.
  if (/^[/\\~]/.test(raw)) return undefined; // absolute/home paths aren't skill-relative
  if (/[{}<>$*|]|\.\.\./.test(raw) || /(?:^|\/)path\/to(?:\/|$)/.test(raw)) return undefined; // template/glob/placeholder
  const cut = raw.search(/[?#]/);
  const pathPart = cut >= 0 ? raw.slice(0, cut) : raw;
  if (!pathPart) return undefined;
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // malformed escape -- use as written
  }
  return { type: "local", path: decoded.replace(/\\/g, "/") };
}

function expectationFor(path: string, image: boolean): Expect | undefined {
  if (path.endsWith("/")) return "dir";
  if (image) return "file";
  return /\.[A-Za-z0-9]{1,12}$/.test(posix.basename(path)) && posix.basename(path) !== ".." ? "file" : undefined;
}

function looksLikePlaceholder(path: string): boolean {
  const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1];
  const stem = last.replace(/\.[^.]*$/, "");
  return segments.slice(0, -1).some((s) => PLACEHOLDER_SEGMENT.test(s)) || PLACEHOLDER_SEGMENT.test(stem);
}

function acceptProsePath(path: string): boolean {
  const first = path.split("/").find((s) => s && s !== "." && s !== "..");
  if (first && DOMAIN_TLD.test(first)) return false;
  return !looksLikePlaceholder(path);
}

function pushLinkDestination(out: Candidate[], raw: string, line: number, kind: ReferenceKind, image: boolean): void {
  const dest = classifyDestination(raw);
  if (!dest) return;
  if (dest.type === "url") out.push({ raw: dest.url, line, kind, category: "url" });
  else out.push({ raw: dest.path, line, kind, category: "link", expect: expectationFor(dest.path, image) });
}

function extractFromProseLine(line: string, lineNo: number, out: Candidate[]): void {
  const { masked: noCode, spans } = maskInlineCode(line);
  const consumed: Array<[number, number]> = [];

  const definition = DEFINITION.exec(noCode);
  if (definition) {
    pushLinkDestination(out, definition[1].replace(/^<|>$/g, ""), lineNo, "markdown-definition", false);
    consumed.push([0, definition[0].length]);
  }

  const bracketPairs = noCode.includes("](") ? pairBrackets(noCode) : undefined;
  for (let i = noCode.indexOf("]("); i !== -1; i = noCode.indexOf("](", i + 1)) {
    const parsed = parseDestination(noCode, i + 2);
    const open = bracketPairs?.get(i);
    if (!parsed || open === undefined) continue;
    const image = noCode[open - 1] === "!";
    pushLinkDestination(out, parsed.dest, lineNo, image ? "markdown-image" : "markdown-link", image);
    consumed.push([image ? open - 1 : open, parsed.end]);
  }

  for (const m of noCode.matchAll(AUTOLINK)) {
    pushLinkDestination(out, m[1], lineNo, "autolink", false);
    consumed.push([m.index!, m.index! + m[0].length]);
  }
  const rest = maskRanges(noCode, consumed);

  for (const span of spans) {
    const content = span.trim();
    const command = INTERPRETER.exec(content);
    if (command) {
      if (acceptProsePath(command[1])) out.push({ raw: command[1], line: lineNo, kind: "command-script", category: "prose", expect: "file" });
      continue;
    }
    const first = content.split(/\s+/)[0];
    if (STRICT_PATH.test(first) && acceptProsePath(first)) {
      out.push({ raw: first, line: lineNo, kind: "inline-code", category: "prose", expect: "file" });
    }
  }

  for (const m of rest.matchAll(PROSE_PATH)) {
    if (!acceptProsePath(m[1])) continue;
    out.push({ raw: m[1], line: lineNo, kind: "prose-path", category: "prose", expect: "file" });
  }
}

function extractFromShellFenceLine(rawLine: string, lineNo: number, out: Candidate[]): void {
  const line = rawLine.replace(/^[\s>]*(?:\$\s+)?/, "");
  const seen = new Set<string>();
  const command = INTERPRETER.exec(line);
  if (command && acceptProsePath(command[1]) && !OUTPUT_CONTEXT.test(line.slice(0, command.index + command[0].indexOf(command[1])))) {
    seen.add(command[1]);
    out.push({ raw: command[1], line: lineNo, kind: "command-script", category: "prose", expect: "file" });
  }

  const lastToken = line.trimEnd().split(/\s+/).pop();
  for (const m of line.matchAll(PROSE_PATH)) {
    const path = m[1];
    if (seen.has(path) || !acceptProsePath(path)) continue;
    if (OUTPUT_CONTEXT.test(line.slice(0, m.index))) continue;
    if (COPY_LIKE.test(line) && lastToken === path) continue;
    out.push({ raw: path, line: lineNo, kind: "code-block-path", category: "prose", expect: "file" });
  }
}

/** Pure text -> candidate references; no filesystem or network. Exported for testability. */
export function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence: { char: string; length: number; lang: string } | undefined;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (fence) {
      const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = undefined;
        return;
      }
      if (SHELL_LANGS.has(fence.lang) && line.length <= MAX_LINE_CHARS) extractFromShellFenceLine(line, lineNo, out);
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length, lang: open[2].toLowerCase() };
      return;
    }
    if (line.length <= MAX_LINE_CHARS) extractFromProseLine(line, lineNo, out);
  });
  return out;
}

const dirCache = new Map<string, string[] | undefined>();

async function listDir(path: string): Promise<string[] | undefined> {
  if (dirCache.has(path)) return dirCache.get(path);
  let names: string[] | undefined;
  try {
    names = await readdir(path);
  } catch {
    names = undefined;
  }
  dirCache.set(path, names);
  return names;
}

interface Lookup {
  status: "exact" | "case" | "missing";
  actualRel?: string;
  isDir?: boolean;
}

/**
 * Case-tolerant existence check, one path segment at a time against the real directory
 * listing. Same reasoning as skillMdFile.ts: on a case-sensitive filesystem an exact stat
 * of "references/Foo.md" fails when the file is "references/foo.md", but that's a different
 * problem (wrong capitalization, trivially fixable, breaks only on some systems) from a
 * file that doesn't exist at all, so it's told apart rather than lumped in as "missing".
 */
async function lookup(skillDir: string, relPath: string): Promise<Lookup> {
  const segments = relPath.split("/").filter((s) => s && s !== ".");
  let current = skillDir;
  const actual: string[] = [];
  let caseDiffers = false;
  for (const seg of segments) {
    const names = await listDir(current);
    if (!names) return { status: "missing" };
    let name = names.includes(seg) ? seg : undefined;
    if (!name) {
      const ci = names.filter((n) => n.toLowerCase() === seg.toLowerCase()).sort();
      if (ci.length === 0) return { status: "missing" };
      name = ci[0];
      caseDiffers = true;
    }
    actual.push(name);
    current = join(current, name);
  }
  try {
    const st = await stat(current);
    return { status: caseDiffers ? "case" : "exact", actualRel: actual.join("/"), isDir: st.isDirectory() };
  } catch {
    return { status: "missing" };
  }
}

interface Verdict {
  reason: BrokenReason;
  detail?: string;
}

async function checkLocal(skillDir: string, sourceRel: string, c: Candidate): Promise<Verdict | undefined> {
  const written = c.raw.replace(/\\/g, "/");
  const sourceDir = posix.dirname(sourceRel);
  // Markdown links resolve against the file that contains them (what every renderer does).
  // A prose mention like "see references/foo.md" is, in practice, almost always written from
  // the skill root's point of view -- an agent reads it relative to the skill, not to the
  // nested file it appears in -- so prose candidates also get tried from the skill root.
  const bases = c.category === "prose" && !written.startsWith("../") && sourceDir !== "." ? [sourceDir, "."] : [sourceDir];

  let best: Verdict | undefined;
  const rank: Record<string, number> = { "wrong-kind": 3, "case-mismatch": 2, "escapes-skill": 1, missing: 0 };
  const consider = (v: Verdict): void => {
    if (!best || rank[v.reason] > rank[best.reason]) best = v;
  };

  for (const base of bases) {
    const joined = posix.normalize(posix.join(base, written)).replace(/\/$/, "") || ".";
    if (joined === ".." || joined.startsWith("../")) {
      let exists = false;
      try {
        await stat(resolve(skillDir, joined));
        exists = true;
      } catch {
        // doesn't exist either
      }
      consider({
        reason: "escapes-skill",
        detail: `resolves outside the skill folder${exists ? " (the target exists on this machine, but won't travel with the skill)" : " and doesn't exist there either"}`,
      });
      continue;
    }

    const found = await lookup(skillDir, joined);
    if (found.status === "missing") {
      const hint =
        c.category === "link" && base !== "." && (await lookup(skillDir, posix.normalize(written))).status === "exact"
          ? `exists relative to the skill root (${posix.normalize(written)}), but links resolve relative to the file that contains them (${sourceRel})`
          : undefined;
      consider({ reason: "missing", detail: hint });
      continue;
    }

    const wantsDir = c.expect === "dir";
    const wantsFile = c.expect === "file";
    const kindDetail =
      wantsDir && !found.isDir
        ? `ends in "/" but is a file`
        : wantsFile && found.isDir
          ? "is a directory, not a file"
          : undefined;
    const caseDetail = found.status === "case" ? `actual ${found.isDir ? "directory" : "file"} is ${found.actualRel}` : undefined;

    if (kindDetail) {
      consider({ reason: "wrong-kind", detail: [kindDetail, caseDetail].filter(Boolean).join("; ") });
      continue;
    }
    if (caseDetail) {
      consider({ reason: "case-mismatch", detail: caseDetail });
      continue;
    }
    return undefined; // resolves cleanly from at least one base
  }
  return best;
}

type UrlOutcome = Verdict | undefined;
const urlCache = new Map<string, Promise<UrlOutcome>>();

async function probe(url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: controller.signal, headers: { "user-agent": "skillfn-reference-check" } });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HEAD first (cheap), GET as a fallback since plenty of servers mishandle HEAD. Only a
 * definitive "gone" (404/410) counts as a dead link; 401/403/429 mean the resource is
 * there but gated or we're being throttled, so those are inconclusive, not broken. Cached
 * per process so the same URL cited by many skills is only requested once.
 */
function checkUrl(url: string, timeoutMs = 8000): Promise<UrlOutcome> {
  const cached = urlCache.get(url);
  if (cached) return cached;
  const pending = (async (): Promise<UrlOutcome> => {
    try {
      let status = await probe(url, "HEAD", timeoutMs);
      if (status >= 400) status = await probe(url, "GET", timeoutMs);
      if (status < 400 || status === 401 || status === 403 || status === 429 || status === 999) return undefined;
      if (status === 404 || status === 410) return { reason: "url-not-found", detail: `HTTP ${status}` };
      return { reason: "url-unreachable", detail: `HTTP ${status}` };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const cause = err instanceof Error ? ((err.cause as { code?: string } | undefined)?.code ?? err.message) : String(err);
      return { reason: "url-unreachable", detail: aborted ? `timed out after ${timeoutMs / 1000}s` : cause };
    }
  })();
  urlCache.set(url, pending);
  return pending;
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

async function listMarkdownFiles(skillDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(skillDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(e.name)) await walk(childRel);
      } else if (e.isFile() && MARKDOWN_EXT.test(e.name)) {
        found.push(childRel);
      }
    }
  }
  await walk("");
  const manifest = await findSkillMdFilename(skillDir);
  return found.sort((a, b) => (a === manifest ? -1 : b === manifest ? 1 : a.localeCompare(b)));
}

const HEURISTIC_KINDS: ReadonlySet<ReferenceKind> = new Set(["inline-code", "prose-path", "code-block-path", "command-script"]);

/**
 * Static check of one skill directory: every enabled reference found in its SKILL.md and
 * other markdown files is resolved against the filesystem (and, only if `urls` is on, the
 * network). Read-only and side-effect free apart from those lookups; never throws on an
 * unreadable file -- that file is just skipped.
 */
export async function checkSkillReferences(skillDir: string, options: ReferenceCheckOptions): Promise<ReferenceCheckResult> {
  const result: ReferenceCheckResult = { filesChecked: 0, referencesChecked: 0, broken: [] };
  if (!anyReferenceCheck(options)) return result;

  const enabled: Record<Category, boolean> = { link: options.links, prose: options.prose, url: options.urls };
  const urlWork: Array<{ file: string; c: Candidate }> = [];
  const broken: BrokenReference[] = [];
  const files = await listMarkdownFiles(skillDir);

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(skillDir, file), "utf8");
    } catch {
      continue;
    }
    result.filesChecked++;

    for (const c of extractCandidates(text)) {
      if (!enabled[c.category]) continue;
      result.referencesChecked++;
      if (c.category === "url") {
        urlWork.push({ file, c });
        continue;
      }
      const verdict = await checkLocal(skillDir, file, c);
      if (verdict) {
        broken.push({ instance: skillDir, file, line: c.line, target: c.raw, kind: c.kind, heuristic: HEURISTIC_KINDS.has(c.kind), ...verdict });
      }
    }
  }

  await runPool(urlWork, 6, async ({ file, c }) => {
    const verdict = await checkUrl(c.raw);
    if (verdict) {
      broken.push({ instance: skillDir, file, line: c.line, target: c.raw, kind: c.kind, heuristic: false, ...verdict });
    }
  });

  // URL results land in completion order; sort (manifest first, then by line) so output is
  // deterministic run to run and reads in the order a person would open the files.
  const fileOrder = new Map(files.map((f, i) => [f, i]));
  result.broken = broken.sort((a, b) => fileOrder.get(a.file)! - fileOrder.get(b.file)! || a.line - b.line || a.target.localeCompare(b.target));
  return result;
}
