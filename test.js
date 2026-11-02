import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { detectDamage, fileTag, parseSections, staleHint, tagCandidates } from "./core.js";
import { replay } from "./replay/run.js";

const fruit = "# Title\n\n## Section one\n\nLine A about apples.\nLine B about bananas.\nLine C about cherries.\n\n## Section two\n\nLine D about dates.\nLine E about elderberries.\n";

describe("fileTag", () => {
	test("matches the tag omp 18.16 minted for the same text", () => {
		expect(fileTag(fruit)).toBe("8678");
	});
	test("ignores trailing whitespace like omp does", () => {
		expect(fileTag(fruit.replace("apples.", "apples.  \t"))).toBe("8678");
	});
});

const damage = (before, after, input = "", resultText = "", path = "f.txt") => {
	const [section] = parseSections(input || "[f.txt#0000]");

	return detectDamage({ path, before, after, resultText, ops: section?.ops ?? [] });
};

describe("detectDamage", () => {
	const js = ["function f() {", "\tsetup();", "\tqueue(() => {", "\t\tstart();", "\t\tdone();", "\t});", "\treturn s;", "}", ""].join("\n");

	test("flags a PUT range one line too late that deletes the next line", () => {
		const input = "[f.js#0000]\nPUT 4.=7:\n+\tqueue(() => {\n+\t\tstart2();\n+\t\tdone();\n+\t});";
		const after = js.replace("\t\tstart();\n\t\tdone();\n\t});\n\treturn s;", "\t\tstart2();\n\t\tdone();\n\t});");
		expect(damage(js, after, input, "", "f.js").join(" ")).toContain("1 line(s) too late");
	});

	test("accepts the same change with the right range", () => {
		const input = "[f.js#0000]\nPUT 4.=4:\n+\t\tstart2();";
		expect(damage(js, js.replace("start();", "start2();"), input, "", "f.js")).toEqual([]);
	});

	test("flags a body row that is edit syntax written into the file", () => {
		const after = fruit.replace("Line B about bananas.", "Line B about bananas.\nPUT 9.=10:");
		expect(damage(fruit, after).join(" ")).toContain("edit syntax");
	});

	test("reports omp's own parse and literal-op warnings", () => {
		const text = "This edit introduced a syntax error near line 7: the file parsed before\nline 4: body row `+REM` is itself a valid hunk header, so it was inserted";
		const found = damage(fruit, fruit.replace("Line E", "REM\nLine E"), "", text).join(" ");
		expect(found).toContain("near line 7");
		expect(found).toContain("`+REM`");
	});

	test("flags a duplicated block at the end of the edited range", () => {
		const after = fruit.replace("Line B about bananas.\n", "Line B about blueberries.\nLine C about cherries.\n\n");
		expect(damage(fruit, after).join(" ")).toContain("range end missed lines");
	});

	test("accepts a new line that does not repeat its neighbours", () => {
		expect(damage(fruit, fruit.replace("Line B about bananas.\n", "Line B about bananas.\nLine B2 about bread.\n"))).toEqual([]);
	});

	const py = "import os\n\n\ndef alpha(x):\n    if x:\n        return 1\n    return 2\n\n\ndef beta(y):\n    total = 0\n    for i in range(y):\n        total += i\n    return total\n";

	test("flags a removed def line whose body stayed (valid Python, wrong meaning)", () => {
		const after = py.replace("def beta(y):\n    total = 0\n", "    total = 1\n");
		expect(damage(py, after, "", "", "a.py").join(" ")).toContain("block opener `def beta(y):`");
	});

	test("accepts removing a whole function", () => {
		const after = py.replace(/\n\ndef beta[\s\S]*$/, "\n");
		expect(damage(py, after, "", "", "a.py")).toEqual([]);
	});

	test("accepts wrapping a condition with a hanging indent", () => {
		const src = "def f(a, b):\n    if a:\n        return 1\n    return 2\n";
		const after = src.replace("    if a:\n", "    if (a and\n            b):\n");
		expect(damage(src, after, "", "", "f.py")).toEqual([]);
	});

	test("accepts a second identical line next to the first", () => {
		const src = "test('x', () => {\n\texpect(f()).toBe(1);\n});\n";
		expect(damage(src, src.replace("toBe(1);\n", "toBe(1);\n\texpect(f()).toBe(1);\n"), "", "", "x.test.js")).toEqual([]);
	});

	test("accepts edit syntax inside a Markdown code fence and REM in a batch file", () => {
		const md = "# Notes\n\n```\n```\n";
		expect(damage(md, md.replace("```\n```", "```\nPUT 4.=9:\n```"), "", "", "notes.md")).toEqual([]);
		expect(damage("@echo off\n", "@echo off\nREM greet\n", "", "", "run.bat")).toEqual([]);
	});
});

describe("fileTag normalization", () => {
	test("drops a BOM and treats CRLF like LF, as omp does", () => {
		expect(fileTag(`\uFEFF${fruit}`)).toBe("8678");
		expect(fileTag(fruit.replaceAll("\n", "\r\n"))).toBe("8678");
	});
});

