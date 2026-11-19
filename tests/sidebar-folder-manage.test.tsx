/**
 * The inline folder rename inside SidebarFolderTree — the header swaps
 * to a text input that commits the typed name on Enter (via blur) or
 * blur, cancels on Escape, and never double-commits. Same linkedom
 * harness as commit-input.test.tsx: the globals land BEFORE react-dom
 * and the component are imported, or React's input-event polyfill
 * cannot map nodes to fibers.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ChatListItem } from "../src/core/index.ts";
import { chat, STAMP, type TestOrg } from "./helpers/sidebar-fixtures.ts";

const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
let active: Element = dom.document.body;
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });
const proto = dom.window.HTMLElement.prototype;
const oldFocus = Object.getOwnPropertyDescriptor(proto, "focus");
const oldBlur = Object.getOwnPropertyDescriptor(proto, "blur");
Object.defineProperty(proto, "focus", {
	configurable: true,
	writable: true,
	value(this: HTMLElement) {
		active = this;
		oldFocus?.value?.call(this);
	},
});
/* linkedom's blur() fires no event; React's onBlur listens for focusout —
   patch blur the way commit-input.test.tsx does so Enter → blur commits. */
Object.defineProperty(proto, "blur", {
	configurable: true,
	writable: true,
	value(this: HTMLElement) {
		active = dom.document.body;
		this.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
	},
});
dom.window.HTMLInputElement.prototype.select = function () {};
Object.assign(globalThis, {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	Element: dom.window.Element,
	Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0 }),
});
after(() => {
	if (oldFocus) Object.defineProperty(proto, "focus", oldFocus);
	else Reflect.deleteProperty(proto, "focus");
	if (oldBlur) Object.defineProperty(proto, "blur", oldBlur);
	else Reflect.deleteProperty(proto, "blur");
});

const ORG: TestOrg = {
	folders: [
		{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
		{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
	],
	placements: {},
};
const CHATS: ChatListItem[] = [chat("c1", { title: "Loose chat" })];

/* Imported lazily inside mount(): react-dom and the component must see
   the linkedom globals at module-eval time (commit-input's rule). */
let createRoot: typeof import("react-dom/client").createRoot;
let buildSidebarFolderView: typeof import("../components/sidebar-folder-tree.tsx").buildSidebarFolderView;
let SidebarFolderTree: typeof import("../components/sidebar-folder-tree.tsx").SidebarFolderTree;
let loaded = false;
async function load() {
	if (loaded) return;
	({ createRoot } = await import("react-dom/client"));
	({ buildSidebarFolderView, SidebarFolderTree } = await import("../components/sidebar-folder-tree.tsx"));
	loaded = true;
}

let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement | undefined;
let commits: Array<{ id: string; name: string }>;
let cancels: number;

/* The rename stays "open" after a commit so a stray second blur can prove
   the once-guard; only Escape clears it. */
function Harness() {
	const [renaming, setRenaming] = useState<string | null>("alg");
	const view = buildSidebarFolderView(CHATS, ORG, "", new Set(["alg", "maps"]), new Set());
	return (
		<SidebarFolderTree
			view={view}
			onToggleFolder={() => {}}
			renderChat={(c) => <span>{c.title}</span>}
			renamingFolderId={renaming}
			onRenameFolder={(id, name) => {
				commits.push({ id, name });
			}}
			onCancelRenameFolder={() => {
				cancels++;
				setRenaming(null);
			}}
		/>
	);
}

async function mount() {
	await load();
	commits = [];
	cancels = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<Harness />);
	});
}
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	host?.remove();
});

function renameInput(): HTMLInputElement {
	const input = document.querySelector<HTMLInputElement>('[data-testid="sidebar-folder-rename"]');
	assert.ok(input, "the rename input is mounted");
	return input;
}

async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		input.focus();
		/* The prototype setter bypasses React's per-instance value tracker —
		   a plain `input.value =` would sync the tracker and onChange would
		   never fire (popup-interaction-layers' rule). */
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

async function key(input: HTMLInputElement, keyName: string) {
	await act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: keyName });
		input.dispatchEvent(event);
	});
}

async function blur(input: HTMLInputElement) {
	await act(async () => {
		input.blur();
	});
}

it("the renamed folder has no header button while its sibling keeps one", async () => {
	await mount();
	assert.equal(document.querySelector('[data-sidebar-folder="alg"]'), null, "the renamed folder's header is gone");
	assert.ok(document.querySelector('[data-sidebar-folder="maps"]'), "the sibling header is unchanged");
});

it("Enter commits the typed name exactly once — the blur it triggers cannot double-commit", async () => {
	await mount();
	const input = renameInput();
	assert.equal(input.value, "Algebra", "the input starts with the current name");
	assert.equal(input.getAttribute("aria-label"), "Folder name");

	await type(input, "Algebra II");
	await key(input, "Enter");
	assert.deepEqual(commits, [{ id: "alg", name: "Algebra II" }]);

	await blur(input);
	assert.equal(commits.length, 1, "a second blur after Enter commits nothing more");
	assert.equal(cancels, 0);
});

it("Escape cancels without committing and unmounts the input", async () => {
	await mount();
	const input = renameInput();
	await type(input, "Changed");
	await key(input, "Escape");
	assert.equal(cancels, 1);
	assert.deepEqual(commits, []);
	assert.equal(document.querySelector('[data-testid="sidebar-folder-rename"]'), null);
});

it("blur commits the typed name exactly once", async () => {
	await mount();
	const input = renameInput();
	await type(input, "Blurred name");
	await blur(input);
	assert.deepEqual(commits, [{ id: "alg", name: "Blurred name" }]);

	await blur(input);
	assert.equal(commits.length, 1, "repeated blurs cannot commit twice");
	assert.equal(cancels, 0);
});
