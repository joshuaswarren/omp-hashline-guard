// Pure logic for omp-hashline-guard. No I/O: index.js owns files and events.

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

/** A hashline section header: a whole line `[path#TAG]` (tag optional). */
const HEADER_RE = /^\[(.+?)(?:#([0-9A-Fa-f]{4}))?\]\s*$/;

/** A numbered display row from read/search/edit output: `12:text` or `*12:text`. */
const ROW_RE = /^[ *]?(\d+):(.*)$/;

/** Line numbers an op anchors: `PUT 4.=9:`, `CUT 4`, `PUT <4:`, `PUT >4*:`. */
const OP_RE = /^(PUT|CUT)\s+[<>]?(\d+)(?:\.=(\d+))?/;

/** Body text that is hashline or patch syntax, not file content. */
const OP_TEXT_RE =
	/^\s*\+?\s*(?:(?:PUT|CUT)\s+[<>]?\d+\s*(?:\.=|\*|:|\.|\+|$)|(?:REM|MV)(?:\s|$)|\*\*\* (?:Begin|End|Update File|Add File) |\[[^\]\s]+#[0-9A-F]{4}\]\s*$)/;

/** Batch files use `REM` for comments. */
const REM_COMMENT_EXT = /\.(bat|cmd|bas)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const NATIVE_PARSE_RE = /introduced a syntax error near line (\d+)|no longer parses after this edit/;
const NATIVE_LITERAL_OP_RE = /body row `(.*?)` is itself a valid hunk header/;
const STALE_RE = /file changed between read and edit/;

/** Python statements that open a block, and YAML keys with no inline value. */
const BLOCK_OPENER = [
	[/\.pyi?$/i, /^\s*(?:async\s+def|def|class|if|elif|else|for|while|with|try|except|finally|match|case)\b.*:$/],
	[/\.ya?ml$/i, /^\s*[^\s#][^:#]*:$/],
];

/** Past this edit distance the line diff gives up and reports one whole-file hunk. */
const MAX_DIFF_DISTANCE = 1000;

/**
 * The four-hex hashline tag omp mints for `text`: xxHash32 (seed 0) of the
 * BOM-stripped, LF-normalized text with trailing spaces, tabs and CRs stripped
 * from every line, low 16 bits. Mirrors `file_hash` and the read
 * normalization in omp's pi-edit crate (store.rs).
 */
export function fileTag(text) {
	const stripped = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t\r]+$/, ""))
		.join("\n");

	return (Bun.hash.xxHash32(stripped, 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/** Absolute path for an authored header path, or undefined for internal URLs. */
export function resolvePath(raw, cwd, home = homedir()) {
	const path = unquote(raw.trim());

	if (path.includes("://")) return undefined;

	if (path === "~" || path.startsWith("~/")) return normalize(join(home, path.slice(1)));

	return normalize(isAbsolute(path) ? path : join(cwd, path));
}

function unquote(path) {
	const first = path[0];

	return path.length > 1 && (first === '"' || first === "'") && path.at(-1) === first ? path.slice(1, -1) : path;
}

/**
 * Parse a hashline edit input into its file sections. Each section keeps its
 * ops (`{ kind, start, end, range, body }`), every anchored line number, and
 * the concatenated body rows.
 */
export function parseSections(input) {
	const sections = [];
	const lines = input.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, "");
		const header = HEADER_RE.exec(line);

		if (header) {
			sections.push({ line: i, rawPath: header[1], tag: header[2]?.toUpperCase(), ops: [], anchors: [], body: [], fileOp: false });
			continue;
		}

		const section = sections.at(-1);

		if (!section) continue;

		if (line.startsWith("+")) {
			section.body.push(line.slice(1));
			section.ops.at(-1)?.body.push(line.slice(1));
			continue;
		}

		if (/^(REM|MV)(\s|$)/.test(line)) section.fileOp = true;
		const op = OP_RE.exec(line);

		if (op) {
			const start = Number(op[2]);
			const end = op[3] ? Number(op[3]) : start;
			const range = /^PUT\s+\d+(\.=\d+)?\s*:/.test(line);
			section.ops.push({ kind: op[1], start, end, range, body: [] });

			for (let n = start; n <= end && n - start < 200; n++) section.anchors.push(n);
		}
	}

	return sections;
}

/** Replace the path of the header on line `index` of `input`, keeping its tag. */
export function rewriteHeader(input, index, path, tag) {
	const lines = input.split("\n");
	lines[index] = `[${path}${tag ? `#${tag}` : ""}]`;

	return lines.join("\n");
}

/**
 * Snapshot views shown in a tool result: every `[path#TAG]` header with the
 * numbered rows printed under it. Rows map line number to the displayed text.
 */
export function parseViews(text) {
	const views = [];
	let current;

	for (const raw of text.split("\n")) {
		const header = HEADER_RE.exec(raw);

		if (header?.[2]) {
			current = { rawPath: header[1], tag: header[2].toUpperCase(), rows: new Map() };
			views.push(current);
			continue;
		}

		const row = current && ROW_RE.exec(raw);

		if (row) current.rows.set(Number(row[1]), row[2]);
	}

	return views;
}

function pathSegments(raw) {
	return unquote(raw.trim())
		.replace(/\\\//g, "/")
		.split("/")
		.filter((s) => s && s !== "." && s !== "~");
}

/**
 * Files read in this process under `tag` with the same file name as the
 * authored path, keeping those that share the longest path tail with it.
 * omp's own recovery matches name and tag the same way, inside the session
 * directory only. `known` maps absolute path to a Set of tags.
 */
export function tagCandidates(rawPath, tag, known) {
	const want = pathSegments(rawPath);

	if (!want.length || !tag) return [];
	let best = 0;
	let out = [];

	for (const [abs, tags] of known) {
		if (!tags.has(tag)) continue;
		const have = abs.split("/");
		let shared = 0;

		while (shared < want.length && shared < have.length && want.at(-1 - shared) === have.at(-1 - shared)) shared++;

		if (shared === 0 || shared < best) continue;

		if (shared > best) out = [];
		best = shared;
		out.push(abs);
	}

	return out;
}

/**
 * Minimal Myers diff over line arrays; returns hunks of [aStart, aEnd, bStart,
 * bEnd), or undefined when the texts differ by more than MAX_DIFF_DISTANCE lines.
 */
export function diffLines(a, b) {
	let pre = 0;

	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;

	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const A = a.slice(pre, a.length - suf);
	const B = b.slice(pre, b.length - suf);
	const ops = myers(A, B);

	if (!ops) return undefined;
	const hunks = [];
	let i = 0;
	let j = 0;
	let open;

	for (const op of ops) {
		if (op === "=") {
			if (open) hunks.push([open[0] + pre, i + pre, open[1] + pre, j + pre]);
			open = undefined;
			i++;
			j++;
			continue;
		}

		open ??= [i, j];

		if (op === "-") i++;
		else j++;
	}

	if (open) hunks.push([open[0] + pre, i + pre, open[1] + pre, j + pre]);

	return hunks;
}

function myers(a, b) {
	const n = a.length;
	const m = b.length;
	const max = n + m;

	if (max === 0) return [];

	if (Math.abs(n - m) > MAX_DIFF_DISTANCE) return undefined;
	const v = new Map([[1, 0]]);
	const trace = [];

	for (let d = 0; d <= Math.min(max, MAX_DIFF_DISTANCE); d++) {
		trace.push(new Map(v));

		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v.get(k - 1) < v.get(k + 1)) ? v.get(k + 1) : v.get(k - 1) + 1;
			let y = x - k;

			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}

			v.set(k, x);

			if (x >= n && y >= m) return backtrack(trace, a, b, d);
		}
	}

	return undefined;
}

function backtrack(trace, a, b, dEnd) {
	const ops = [];
	let x = a.length;
	let y = b.length;

	for (let d = dEnd; d > 0; d--) {
		const v = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && v.get(k - 1) < v.get(k + 1)) ? k + 1 : k - 1;
		const prevX = v.get(prevK);
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			ops.push("=");
			x--;
			y--;
		}

		ops.push(x === prevX ? "+" : "-");
		x = prevX;
		y = prevY;
	}

	while (x > 0 && y > 0) {
		ops.push("=");
		x--;
		y--;
	}

	return ops.reverse();
}

