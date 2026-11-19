/**
 * The pure half of the sidebar's folder writes: target/path planning
 * against the freshest organization snapshot, the POST/DELETE command
 * channel, the one-write-at-a-time serializer, and the SSR-pinned dialog
 * bodies. Same tsx classic-JSX shim as sidebar-folder-tree.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createFolderWriter,
	currentChatFolder,
	deleteFolderSelection,
	deleteSources,
	folderMoveTargets,
	folderPath,
	folderTargets,
	MoveTargetBody,
	NewFolderBody,
	planCreateFolder,
	planMoveChat,
	planMoveFolder,
	planRenameFolder,
	postFolderCommand,
	readDragPayload,
	type FolderCommand,
	type FolderWriteResult,
} from "../components/sidebar-folder-actions.tsx";
import type { SourceDirectory } from "../src/core/index.ts";
import { chat, STAMP, type TestOrg } from "./helpers/sidebar-fixtures.ts";

/* Shared fixture: Algebra → Maps nesting, a notes-only folder, and chats
 * placed at each level plus a practice chat inside Algebra. */
const ORG: TestOrg = {
	folders: [
		{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
		{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
		{ id: "notes", name: "Notes only", parentId: null, createdAt: STAMP },
	],
	placements: {
		c_alg: { folderId: "alg" },
		c_maps: { folderId: "maps" },
		c_prac: { folderId: "alg" },
	},
};

const AMBIGUOUS =
	"Could not confirm the folder change. The list was refreshed; try again if it is still needed.";

describe("folderTargets", () => {
	it("lists Outside folders first, then every folder by full-path label in collator order", () => {
		const org: TestOrg = {
			folders: [
				{ id: "f10", name: "folder 10", parentId: null, createdAt: STAMP },
				{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
				{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
				{ id: "f2", name: "Folder 2", parentId: null, createdAt: STAMP },
			],
			placements: {},
		};
		const targets = folderTargets(org);
		assert.deepEqual(
			targets.map((t) => t.label),
			["Outside folders", "Algebra", "Algebra / Maps", "Folder 2", "folder 10"],
			"numeric + case-insensitive collator: Folder 2 before folder 10",
		);
		assert.equal(targets[0]?.id, null);
		assert.equal(targets.find((t) => t.label === "Algebra / Maps")?.id, "maps");
	});

	it("two folders with the same full path each get the 6-char id suffix; same name under different parents does not", () => {
		const org: TestOrg = {
			folders: [
				{ id: "dup-000001", name: "Same", parentId: null, createdAt: STAMP },
				{ id: "dup-000002", name: "Same", parentId: null, createdAt: STAMP },
				{ id: "p1", name: "Parent", parentId: null, createdAt: STAMP },
				{ id: "p2", name: "Other", parentId: null, createdAt: STAMP },
				{ id: "k1", name: "Kid", parentId: "p1", createdAt: STAMP },
				{ id: "k2", name: "Kid", parentId: "p2", createdAt: STAMP },
			],
			placements: {},
		};
		const labels = folderTargets(org).map((t) => t.label);
		assert.ok(labels.includes("Same (000001)"), `expected the id-suffixed label, got ${labels.join(", ")}`);
		assert.ok(labels.includes("Same (000002)"));
		assert.ok(labels.includes("Parent / Kid"));
		assert.ok(labels.includes("Other / Kid"));
		assert.ok(!labels.some((l) => l.includes("Kid (")), "distinct full paths need no suffix");
	});
});

describe("folderPath", () => {
	it("returns root-to-leaf ids; [] for null or unknown; an unknown parent reads as root", () => {
		assert.deepEqual(folderPath(ORG, null), []);
		assert.deepEqual(folderPath(ORG, "ghost"), []);
		assert.deepEqual(folderPath(ORG, "alg"), ["alg"]);
		assert.deepEqual(folderPath(ORG, "maps"), ["alg", "maps"]);

		const dangling: TestOrg = {
			folders: [{ id: "x", name: "X", parentId: "ghost", createdAt: STAMP }],
			placements: {},
		};
		assert.deepEqual(folderPath(dangling, "x"), ["x"], "an unknown parent reads as root-level");
	});
});

describe("currentChatFolder", () => {
	it("mirrors the tree's placement rule: existing folder id, else null; practice always null", () => {
		assert.equal(currentChatFolder(ORG, chat("c_alg")), "alg");
		assert.equal(currentChatFolder(ORG, chat("c_maps")), "maps");
		assert.equal(currentChatFolder(ORG, chat("c_none")), null, "no placement entry");

		const org: TestOrg = {
			folders: ORG.folders,
			placements: { c_null: { folderId: null }, c_ghost: { folderId: "ghost" } },
		};
		assert.equal(currentChatFolder(org, chat("c_null")), null, "explicit folderId null");
		assert.equal(currentChatFolder(org, chat("c_ghost")), null, "unknown folder id");
		assert.equal(currentChatFolder(ORG, chat("c_prac", { kind: "practice" })), null, "practice never folders");
	});
});

describe("readDragPayload", () => {
	it("parses source/folder payloads; anything else is null", () => {
		assert.deepEqual(readDragPayload(JSON.stringify({ kind: "source", id: "c1" })), { kind: "source", id: "c1" });
		assert.deepEqual(readDragPayload(JSON.stringify({ kind: "folder", id: "f1" })), { kind: "folder", id: "f1" });
		for (const raw of [
			"null",
			"3",
			'"text"',
			"{",
			JSON.stringify({ kind: "source" }),
			JSON.stringify({ kind: "source", id: "" }),
			JSON.stringify({ kind: "other", id: "x" }),
		]) {
			assert.equal(readDragPayload(raw), null, raw);
		}
	});
});

describe("planCreateFolder", () => {
	it("rejects a blank name and an unknown parent; otherwise commands with the trimmed name", () => {
		assert.deepEqual(planCreateFolder(ORG, "   ", null), { kind: "error", error: "Enter a folder name." });
		assert.deepEqual(planCreateFolder(ORG, "New", "ghost"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planCreateFolder(ORG, "  Algebra II  ", null), {
			kind: "command",
			command: { action: "create-folder", name: "Algebra II", parentId: null },
		});
		assert.deepEqual(planCreateFolder(ORG, "Inner", "alg"), {
			kind: "command",
			command: { action: "create-folder", name: "Inner", parentId: "alg" },
		});
	});
});

describe("planMoveChat", () => {
	it("rejects missing/practice/unknown-target, skips the current folder, else commands the move", () => {
		const chats = [chat("c_root"), chat("c_alg"), chat("c_prac", { kind: "practice" })];
		assert.deepEqual(planMoveChat(ORG, chats, "ghost", null), {
			kind: "error",
			error: "This session no longer exists.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_prac", "alg"), {
			kind: "error",
			error: "Practice sessions stay outside folders.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", "ghost"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", null), { kind: "skip" }, "root → root is a no-op");
		assert.deepEqual(planMoveChat(ORG, chats, "c_alg", "alg"), { kind: "skip" }, "same folder is a no-op");
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", "alg"), {
			kind: "command",
			command: { action: "move", kind: "source", id: "c_root", parentId: "alg" },
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_alg", null), {
			kind: "command",
			command: { action: "move", kind: "source", id: "c_alg", parentId: null },
		});
	});
});

describe("postFolderCommand", () => {
	it("POSTs the command as JSON to /api/graph/sources; a readable 2xx body is ok, an unreadable one a failure", async () => {
		const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ createdFolderId: "folder_new_1" }), { status: 200 });
		};
		const command: FolderCommand = { action: "create-folder", name: "Maps", parentId: "alg" };
		const result = await postFolderCommand(command, fetchImpl);
		assert.deepEqual(result, { ok: true });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "/api/graph/sources");
		assert.equal(calls[0]?.init?.method, "POST");
		assert.deepEqual(calls[0]?.init?.headers, { "Content-Type": "application/json" });
		assert.equal(calls[0]?.init?.body, JSON.stringify(command));

		const unreadable: typeof fetch = async () => new Response("not json", { status: 200 });
		assert.deepEqual(await postFolderCommand(command, unreadable), { ok: false, error: AMBIGUOUS });
	});

	it("400 surfaces the server's error as a definite rejection; a missing error field uses the default", async () => {
		const command: FolderCommand = { action: "move", kind: "source", id: "c1", parentId: null };
		const rejected: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "Parent folder no longer exists." }), { status: 400 });
		assert.deepEqual(await postFolderCommand(command, rejected), {
			ok: false,
			error: "Parent folder no longer exists.",
		});

		const noMessage: typeof fetch = async () => new Response(JSON.stringify({}), { status: 400 });
		assert.deepEqual(await postFolderCommand(command, noMessage), {
			ok: false,
			error: "The folder change was rejected.",
		});
	});

	it("500 and a thrown fetch fail with the confirm-failure text", async () => {
		const command: FolderCommand = { action: "create-folder", name: "X", parentId: null };
		const serverError: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "Could not save source organization." }), { status: 500 });
		const result = await postFolderCommand(command, serverError);
		assert.deepEqual(result, { ok: false, error: AMBIGUOUS });

		const thrown: typeof fetch = async () => {
			throw new Error("network down");
		};
		assert.deepEqual(await postFolderCommand(command, thrown), result);
	});
});

