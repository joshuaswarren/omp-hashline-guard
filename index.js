// omp-hashline-guard: an omp extension that stops hashline edits from
// damaging files and shortens recovery from rejected edits.
//
// 1. tool_call: rebinds a header path that does not exist to the one file
//    this process read under the same tag and file name (worktree and
//    absolute-path slips), refuses once a header that resolves to a file the
//    agent never read while the tag came from another copy, and refuses once
//    a retry that reuses old line numbers under the tag a stale rejection named.
// 2. tool_result: when an applied edit damaged the file (omp's parse check,
//    edit ops written as text, a shifted range, a duplicated boundary block,
//    an orphaned block opener), restores the files and returns an error.
//    Re-sending the identical edit applies it as written.
// 3. tool_result: after a stale-tag rejection, says where the anchored lines
//    went, or that the edit is already in the file.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
	detectDamage,
	fileTag,
	isStaleRejection,
	parseSections,
	parseViews,
	resolvePath,
	rewriteHeader,
	staleHint,
	tagCandidates,
} from "./core.js";

const MAX_VIEWS = 2000;
const MAX_CONFIRMED = 200;
const MAX_PENDING = 64;

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const readText = (path) => (isFile(path) ? readFileSync(path, "utf8") : null);
const textOf = (content) => (content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");

const bounded = (map, max) => {
	while (map.size > max) map.delete(map.keys().next().value);
};

export function createGuard() {
	/** absolute path -> Set of tags this process showed the agent */
	const known = new Map();
	/** `${abs}#${tag}` -> Map(line -> displayed text) */
	const views = new Map();
	/** toolCallId -> { hash, sections: [{ abs, rawPath, tag, anchors, body, before }] } */
	const pending = new Map();
	/** hashes of edit inputs refused once; an identical re-send passes */
	const confirmed = new Set();
	/** absolute path -> { liveTag, moves: Map(old line -> current line) } after a stale rejection */
	const staleMoves = new Map();

	function record(text, cwd) {
		for (const view of parseViews(text)) {
			const abs = resolvePath(view.rawPath, cwd);

			if (!abs) continue;

			if (!known.has(abs)) known.set(abs, new Set());
			known.get(abs).add(view.tag);
			const key = `${abs}#${view.tag}`;
			const rows = views.get(key) ?? new Map();

			for (const [n, t] of view.rows) rows.set(n, t);
			views.delete(key);
			views.set(key, rows);
		}

		bounded(views, MAX_VIEWS);
	}

	function confirmOnce(hash) {
		if (confirmed.delete(hash)) return true;
		confirmed.add(hash);
		bounded(confirmed, MAX_CONFIRMED);

		return false;
	}

	function onToolCall(event, ctx) {
		// The edit tool's schema validates `input` as a string in the text modes (hashline, apply_patch, sloppy).
		const input = event.toolName === "edit" ? event.input?.input : undefined;

		if (input === undefined) return undefined;
		const cwd = ctx?.cwd ?? process.cwd();
		const hash = String(Bun.hash(input));
		let revised = input;
		const notes = [];
		const sections = [];

		for (const section of parseSections(input)) {
			let abs = resolvePath(section.rawPath, cwd);
			let display = section.rawPath;

			if (!abs) continue;

			if (section.tag && !existsSync(abs)) {
				const found = tagCandidates(section.rawPath, section.tag, known).filter(isFile);

				if (found.length === 1) {
					[abs] = found;
					display = abs;
					revised = rewriteHeader(revised, section.line, abs, section.tag);
					notes.push(`hashline-guard: "${section.rawPath}" does not exist; the edit went to ${abs}, the file read under #${section.tag}. Use that path in headers.`);
				}
			} else if (section.tag && !known.has(abs)) {
				const other = tagCandidates(section.rawPath, section.tag, known).filter((p) => p !== abs && isFile(p));

				if (other.length === 1 && !confirmOnce(`copy:${hash}`)) {
					return {
						block: true,
						reason: `hashline-guard: [${section.rawPath}#${section.tag}] resolves to ${abs}, which this session never read. Tag #${section.tag} came from ${other[0]} (another checkout or copy). Use [${other[0]}#${section.tag}]. If ${abs} is the file you mean, re-send this identical edit.`,
					};
				}
			}

			const stale = staleMoves.get(abs);

			if (stale && stale.liveTag === section.tag) {
				const reused = section.anchors.filter((n) => stale.moves.has(n) && !section.anchors.includes(stale.moves.get(n)));

				if (reused.length && !confirmOnce(`stale:${hash}`)) {
					return {
						block: true,
						reason: `hashline-guard: under #${section.tag} these line numbers point at other lines. You took them from the older view: ${reused.map((n) => `old ${n} is now ${stale.moves.get(n)}`).join(", ")}. Re-issue with the current numbers. If you mean these exact lines, re-send this identical edit.`,
					};
				}
			}

			sections.push({ ...section, abs, display, before: section.fileOp ? null : readText(abs) });
		}

		if (sections.length) {
			pending.set(event.toolCallId, { hash, sections });
			// A call that another hook blocks never reaches tool_result.
			bounded(pending, MAX_PENDING);
		}

		if (revised === input) return undefined;
		const { path: _path, paths: _paths, ...params } = event.input;

		return { input: { ...params, input: revised }, additionalContext: notes.join("\n") };
	}

	function onEditResult(event, call) {
		const text = textOf(event.content);

		if (event.isError) {
			if (!isStaleRejection(text)) return undefined;

			for (const s of call.sections) {
				const current = readText(s.abs);

				if (current === null || !s.tag) continue;
				const liveTag = fileTag(current);

				if (liveTag === s.tag) continue;

				const hint = staleHint({
					path: s.display,
					anchors: s.anchors,
					body: s.body,
					view: views.get(`${s.abs}#${s.tag}`),
					current,
					liveTag,
				});

				if (!hint) continue;

				if (hint.moves.length) staleMoves.set(s.abs, { liveTag, moves: new Map(hint.moves) });

				return { content: [...event.content, { type: "text", text: `hashline-guard: ${hint.text}` }] };
			}

			return undefined;
		}

		for (const s of call.sections) staleMoves.delete(s.abs);
		const files = call.sections.filter((s) => s.before !== null);
		const afters = files.map((s) => readText(s.abs));

		if (!files.length || afters.includes(null)) return undefined;

		const findings = files.flatMap((s, i) =>
			detectDamage({
				path: s.abs,
				before: s.before,
				after: afters[i],
				resultText: text,
				ops: s.tag === fileTag(s.before) ? s.ops : [],
			}).map((f) => `- ${s.display}: ${f}`),
		);

		if (!findings.length || confirmOnce(`damage:${call.hash}`)) return undefined;
		const failed = [];

		files.forEach((s, i) => {
			try {
				// Only undo our own write: skip a file someone changed after the edit.
				if (afters[i] !== s.before && readText(s.abs) === afters[i]) writeFileSync(s.abs, s.before);
			} catch (error) {
				failed.push(`${s.display}: ${error.message}`);
			}
		});

		if (failed.length) {
			return {
				isError: true,
				content: [
					...event.content,
					{ type: "text", text: ["hashline-guard: this edit damaged the file, and undoing it failed:", ...findings, ...failed, "Re-read the file and repair it."].join("\n") },
				],
			};
		}

		const headers = files.map((s) => `[${s.display}#${fileTag(s.before)}]`).join(" ");

		return {
			isError: true,
			content: [
				{
					type: "text",
					text: [
						"hashline-guard refused this edit and undid it. It applied, but it damaged the file:",
						...findings,
						`The file is back to its content before this call, so ${headers} is still the current header. Your old line numbers are still valid.`,
						"Fix the line numbers or range ends and re-issue. If the damage is what you meant, re-send the identical edit once and it applies as written.",
						"",
						"Result of the refused edit, for reference:",
						text,
					].join("\n"),
				},
			],
		};
	}

	function onToolResult(event, ctx) {
		const cwd = ctx?.cwd ?? process.cwd();
		let out;
		const call = event.toolName === "edit" ? pending.get(event.toolCallId) : undefined;

		if (call) {
			pending.delete(event.toolCallId);
			out = onEditResult(event, call);
		}

		if (!out?.isError) record(textOf(out?.content ?? event.content), cwd);

		// A later edit in the same batch runs after this result: rebase its snapshot.
		for (const other of pending.values()) {
			for (const s of other.sections) if (s.before !== null) s.before = readText(s.abs) ?? s.before;
		}

		return out;
	}

	return { onToolCall, onToolResult, state: { known, views, pending, confirmed } };
}

export default function hashlineGuard(pi) {
	const guard = createGuard();
	pi.on("tool_call", (event, ctx) => guard.onToolCall(event, ctx));
	pi.on("tool_result", (event, ctx) => guard.onToolResult(event, ctx));
}