const meaningful = (line) => line.trim().length >= 4 && /[A-Za-z0-9]/.test(line);
const sameBlock = (lines, i, j, k) => i >= 0 && j >= 0 && i + k <= lines.length && j + k <= lines.length && lines.slice(i, i + k).every((l, t) => l === lines[j + t]);
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Damage an applied edit left in the file. `before`/`after` are the full file
 * texts; `resultText` is the edit tool's own output. Returns human-readable
 * findings; an empty array means no damage was detected.
 */
export function detectDamage({ path, before, after, resultText = "", ops = [] }) {
	const findings = shiftedRanges(ops, before.split("\n"));
	const parse = NATIVE_PARSE_RE.exec(resultText);

	if (parse) {
		findings.push(`the file stopped parsing${parse[1] ? ` near line ${parse[1]}` : ""} (omp parse check)`);
	}

	const literal = NATIVE_LITERAL_OP_RE.exec(resultText);

	if (literal) findings.push(`the body row \`${literal[1]}\` is an edit op, and it was written into the file as text`);
	const a = before.split("\n");
	const b = after.split("\n");
	const hunks = diffLines(a, b) ?? [];
	const opener = BLOCK_OPENER.find(([ext]) => ext.test(path))?.[1];
	const fenced = MARKDOWN_EXT.test(path) ? fencedLines(b) : new Set();

	for (const [a0, a1, b0, b1] of hunks) {
		for (let n = b0; n < b1; n++) {
			if (literal || fenced.has(n) || !OP_TEXT_RE.test(b[n])) continue;

			if (REM_COMMENT_EXT.test(path) && /^\s*REM\b/i.test(b[n])) continue;
			findings.push(`line ${n + 1} \`${b[n].trim()}\` is edit syntax, not file content`);
			break;
		}

		const dup = boundaryDuplicate(a, b, b0, b1);

		if (dup) findings.push(dup);

		if (opener) findings.push(...orphanedOpeners(opener, a, b, a0, a1, b0, b1));
	}

	return [...new Set(findings)];
}

