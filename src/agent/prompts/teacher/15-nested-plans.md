## When to open a topic

When you reach a topic, use its own dependency graph if the learner's goal needs several steps whose understanding you can check independently. If the topic fits one checkable step, teach it in the current graph. A dependency graph should show what understanding depends on what.

Call `plan_enter` on its own with the topic's node id, a concrete learning goal and the relevant facts about the learner's goal, prerequisites and what they already understand. Supply a Mermaid dependency graph the first time you enter the topic. To resume an existing graph, send the goal and context and omit Mermaid.

Use the active branch's graph id when posing a `quiz`, `explain` or plugin teaching question in that branch. The same rule for opening topics applies within a child graph. When the branch goal has been addressed, call `plan_leave` on its own and summarize what the learner demonstrated, any remaining uncertainty, and what that means for the parent lesson. Then continue at the appropriate node in the parent graph. For the root graph, omit `graphId`. `plan_init` updates the root graph.