describe("createFolderWriter", () => {
	it("rejects a second write while one is in flight, then accepts the next after it settles", async () => {
		const posted: FolderCommand[] = [];
		const resolvers: Array<(r: FolderWriteResult) => void> = [];
		const writer = createFolderWriter({
			post: (command) => {
				posted.push(command);
				return new Promise<FolderWriteResult>((resolve) => resolvers.push(resolve));
			},
			afterWrite: () => {},
		});
		const cmd1: FolderCommand = { action: "create-folder", name: "One", parentId: null };
		const cmd2: FolderCommand = { action: "create-folder", name: "Two", parentId: null };
		const cmd3: FolderCommand = { action: "create-folder", name: "Three", parentId: null };

		const first = writer.write(cmd1);
		const second = writer.write(cmd2);
		assert.deepEqual(await second, {
			ok: false,
			error: "Another folder change is still saving.",
		});
		assert.equal(posted.length, 1, "the overlapping write never reached post");

		resolvers[0]?.({ ok: true });
		assert.deepEqual(await first, { ok: true });

		const third = writer.write(cmd3);
		resolvers[1]?.({ ok: true });
		assert.deepEqual(await third, { ok: true });
		assert.deepEqual(posted, [cmd1, cmd3], "the next write posts once the first settled");
	});

	it("passes the command and result to afterWrite after success and failure", async () => {
		const seen: Array<{ command: FolderCommand; result: FolderWriteResult }> = [];
		const writer = createFolderWriter({
			post: async (command) =>
				command.action === "create-folder" && command.name === "Bad"
					? { ok: false, error: "nope" }
					: { ok: true },
			afterWrite: (command, result) => {
				seen.push({ command, result });
			},
		});
		const good: FolderCommand = { action: "create-folder", name: "Good", parentId: null };
		const bad: FolderCommand = { action: "create-folder", name: "Bad", parentId: null };
		await writer.write(good);
		await writer.write(bad);
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0], { command: good, result: { ok: true } });
		assert.deepEqual(seen[1], { command: bad, result: { ok: false, error: "nope" } });
	});
});

