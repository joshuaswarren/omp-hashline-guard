// Replays scripted tool calls through a real `omp -p` session, with or
// without the guard, and reports tool results and final file contents.
//
//   bun replay/run.js <case.json> [--guard | --installed] [--json]
//
// --guard loads ../index.js from this checkout. --installed loads no explicit
// guard and keeps extension discovery on, so it tests the plugin installed in omp.
//
// case.json: { "files": { "<rel>": "<text>" }, "cwd": "<rel dir>", "turns": [[{ name, arguments }]] }
// Every string in files/cwd/turns may use $ROOT for the temporary case root.
// Tags: "#$TAG(<rel>)" in a turn becomes the hashline tag of that file's text
// at the time the case starts.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileTag } from "../core.js";

const here = dirname(new URL(import.meta.url).pathname);

export async function replay(spec, { guard = false, installed = false, timeoutMs = 60_000 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "hg-replay-"));

	try {
		const sub = (s) => s.replaceAll("$ROOT", root).replace(/\$TAG\(([^)]+)\)/g, (_, rel) => fileTag(spec.files[rel]));

		for (const [rel, text] of Object.entries(spec.files)) {
			const abs = join(root, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}

		const turns = JSON.parse(sub(JSON.stringify(spec.turns)));
		const scriptPath = join(root, ".replay-script.json");
		writeFileSync(scriptPath, JSON.stringify(turns));
		const cwd = join(root, spec.cwd ?? ".");
		mkdirSync(cwd, { recursive: true });
		const args = ["-p", ...(installed ? [] : ["--no-extensions"]), "-e", join(here, "scripted-provider.js")];

		if (guard) args.push("-e", resolve(here, "../index.js"));
		args.push("--model", "replay/script", "--tools", "read,edit,bash", "--mode", "json", "--no-lsp", "replay");
		const proc = Bun.spawn(["omp", ...args], { cwd, env: { ...process.env, REPLAY_SCRIPT: scriptPath }, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const results = [];
		let buffer = "";
		const decoder = new TextDecoder();

		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl;
			let ended = false;

			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				let event;

				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}

				const m = event.message;

				if (event.type === "message_end" && m?.role === "toolResult") {
					results.push({ tool: m.toolName, isError: !!m.isError, text: m.content.map((c) => c.text ?? "").join("\n") });
				}

				if (event.type === "agent_end") ended = true;
			}

			if (ended) break;
		}

		clearTimeout(timer);
		proc.kill();
		const files = Object.fromEntries(Object.keys(spec.files).map((rel) => [rel, readFileSync(join(root, rel), "utf8")]));

		return { results, files, root };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [file, ...flags] = process.argv.slice(2);
	const spec = JSON.parse(readFileSync(file, "utf8"));
	const out = await replay(spec, { guard: flags.includes("--guard"), installed: flags.includes("--installed") });

	if (flags.includes("--json")) console.log(JSON.stringify(out));
	else {
		for (const r of out.results) console.log(`--- ${r.tool}${r.isError ? " (error)" : ""}\n${r.text}`);

		for (const [rel, text] of Object.entries(out.files)) console.log(`=== ${rel} (#${fileTag(text)})\n${text}`);
	}
}
