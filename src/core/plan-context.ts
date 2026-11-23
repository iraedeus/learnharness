import type { AgentMessage, AgentToolCall } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "./native-messages.ts";
import { PLAN_TRANSITION_TOOLS, ROOT_PLAN_GRAPH_ID, readPlanTransition, type PlanToolResult, type PlanTransition } from "./contracts/plan.ts";

function contextNote(toolCallId: string, timestamp: number, text: string): LhMessage {
	return { id: `plan-context:${toolCallId}`, role: "user", content: [{ type: "text", text }], timestamp };
}

function branchNote(transition: PlanTransition): string {
	if (transition.kind === "leave") return `Branch result for ${transition.topic}: ${transition.summary}`;
	const { graph, topic, goal, context } = transition;
	const nodes = graph.tree.nodes.map(node => `- ${node.id}: ${node.title}`).join("\n");
	const edges = graph.tree.edges.map(edge => `${edge.from} → ${edge.to}`).join(", ");
	return `Active lesson branch: ${topic}\nGraph id: ${graph.id}\nGoal: ${goal}\nRelevant context: ${context}\nPlan nodes:\n${nodes}${edges ? `\nPrerequisites: ${edges}` : ""}`;
}

/** Scope the model's copy of the conversation. The original tool calls and
 * results remain in the native transcript for replay and display. */
export function projectPlanContext(messages: readonly LhMessage[]): readonly LhMessage[];
export function projectPlanContext(messages: readonly AgentMessage[]): readonly AgentMessage[];
export function projectPlanContext(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	const calls = new Map<string, AgentToolCall>();
	const switchedCalls = new Set<AgentToolCall>();
	const transitions = new Map<AgentMessage, PlanTransition>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall" && PLAN_TRANSITION_TOOLS.some(name => name === block.name)) calls.set(block.id, block);
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError || !PLAN_TRANSITION_TOOLS.some(name => name === message.toolName)) continue;
		const transition = readPlanTransition(message.details);
		const call = calls.get(message.toolCallId);
		if (!transition || call?.name !== message.toolName) continue;
		transitions.set(message, transition);
		switchedCalls.add(call);
		calls.delete(message.toolCallId);
	}
	if (transitions.size === 0) return messages;

	const roots: AgentMessage[] = [];
	const frames = new Map<string, AgentMessage[]>([[ROOT_PLAN_GRAPH_ID, roots]]);
	let graphId = ROOT_PLAN_GRAPH_ID;
	let frame = roots;
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const content = message.content.filter(block => block.type !== "toolCall" || !switchedCalls.has(block));
			if (content.length === message.content.length) frame.push(message);
			else if (content.some(block => block.type !== "thinking")) frame.push({ ...message, content });
			continue;
		}
		if (message.role === "toolResult") {
			const transition = transitions.get(message);
			if (transition) {
				const target = transition.kind === "enter" ? transition.graph.id : transition.parentGraphId;
				frame = frames.get(target) ?? [];
				frames.set(target, frame);
				graphId = target;
				frame.push(contextNote(message.toolCallId, message.timestamp, branchNote(transition)));
				continue;
			}
			if (message.toolName === "plan_init" && !message.isError) {
				const result = message.details as PlanToolResult | undefined;
				const active = result?.ok === true && result.activeGraphId ? result.activeGraphId : graphId;
				if (active !== graphId) {
					frame.push(message);
					graphId = active;
					frame = frames.get(active) ?? roots;
					const nodes = result?.tree?.nodes.map(node => `${node.id}: ${node.title}`).join(", ");
					frame.push(contextNote(message.toolCallId, message.timestamp, `The root plan was revised and the lesson returned to graph ${active}. Current root nodes: ${nodes ?? ""}`));
					continue;
				}
			}
		}
		frame.push(message);
	}
	const system = messages[0];
	return frame !== roots && system?.role === "system" ? [system, ...frame] : frame;
}