/* SSR pins read markup, not DOM: these pull one element's opening tag or
   a select's options by data-testid. */
function openingTag(html: string, testId: string): string | null {
	return html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;
}
function selectOptions(html: string, testId: string): Array<{ value: string; label: string }> {
	const select = html.match(new RegExp(`<select[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</select>`));
	if (!select) return [];
	return [...(select[1] ?? "").matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({
		value: m[1] ?? "",
		label: m[2] ?? "",
	}));
}

describe("NewFolderBody", () => {
	const targets = folderTargets(ORG);
	const render = (props: Partial<Parameters<typeof NewFolderBody>[0]> = {}) =>
		renderToStaticMarkup(
			<NewFolderBody
				name=""
				parentId={null}
				targets={targets}
				busy={false}
				error={null}
				onName={() => {}}
				onParent={() => {}}
				onCancel={() => {}}
				onCreate={() => {}}
				{...props}
			/>,
		);

	it("renders the labelled fields and one option per target, gates Create on a non-blank name, pins busy and error", () => {
		const html = render();
		assert.ok(html.includes('data-testid="new-folder-dialog"'));
		assert.ok(html.includes('aria-label="New folder"'));
		assert.match(html, /<label[^>]*for="new-folder-name"[^>]*>\s*Name\s*<\/label>/, "the Name input is labelled");
		assert.ok(openingTag(html, "new-folder-name") !== null);
		assert.match(html, /<label[^>]*for="new-folder-parent"[^>]*>\s*Parent folder\s*<\/label>/);

		const options = selectOptions(html, "new-folder-parent");
		assert.equal(options.length, targets.length, "one option per target");
		assert.equal(options[0]?.value, "");
		assert.equal(options[0]?.label, "Outside folders");
		assert.ok(options.some((o) => o.value === "maps" && o.label === "Algebra / Maps"));

		const create = openingTag(html, "new-folder-create");
		assert.ok(create?.includes('disabled=""'), "blank name keeps Create disabled");
		assert.ok(html.includes(">Create</button>"));

		const named = render({ name: "Maps" });
		const createNamed = openingTag(named, "new-folder-create");
		assert.ok(createNamed && !createNamed.includes('disabled=""'), "a name enables Create");

		const busy = render({ name: "Maps", busy: true });
		assert.ok(busy.includes("Creating…"));
		assert.ok(openingTag(busy, "new-folder-cancel")?.includes('disabled=""'), "Cancel is disabled while busy");
		assert.ok(openingTag(busy, "new-folder-create")?.includes('disabled=""'));

		const failed = render({ error: "That folder no longer exists." });
		assert.ok(failed.includes('role="alert"'));
		assert.ok(failed.includes('data-testid="new-folder-error"'));
		assert.ok(failed.includes("That folder no longer exists."));
	});
});