describe("tagCandidates", () => {
	const known = new Map([
		["/w/fix-1/docs/work/T-1/packet.md", new Set(["7A27"])],
		["/w/fix-2/docs/work/T-2/packet.md", new Set(["1111"])],
	]);

	test("finds the read file with the same tag and name, absolute or relative", () => {
		expect(tagCandidates("docs/work/T-1/packet.md", "7A27", known)).toEqual(["/w/fix-1/docs/work/T-1/packet.md"]);
		expect(tagCandidates("w/fix-1/docs/work/T-1/packet.md", "7A27", known)).toHaveLength(1);
		expect(tagCandidates("packet.md", "7A27", known)).toHaveLength(1);
		expect(tagCandidates("/repo-wt/docs/work/T-1/packet.md", "7A27", known)).toHaveLength(1);
	});

	test("ignores other tags and other file names", () => {
		expect(tagCandidates("docs/work/T-1/packet.md", "2222", known)).toEqual([]);
		expect(tagCandidates("docs/work/T-1/notes.md", "7A27", known)).toEqual([]);
	});

	test("keeps only the candidates sharing the longest path tail", () => {
		const two = new Map([...known, ["/w/other/packet.md", new Set(["7A27"])]]);
		expect(tagCandidates("work/T-1/packet.md", "7A27", two)).toEqual(["/w/fix-1/docs/work/T-1/packet.md"]);
		expect(tagCandidates("packet.md", "7A27", two)).toHaveLength(2);
	});
});

describe("staleHint", () => {
	test("says when the edit is already in the file", () => {
		const hint = staleHint({ path: "f", anchors: [6], body: ["Line B about blueberries."], view: undefined, current: fruit.replace("bananas", "blueberries"), liveTag: "ABCD" });
		expect(hint.text).toContain("already in f at lines 6-6");
	});
	test("maps a changed line to its new place through unchanged neighbours", () => {
		const view = new Map(fruit.split("\n").map((l, i) => [i + 1, l]));
		const current = fruit.replace("# Title\n", "# Title\n\nP1\nP2\nP3\nP4\nP5\n").replace("dates.", "dried dates.");
		const hint = staleHint({ path: "f", anchors: [11], body: ["Line D about plums."], view, current, liveTag: "ABCD" });
		expect(hint.moves).toEqual([[11, 17]]);
		expect(hint.text).toContain("17:Line D about dried dates.");
	});
});

const hasOmp = Bun.which("omp") !== null;
const shifted = JSON.parse(readFileSync(new URL("./replay/cases/shifted-range.json", import.meta.url), "utf8"));
const lastEdit = (out) => out.results.filter((r) => r.tool === "edit").at(-1);

describe.skipIf(!hasOmp)("omp end to end", () => {
	test("without the guard, the shifted range deletes `return stream;`", async () => {
		const out = await replay(shifted);
		expect(lastEdit(out).isError).toBe(false);
		expect(out.files["provider.js"]).not.toContain("return stream;");
	}, 90_000);

	test("with the guard, the edit is refused and the file is unchanged", async () => {
		const out = await replay(shifted, { guard: true });
		expect(lastEdit(out).isError).toBe(true);
		expect(lastEdit(out).text).toContain("1 line(s) too late");
		expect(out.files["provider.js"]).toBe(shifted.files["provider.js"]);
	}, 90_000);

	test("after a refusal, the corrected edit applies in one call on the same tag", async () => {
		const bad = shifted.turns[1][0].arguments.input;
		const fixed = bad.replace("PUT 32.=35:", "PUT 31.=34:");
		const spec = { ...shifted, turns: [...shifted.turns, [{ name: "edit", arguments: { i: "fix", input: fixed } }]] };
		const out = await replay(spec, { guard: true });
		expect(lastEdit(out).isError).toBe(false);
		expect(out.files["provider.js"]).toContain("toolcall_end");
		expect(out.files["provider.js"]).toContain("return stream;");
	}, 90_000);

	test("re-sending the identical edit applies it as written", async () => {
		const spec = { ...shifted, turns: [...shifted.turns, shifted.turns[1]] };
		const out = await replay(spec, { guard: true });
		expect(lastEdit(out).isError).toBe(false);
		expect(out.files["provider.js"]).not.toContain("return stream;");
	}, 90_000);

	const worktree = {
		files: { "wt/fix-7/docs/work/T-7/packet.md": fruit, "session/README.md": "session checkout\n" },
		cwd: "session",
		turns: [
			[{ name: "read", arguments: { path: "$ROOT/wt/fix-7/docs/work/T-7/packet.md", i: "read" } }],
			[{ name: "edit", arguments: { i: "edit", input: "[docs/work/T-7/packet.md#$TAG(wt/fix-7/docs/work/T-7/packet.md)]\nPUT 6.=6:\n+Line B about blueberries." } }],
		],
	};

	test("a repo-relative header for a worktree file fails without the guard", async () => {
		const out = await replay(worktree);
		expect(lastEdit(out).text).toContain("File not found");
	}, 90_000);

	test("the guard rebinds it to the file read under the same tag", async () => {
		const out = await replay(worktree, { guard: true });
		expect(lastEdit(out).isError).toBe(false);
		expect(out.files["wt/fix-7/docs/work/T-7/packet.md"]).toContain("blueberries");
	}, 90_000);

	test("a stale edit that already landed gets an answer instead of a retry loop", async () => {
		const spec = {
			files: { "f.md": fruit, "next.md": fruit.replace("bananas", "blueberries") },
			turns: [
				[{ name: "read", arguments: { path: "f.md", i: "read" } }],
				[{ name: "bash", arguments: { command: "cp next.md f.md", i: "writer" } }],
				[{ name: "edit", arguments: { i: "edit", input: "[f.md#$TAG(f.md)]\nPUT 6.=6:\n+Line B about blueberries.\n+Line C about cherries." } }],
			],
		};

		const out = await replay(spec, { guard: true });
		expect(lastEdit(out).isError).toBe(true);
		expect(lastEdit(out).text).toContain("already in f.md");
	}, 90_000);
});
