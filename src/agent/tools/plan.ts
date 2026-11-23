import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { ROOT_PLAN_GRAPH_ID, type PlanTransition } from "../../core/contracts/plan.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, planGraphPath, planGraphTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";

/** The binding-id reminder riding plan_init's slim content (owner,
 *  2026-10-09): plan_init is the exact moment the node ids become
 *  load-bearing — every later quiz/explain call must reference one. The
 *  field-drop incidents (tools_fails_2) showed the turn's tail is where
 *  discipline slips; the reminder lands right there. */
const PLAN_NODE_IDS_REMINDER =
	"These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/** A branch switch is visible to tools in this turn and commits with the
 * transcript in persistTurn. New graphs may be safely reused after an abort. */
export function planToolTurnStore(store: ChatStore): ChatStore {
	let activeGraphId: string | undefined;
	return {
		...store,
		getChat(id) {
			const record = store.getChat(id);
			return record && activeGraphId !== undefined
				? { ...record, activeGraphId: planGraphPath(record, activeGraphId).at(-1) }
				: record;
		},
		saveTree(id, tree) {
			store.saveTree(id, tree);
			if (activeGraphId === undefined) return;
			const record = store.getChat(id);
			if (record) activeGraphId = planGraphPath(record, activeGraphId).at(-1) ?? ROOT_PLAN_GRAPH_ID;
		},
		saveNestedPlanGraph(id, parentGraphId, parentNodeId, tree, activate) {
			const graphId = store.saveNestedPlanGraph(id, parentGraphId, parentNodeId, tree);
			if (activate) activeGraphId = graphId;
			return graphId;
		},
		saveActivePlanGraph(_id, graphId) { activeGraphId = graphId; },
	};
}

/**
 * The plan tool — AUTHOR-ONCE protocol (2026-09-03 design pass): the teacher
 * WRITES the map and never tracks progress. One tool, plan_init, takes the
 * whole dependency map as a mermaid `graph TD` block:
 *
 *   - call it ONCE right after the probe concludes, to present the map (the
 *     LEARNER'S ACCEPTANCE of the presented plan, not this call, ends
 *     planning — docs/archive/probe-teach-split.md §4)
 *   - statuses (current / visited / upcoming) are DERIVED from the quiz
 *     nodeId tags the teacher fires (contracts.ts derivePlanStatuses) — the
 *     teacher never declares them, and there is no "done" bookkeeping
 *   - re-call it any time the map is wrong: the new block replaces the tree
 *     wholesale. Node slugs are permanent — the map tracks nothing between
 *     rewrites
 *   - checks name the node they assess (quiz nodeId, validated against the
 *     live tree at the call boundary) — that tag is the only thing statuses
 *     derive from
 *
 * The former mutation tools (add/update/remove node/edge, set_current,
 * mark_done) are gone by design: restructuring is a rewrite, tracking is
 * derived. SERVER-SIDE with execute: parse → validate → persist. The
 * result is CONTEXT-SLIM (owner, context diet 2026-10-09): the model
 * WROTE the mermaid one message ago, so content never echoes the tree —
 * it carries the validated nodeIds + the binding-nodeId reminder (the
 * exact moment the ids become load-bearing); `details` keeps the full
 * tree for the record and the plan popup (latestTree reads it — the
 * agent-invisible channel, serializer-verified).
 */
const planInitInput = Type.Object({
	mermaid: Type.String({
		minLength: 1,
		description:
			"A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
			"The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId. " +
			"Titles are free single-line text; `-->` means 'from = prerequisite' (chains fine); no subgraphs, styles, or classes.",
	}),
});

const planEnterInput = Type.Object({
	nodeId: Type.String({ minLength: 1, description: "Node id in the active graph." }),
	goal: Type.String({ minLength: 1, maxLength: 600, description: "What the learner should be able to do after this branch." }),
	context: Type.String({ minLength: 1, maxLength: 3000, description: "Relevant learner goal, prerequisites, and established facts needed inside this branch." }),
	mermaid: Type.Optional(planInitInput.properties.mermaid),
});

const planLeaveInput = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 2000, description: "What the learner established, what is still uncertain, and any implications for the parent lesson." }),
});

function transitionResult(transition: PlanTransition) {
	return {
		text: transition.kind === "enter"
			? `Entered ${transition.topic}. Active graph id: ${transition.graph.id}.`
			: `Returned to plan graph ${transition.parentGraphId}. Result for ${transition.topic}: ${transition.summary}`,
		details: { ok: true, transition },
	};
}