function countBlock(lines, block) {
	let n = 0;

	for (let i = 0; i + block.length <= lines.length; i++) if (block.every((l, t) => l === lines[i + t])) n++;

	return n;
}

/**
 * A block at either edge of the added lines [b0, b1) that also sits just
 * outside them (gap of 0-3 lines; 2+ lines when not adjacent), when the edit
 * raised the block's count in the file: the range missed lines the body
 * repeats.
 */
function boundaryDuplicate(a, b, b0, b1) {
	const width = b1 - b0;

	// Single repeated lines (a second assert, a second log call) are often meant; only blocks count.
	for (let m = Math.min(5, width); m >= 2; m--) {
		for (let gap = 0; gap <= 3; gap++) {
			const head = b.slice(b0, b0 + m);

			if (head.some(meaningful) && sameBlock(b, b0, b0 - gap - m, m) && countBlock(b, head) > countBlock(a, head)) {
				return `lines ${b0 + 1}-${b0 + m} repeat lines ${b0 - gap - m + 1}-${b0 - gap} just before them (range start missed lines the body repeats)`;
			}

			const tail = b.slice(b1 - m, b1);

			if (tail.some(meaningful) && sameBlock(b, b1 - m, b1 + gap, m) && countBlock(b, tail) > countBlock(a, tail)) {
				return `lines ${b1 - m + 1}-${b1} repeat lines ${b1 + gap + 1}-${b1 + gap + m} just after them (range end missed lines the body repeats)`;
			}
		}
	}

	return undefined;
}

