import type { LhMessage } from "./native-messages.ts";
import { PLAN_TRANSITION_TOOLS, ROOT_PLAN_GRAPH_ID, readPlanTransition, type PlanToolResult } from "./contracts/plan.ts";
import { planGraphPath, planGraphTree, type SessionPlan } from "./plan-tree.ts";

/** The page seeds the persisted plan. Newly streamed and adopted tool results
 * bring the same snapshot forward without changing the learner's selection. */
export function liveSessionPlan(initial: SessionPlan, messages: readonly LhMessage[], initialResults: ReadonlySet<string>): SessionPlan {
	let plan = initial;
	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError || initialResults.has(message.toolCallId)) continue;
		if (message.toolName === "plan_init") {
			const result = message.details as PlanToolResult | undefined;
			if (result?.ok === true && Array.isArray(result.tree?.nodes) && Array.isArray(result.tree?.edges)) {
				plan = { ...plan, tree: result.tree, activeGraphId: result.activeGraphId ?? plan.activeGraphId };
			}
			continue;
		}
		if (!PLAN_TRANSITION_TOOLS.some(name => name === message.toolName)) continue;
		const transition = readPlanTransition(message.details);
		if (transition?.kind === "enter") {
			const graph = transition.graph;
			const existing = plan.nestedPlanGraphs ?? [];
			plan = { ...plan, activeGraphId: graph.id, nestedPlanGraphs: [...existing.filter(other => other.id !== graph.id), graph] };
		} else if (transition?.kind === "leave") {
			plan = { ...plan, activeGraphId: transition.parentGraphId };
		}
	}
	return plan;
}

export function displayedPlan(plan: SessionPlan, pinnedGraphId: string | null = null) {
	const path = planGraphPath(plan, pinnedGraphId ?? plan.activeGraphId);
	const graphId = path.at(-1) ?? ROOT_PLAN_GRAPH_ID;
	const breadcrumbs = path.map(id => {
		const graph = plan.nestedPlanGraphs?.find(entry => entry.id === id);
		const title = graph && planGraphTree(plan, graph.parentGraphId)?.nodes.find(node => node.id === graph.parentNodeId)?.title;
		return { id, title: title ?? "The plan" };
	});
	return { graphId, tree: planGraphTree(plan, graphId) ?? null, breadcrumbs };
}
