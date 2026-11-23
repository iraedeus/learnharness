import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const data = mkdtempSync(join(tmpdir(), "lh-nested-plan-flow-"));
process.env.LH_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { asAgentMessages, newAnswerResult, newUserMessage } = await import("../src/core/native-messages.ts");
const { planGraphPath } = await import("../src/core/plan-tree.ts");
const { displayedPlan, liveSessionPlan } = await import("../src/core/plan-view.ts");
const { projectView } = await import("../src/core/view.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");

function call(name: string, id: string, args: Parameters<typeof fauxToolCall>[1], text?: string) {
	return fauxAssistantMessage([...(text ? [fauxText(text)] : []), fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function answer(id: string, text: string) {
	return newAnswerResult(id, "explain", {
		kind: "explain", questionText: "Explain the step.", answers: [], text, dontKnow: false, answeredAt: new Date().toISOString(),
	});
}

function explain(id: string, nodeId: string, question: string, graphId?: string) {
	return call("explain", id, { type: "check", nodeId, question, correctAnswer: "A complete explanation.", ...(graphId ? { graphId } : {}) });
}

test("the same lesson teaches two nested branches, returns to UDP, and keeps the learner's full transcript", async () => {
	const chat = chatStore.createChat("Networks");
	const requests: string[] = [];
	async function turn(input: LhMessage, steps: FauxResponseStep[]) {
		const before = [...chatStore.getChat(chat.id)!.messages, input];
		chatStore.saveMessages(chat.id, before);
		const faux = createFauxCore({});
		faux.setResponses(steps);
		const agent = createTeacherAgent({ chatId: chat.id, chatStore, jobStore, spawn() {} }, {
			chatId: chat.id, messages: asAgentMessages(before), toolToggles: { explain: true },
			engine: { model: faux.getModel(), streamFn(model, context, options) {
				requests.push(JSON.stringify(context.messages.filter(message => message.role !== "system")));
				return faux.streamSimple(model, context, options);
			} },
		});
		const handle = runPiTurn({ agent, onFinish(messages, aborted) { persistTurn(chatStore, chat.id, before.length, messages, aborted); } });
		const wire = await new Response(handle.subscribe()).text();
		assert(!wire.includes('"type":"error"'), wire);
		return chatStore.getChat(chat.id)!;
	}

	const root = await turn(newUserMessage("I want to compare ways to carry data across a network. Root-only discussion."), [
		call("plan_init", "network-plan", { mermaid: "graph TD\nip[IP addressing] --> transport[Transport] --> applications[Applications]" }),
		explain("transport-check", "transport", "What does the transport layer add?"),
	]);
	const inTcp = await turn(answer("transport-check", "End-to-end transport between processes."), [
		call("plan_enter", "enter-transport", {
			nodeId: "transport", goal: "Distinguish reliable transport from datagrams.", context: "The learner understands IP and process ports.",
			mermaid: "graph TD\nports[Process ports] --> tcp[TCP] --> udp[UDP]",
		}),
		call("plan_enter", "enter-tcp", {
			nodeId: "tcp", goal: "Explain a reliable byte stream.", context: "The learner understands IP and ports. Acknowledgements are new.",
			mermaid: "graph TD\nhandshake[Connection setup] --> acknowledgements[Acknowledgements] --> retransmission[Retransmission]",
		}, "Transport-only discussion."),
		() => {
			const duringTurn = chatStore.getChat(chat.id)!;
			assert.equal(duringTurn.activeGraphId, undefined, "the branch commits with its transition in the saved transcript");
			return explain("tcp-check", "acknowledgements", "How does a TCP acknowledgement work?", duringTurn.nestedPlanGraphs?.find(graph => graph.parentNodeId === "tcp")?.id);
		},
	]);
	const [rootId, transportId, tcpId] = planGraphPath(inTcp);
	assert.equal(rootId, "root");
	assert(transportId && tcpId && transportId !== tcpId);
	assert.match(requests[3]!, /Distinguish reliable transport from datagrams/);
	assert.doesNotMatch(requests[3]!, /Root-only discussion/);
	assert.match(requests[4]!, /Explain a reliable byte stream/);
	assert.match(requests[4]!, /Acknowledgements are new/);
	assert.doesNotMatch(requests[4]!, /Root-only discussion|Transport-only discussion/);

	const returned = await turn(answer("tcp-check", "TCP-only learner response: the next expected sequence number."), [
		call("plan_leave", "leave-tcp", { summary: "The learner explained cumulative acknowledgements and why retransmission matters." }),
		explain("udp-check", "udp", "When would we choose UDP?", transportId),
	]);
	assert.deepEqual(planGraphPath(returned), ["root", transportId]);
	assert.match(requests.at(-2)!, /TCP-only learner response/);
	assert.match(requests.at(-1)!, /Branch result for TCP: The learner explained cumulative acknowledgements/);
	assert.match(requests.at(-1)!, /Transport-only discussion/);
	assert.doesNotMatch(requests.at(-1)!, /TCP-only learner response|Root-only discussion|A reliable byte stream/i);
	const transcript = JSON.stringify(projectView(returned.messages));
	for (const text of ["Root-only discussion", "Transport-only discussion", "TCP-only learner response", "When would we choose UDP?"]) assert(transcript.includes(text));
	const initialResults = new Set(root.messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
	const nested = liveSessionPlan(root, inTcp.messages, initialResults);
	assert.deepEqual(displayedPlan(nested).breadcrumbs.map(entry => entry.title), ["The plan", "Transport", "TCP"]);
	assert.equal(displayedPlan(nested, "root").graphId, "root");
	assert.equal(displayedPlan(liveSessionPlan(root, returned.messages, initialResults), "root").graphId, "root");
	assert.equal(displayedPlan(returned).graphId, transportId);
});
