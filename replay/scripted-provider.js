// Test-only omp extension: a provider whose "model" replays a fixed script of
// tool calls, so real edit inputs run through omp's real edit tool without a
// language model. Script: JSON array of turns at $REPLAY_SCRIPT; each turn is
// an array of { name, arguments }. After the last turn it answers "done".

import { readFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

export default function scriptedProvider(pi) {
	const script = JSON.parse(readFileSync(process.env.REPLAY_SCRIPT, "utf8"));
	pi.registerProvider("replay", {
		baseUrl: "https://replay.invalid/",
		apiKey: "unused",
		api: "replay-script",
		streamSimple(model, context) {
			const stream = new AssistantMessageEventStream();
			const turn = context.messages.filter((m) => m.role === "assistant").length;
			const calls = script[turn];

			const message = {
				role: "assistant",
				content: calls
					? calls.map((c, i) => ({ type: "toolCall", id: `replay-${turn}-${i}`, name: c.name, arguments: c.arguments }))
					: [{ type: "text", text: "done" }],
				api: "replay-script",
				provider: "replay",
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: calls ? "toolUse" : "stop",
				timestamp: Date.now(),
			};

			queueMicrotask(() => {
				const blocks = message.content;
				const partial = { ...message, content: [] };
				stream.push({ type: "start", partial });
				blocks.forEach((block, i) => {
					partial.content.push(block);

					if (block.type === "text") {
						stream.push({ type: "text_start", contentIndex: i, partial });
						stream.push({ type: "text_end", contentIndex: i, content: block.text, partial });
					} else {
						stream.push({ type: "toolcall_start", contentIndex: i, partial });
						stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial });
					}
				});
				stream.push({ type: "done", reason: message.stopReason, message });
			});

			return stream;
		},
		models: [
			{
				id: "script",
				name: "Replay script",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	});
}