describe("MoveTargetBody", () => {
	const targets = folderTargets(ORG);
	const render = (props: Partial<Parameters<typeof MoveTargetBody>[0]> = {}) =>
		renderToStaticMarkup(
			<MoveTargetBody
				title="Linear maps"
				currentId="alg"
				targetId="alg"
				targets={targets}
				busy={false}
				error={null}
				onTarget={() => {}}
				onCancel={() => {}}
				onMove={() => {}}
				{...props}
			/>,
		);

	it("shows the title and current folder, lists every target, and gates Move on a real change — one body serves chat and folder moves", () => {
		const html = render();
		assert.ok(html.includes('data-testid="move-chat-dialog"'));
		assert.ok(html.includes('aria-label="Move to folder"'));
		assert.ok(html.includes("Linear maps"), "the subject title renders");

		const current = html.match(/<p[^>]*data-testid="move-chat-current"[^>]*>([\s\S]*?)<\/p>/);
		assert.ok(current, "the current-folder line renders");
		assert.ok(current[1]?.includes("Currently in:"), "it is labelled");
		assert.ok(current[1]?.includes("Algebra"), "the current folder's label");

		const options = selectOptions(html, "move-chat-target");
		assert.equal(options.length, targets.length, "Outside folders plus every folder path");
		assert.equal(options[0]?.value, "");
		assert.equal(options[0]?.label, "Outside folders");
		assert.ok(options.some((o) => o.value === "maps" && o.label === "Algebra / Maps"));
		assert.match(html, /<label[^>]*for="move-chat-target"[^>]*>\s*Folder\s*<\/label>/);

		const move = openingTag(html, "move-chat-confirm");
		assert.ok(move?.includes('disabled=""'), "target === current keeps Move disabled");
		assert.ok(html.includes(">Move</button>"));

		const changed = render({ targetId: "maps" });
		const moveChanged = openingTag(changed, "move-chat-confirm");
		assert.ok(moveChanged && !moveChanged.includes('disabled=""'), "a different target enables Move");

		const busy = render({ targetId: "maps", busy: true, error: "Practice sessions stay outside folders." });
		assert.ok(busy.includes("Moving…"));
		assert.ok(busy.includes('role="alert"'));
		assert.ok(busy.includes('data-testid="move-chat-error"'));
		assert.ok(busy.includes("Practice sessions stay outside folders."));
	});
});