export function planTools(ctx: PlanToolContext): Record<string, AgentTool<any>> {
	const { chatId, chatStore } = ctx;
	return {
		plan_init: {
			name: "plan_init",
			label: "plan_init",
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan window. " +
				"Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid graph block (any direction): one node per line (`slug[Short Title]` — slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), " +
				"`-->` edges meaning 'from must be understood before to' (chains fine). 5–15 nodes: a map, not a syllabus — one reasoning step per node, compress. " +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those tags.",
			parameters: planInitInput,
			execute: serverExecute("plan_init", planInitInput, async ({ mermaid }) => {
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					// No tree echo — the model needs the problems, not a restatement of
					// the map it is rewriting (owner, context diet 2026-10-09).
					return { ok: false, error: parsed.problems.join("\n") };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const next = createTree(parsed.plan.nodes, parsed.plan.edges);
					chatStore.saveTree(chatId, next);
					const activeGraphId = record.nestedPlanGraphs?.length
						? planGraphPath({ ...record, tree: next }).at(-1) : undefined;
					// Context diet: content = the validated nodeIds + the reminder (the
				// ids just became binding for every quiz/explain call); details =
					// the full tree for the record/UI — the plan popup's latestTree
					// seam, agent-invisible (the serializer sends content only).
					return {
						text: JSON.stringify({
							ok: true,
							nodeIds: next.nodes.map((n) => n.id),
							reminder: activeGraphId && activeGraphId !== ROOT_PLAN_GRAPH_ID
								? `These node ids are for the root plan. Continue asking questions in the active graph ${activeGraphId}.`
								: PLAN_NODE_IDS_REMINDER,
						}),
						details: { ok: true, tree: next, ...(activeGraphId ? { activeGraphId } : {}) },
					};
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message };
					throw err;
				}
			}),
		},
		plan_enter: {
			name: "plan_enter", label: "plan_enter", executionMode: "sequential",
			description: "Enter the child graph of a topic in the active plan. Supply Mermaid to create a new child graph, and omit Mermaid to reopen it. Call on its own before teaching inside the branch.",
			parameters: planEnterInput,
			execute: serverExecute("plan_enter", planEnterInput, ({ nodeId, goal, context, mermaid }) => {
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };
				const parentGraphId = planGraphPath(record).at(-1);
				const node = parentGraphId && planGraphTree(record, parentGraphId)?.nodes.find(entry => entry.id === nodeId);
				if (!parentGraphId || !node) return { ok: false, error: `Use a node in the active plan graph: ${nodeId}.` };
				if (!goal.trim() || !context.trim()) return { ok: false, error: "Provide a goal and the relevant context for this branch." };
				const existing = record.nestedPlanGraphs?.find(graph => graph.parentGraphId === parentGraphId && graph.parentNodeId === nodeId);
				if (existing) {
					chatStore.saveActivePlanGraph(chatId, existing.id);
					return transitionResult({ kind: "enter", graph: existing, topic: node.title, goal: goal.trim(), context: context.trim() });
				}
				if (!mermaid) return { ok: false, error: "Provide Mermaid for the new child graph." };
				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) return { ok: false, error: parsed.problems.join("\n") };
				try {
					const tree = createTree(parsed.plan.nodes, parsed.plan.edges);
					const id = chatStore.saveNestedPlanGraph(chatId, parentGraphId, nodeId, tree, true);
					return transitionResult({ kind: "enter", graph: { id, parentGraphId, parentNodeId: nodeId, tree }, topic: node.title, goal: goal.trim(), context: context.trim() });
				} catch (error) {
					if (error instanceof PlanTreeError) return { ok: false, error: error.message };
					throw error;
				}
			}),
		},
		plan_leave: {
			name: "plan_leave", label: "plan_leave", executionMode: "sequential",
			description: "Return to the parent plan after teaching a branch. Give a concise summary of what was established. Call on its own before continuing the parent lesson.",
			parameters: planLeaveInput,
			execute: serverExecute("plan_leave", planLeaveInput, ({ summary }) => {
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };
				const path = planGraphPath(record);
				const graph = record.nestedPlanGraphs?.find(entry => entry.id === path.at(-1));
				if (!graph) return { ok: false, error: "The root plan has no parent graph." };
				if (!summary.trim()) return { ok: false, error: "Summarize the branch before returning to its parent." };
				const topic = planGraphTree(record, graph.parentGraphId)?.nodes.find(node => node.id === graph.parentNodeId)?.title ?? graph.parentNodeId;
				chatStore.saveActivePlanGraph(chatId, graph.parentGraphId);
				return transitionResult({ kind: "leave", graphId: graph.id, parentGraphId: graph.parentGraphId, topic, summary: summary.trim() });
			}),
		},
	};
}