/** Line indexes inside fenced code blocks of a Markdown file. */
function fencedLines(lines) {
	const inside = new Set();
	let open = false;

	lines.forEach((line, i) => {
		if (/^\s*(```|~~~)/.test(line)) open = !open;
		else if (open) inside.add(i);
	});

	return inside;
}

/** Removed block openers (`def x():`, `key:`) whose indented body the edit kept. */
function orphanedOpeners(opener, a, b, a0, a1, b0, b1) {
	const out = [];
	const added = b.slice(b0, b1);
	const code = (l) => l.replace(/\s+#.*$/, "").trimEnd();

	for (let i = a0; i < a1; i++) {
		const line = code(a[i]);

		if (!opener.test(line)) continue;
		let next = i + 1;

		while (next < a.length && (!a[next].trim() || (next < a1 && indentOf(a[next]) > indentOf(line)))) next++;

		if (next < a1 || next >= a.length || indentOf(a[next]) <= indentOf(line)) continue;
		// A rewritten opener may wrap (hanging indent), so its `:` can sit deeper than the old line.
		const replaced = added.some((l) => indentOf(l) >= indentOf(line) && code(l).endsWith(":"));

		if (!replaced) out.push(`the edit removed the block opener \`${line.trim()}\` (old line ${i + 1}) but kept its body`);
	}

	return out;
}

/**
 * `PUT s.=e:` ops whose numbers are off by k: the body starts (or ends) with
 * the k untouched lines just outside the range and ends (or starts) with the
 * line k inside it, so the k lines at the far end are lost. `ops` must be
 * numbered against `a` (the header tag matched the pre-edit file).
 */
function shiftedRanges(ops, a) {
	const out = [];

	for (const { start: s, end: e, range, body } of ops) {
		if (!range || body.length < 2) continue;
		const has = (line) => body.some((l) => l.trimEnd() === line.trimEnd());
		const eq = (x, y) => x !== undefined && y !== undefined && x.trimEnd() === y.trimEnd();

		for (let k = 1; k <= 3 && k <= e - s; k++) {
			const late = a.slice(e - k, e);

			if (
				body.slice(0, k).every((l, t) => eq(l, a[s - 1 - k + t])) &&
				eq(body.at(-1), a[e - 1 - k]) &&
				late.some(meaningful) &&
				!late.some(has)
			) {
				out.push(`PUT ${s}.=${e} looks ${k} line(s) too late: the body starts with line ${s - k} and ends with line ${e - k}, so line(s) ${e - k + 1}-${e} (\`${late.at(-1).trim()}\`) were deleted`);
				break;
			}

			const early = a.slice(s - 1, s - 1 + k);

			if (
				body.slice(-k).every((l, t) => eq(l, a[e + t])) &&
				eq(body[0], a[s - 1 + k]) &&
				early.some(meaningful) &&
				!early.some(has)
			) {
				out.push(`PUT ${s}.=${e} looks ${k} line(s) too early: the body starts with line ${s + k} and ends with line ${e + k}, so line(s) ${s}-${s + k - 1} (\`${early[0].trim()}\`) were deleted`);
				break;
			}
		}
	}

	return out;
}

/** Whether an edit result is the native stale-tag rejection. */
export const isStaleRejection = (text) => STALE_RE.test(text);

/**
 * After a stale-tag rejection: where the lines the agent anchored now live.
 * `view` maps old line numbers to the text the agent saw under the old tag.
 * Returns `{ text, moves }` (moves: [oldLine, currentLine] pairs that differ),
 * or undefined when nothing useful can be said.
 */
export function staleHint({ path, anchors, body, view, current, liveTag }) {
	const lines = current.split("\n");
	const solid = body.filter(meaningful).length;

	if (solid) {
		const at = findBlock(lines.map((l) => l.trimEnd()), body.map((l) => l.trimEnd()));

		if (at >= 0 && (solid >= 2 || anchors.some((n) => Math.abs(n - (at + 1)) <= 3))) {
			return {
				text: `The new text of this edit is already in ${path} at lines ${at + 1}-${at + body.length} (current tag #${liveTag}). The edit was applied earlier; do not re-apply it.`,
				moves: [],
			};
		}
	}

	if (!view) return undefined;

	const uniqueAt = (text) => {
		const hits = [];
		lines.forEach((l, i) => l === text && hits.push(i + 1));

		return hits.length === 1 ? hits[0] : undefined;
	};

	const moves = [];
	const changed = [];

	for (const n of anchors) {
		const old = view.get(n);

		if (old === undefined) continue;
		const at = meaningful(old) ? uniqueAt(old) : undefined;

		if (at !== undefined) {
			if (at !== n) moves.push([n, at]);
			continue;
		}

		const offsets = [];

		for (let d = 1; d <= 5; d++) {
			for (const m of [n - d, n + d]) {
				const t = view.get(m);
				const hit = t !== undefined && meaningful(t) ? uniqueAt(t) : undefined;

				if (hit !== undefined) offsets.push(hit - m);
			}
		}

		if (!offsets.length) continue;
		const target = n + offsets.sort((x, y) => x - y)[offsets.length >> 1];

		if (target < 1 || target > lines.length) continue;
		changed.push([n, target, old]);

		if (target !== n) moves.push([n, target]);
	}

	if (!moves.length && !changed.length) return undefined;
	const out = [`Your line numbers came from an older view of ${path}. The current tag is #${liveTag}.`];

	if (moves.length) out.push(`Your anchors moved: ${moves.map(([o, c]) => `old line ${o} is now line ${c}`).join(", ")}.`);

	for (const [n, target, old] of changed) out.push(`Old line ${n} (\`${old.trim()}\`) was changed by someone else; it is now line ${target}.`);
	const targets = [...moves.map(([, c]) => c), ...changed.map(([, c]) => c)];
	const lo = Math.max(1, Math.min(...targets) - 1);
	const hi = Math.min(lines.length, Math.max(...targets) + 1);
	out.push("Current text there:");

	for (let i = lo; i <= hi; i++) out.push(`${i}:${lines[i - 1]}`);
	out.push(`Re-issue the edit under [${path}#${liveTag}] with these current numbers. The old numbers point at other lines now.`);

	return { text: out.join("\n"), moves };
}

function findBlock(lines, block) {
	if (!block.length) return -1;

	for (let i = 0; i + block.length <= lines.length; i++) {
		if (block.every((l, t) => l === lines[i + t])) return i;
	}

	return -1;
}