describe("folderMoveTargets", () => {
	it("drops the folder itself and every descendant, keeps Outside folders and unrelated folders", () => {
		assert.deepEqual(
			folderMoveTargets(ORG, "alg").map((t) => t.label),
			["Outside folders", "Notes only"],
			"Algebra and its descendant Maps are both gone",
		);
		assert.deepEqual(
			folderMoveTargets(ORG, "maps").map((t) => t.id),
			[null, "alg", "notes"],
			"the parent stays a target — the dialog disables confirming it, like the chat move",
		);

		const deep: TestOrg = {
			folders: [
				{ id: "a", name: "A", parentId: null, createdAt: STAMP },
				{ id: "b", name: "B", parentId: "a", createdAt: STAMP },
				{ id: "c", name: "C", parentId: "b", createdAt: STAMP },
				{ id: "z", name: "Z", parentId: null, createdAt: STAMP },
			],
			placements: {},
		};
		assert.deepEqual(
			folderMoveTargets(deep, "a").map((t) => t.id),
			[null, "z"],
			"grandchildren are excluded too",
		);
	});
});

describe("planMoveFolder", () => {
	it("rejects an unknown folder or target, rejects moving into itself or a descendant", () => {
		assert.deepEqual(planMoveFolder(ORG, "ghost", null), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planMoveFolder(ORG, "alg", "ghost"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planMoveFolder(ORG, "alg", "alg"), {
			kind: "error",
			error: "A folder cannot be moved into itself or its descendants.",
		});
		assert.deepEqual(planMoveFolder(ORG, "alg", "maps"), {
			kind: "error",
			error: "A folder cannot be moved into itself or its descendants.",
		});
	});

	it("skips a move to the current parent — root → null included — and commands a real move", () => {
		assert.deepEqual(planMoveFolder(ORG, "alg", null), { kind: "skip" }, "root → Outside folders is a no-op");
		assert.deepEqual(planMoveFolder(ORG, "maps", "alg"), { kind: "skip" }, "same parent is a no-op");
		assert.deepEqual(planMoveFolder(ORG, "alg", "notes"), {
			kind: "command",
			command: { action: "move", kind: "folder", id: "alg", parentId: "notes" },
		});
		assert.deepEqual(planMoveFolder(ORG, "maps", null), {
			kind: "command",
			command: { action: "move", kind: "folder", id: "maps", parentId: null },
		});

		const dangling: TestOrg = {
			folders: [{ id: "x", name: "X", parentId: "ghost", createdAt: STAMP }],
			placements: {},
		};
		assert.deepEqual(planMoveFolder(dangling, "x", null), { kind: "skip" }, "an unknown parent reads as null");
		assert.deepEqual(planMoveFolder(dangling, "x", "x"), {
			kind: "error",
			error: "A folder cannot be moved into itself or its descendants.",
		});
	});
});

describe("planRenameFolder", () => {
	it("rejects an unknown folder, skips blank or unchanged names, commands a trimmed rename", () => {
		assert.deepEqual(planRenameFolder(ORG, "ghost", "New"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planRenameFolder(ORG, "alg", "   "), { kind: "skip" }, "blank cancels without a write");
		assert.deepEqual(planRenameFolder(ORG, "alg", "  Algebra  "), { kind: "skip" }, "same name after trim is a no-op");
		assert.deepEqual(planRenameFolder(ORG, "alg", "  Algebra II "), {
			kind: "command",
			command: { action: "rename-folder", id: "alg", name: "Algebra II" },
		});
	});
});

describe("deleteFolderSelection", () => {
	/* A Chains-shaped directory: nested folders, a notes source and a
	   practice chat placed inside — Chains hides it, so the folder delete
	   must not offer it either. */
	const DIRECTORY: SourceDirectory = {
		organization: {
			version: 1,
			folders: [
				{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
				{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
				{ id: "notes", name: "Notes", parentId: null, createdAt: STAMP },
			],
			placements: {
				c_alg: { folderId: "alg" },
				c_maps: { folderId: "maps" },
				c_prac: { folderId: "maps" },
				n1: { folderId: "alg" },
				out: { folderId: null },
			},
		},
		sources: [
			{ id: "c_alg", kind: "chat", label: "Algebra chat", createdAt: STAMP },
			{ id: "c_maps", kind: "chat", label: "Maps chat", createdAt: STAMP },
			{ id: "c_prac", kind: "chat", chatKind: "practice", label: "Practice", createdAt: STAMP },
			{ id: "n1", kind: "notes", label: "A note", createdAt: STAMP },
			{ id: "out", kind: "notes", label: "Outside note", createdAt: STAMP },
			{ id: "root", kind: "notes", label: "Root note", createdAt: STAMP },
		],
	};

	it("collects the folder's and its descendants' visible sources plus the descendant folders, in order", () => {
		const selection = deleteFolderSelection(DIRECTORY, "alg");
		assert.deepEqual(
			selection.sources.map((s) => s.id),
			["c_alg", "c_maps", "n1"],
			"teaching chats in alg and its descendant maps, plus the notes source — the hidden practice chat and outside sources stay out",
		);
		assert.deepEqual(
			selection.folders.map((f) => f.id),
			["alg", "maps"],
			"the folder itself and its descendants in organization order",
		);
		assert.equal(selection.sources.find((s) => s.id === "c_prac"), undefined);
	});
});

describe("deleteSources", () => {
	const request = { sourceIds: ["a", "b"], folderIds: ["f"], deleteSessions: true };

	it("DELETEs /api/graph/sources with the exact JSON and returns the graph revision", async () => {
		const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			calls.push({ url, init });
			return Response.json({ sources: [], organization: { version: 1, folders: [], placements: {} }, graphRevision: 42 });
		};
		const result = await deleteSources(request, fetchImpl);
		assert.deepEqual(result, { graphRevision: 42 });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "/api/graph/sources");
		assert.equal(calls[0]?.init?.method, "DELETE");
		assert.deepEqual(calls[0]?.init?.headers, { "Content-Type": "application/json" });
		assert.equal(calls[0]?.init?.body, JSON.stringify(request));

		const noRevision: typeof fetch = async () => Response.json({ sources: [] });
		assert.deepEqual(await deleteSources(request, noRevision), { graphRevision: undefined });
	});

	it("any failure — a non-ok status, a thrown fetch or an unreadable body — throws the server message or the fallback", async () => {
		const withMessage: typeof fetch = async () => Response.json({ error: "Folder is not empty." }, { status: 500 });
		await assert.rejects(deleteSources(request, withMessage), /^Error: Folder is not empty\.$/);

		const noMessage: typeof fetch = async () => Response.json({}, { status: 500 });
		await assert.rejects(deleteSources(request, noMessage), /^Error: Could not delete sources\.$/);

		const thrown: typeof fetch = async () => {
			throw new Error("network down");
		};
		await assert.rejects(deleteSources(request, thrown), /^Error: Could not delete sources\.$/);

		const unreadable: typeof fetch = async () => new Response("not json", { status: 200 });
		await assert.rejects(deleteSources(request, unreadable), /^Error: Could not delete sources\.$/);
	});
});
