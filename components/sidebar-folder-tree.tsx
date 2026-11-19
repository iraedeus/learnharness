"use client";

import { useEffect, useRef, useState, type DOMAttributes, type MouseEvent, type ReactNode } from "react";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fuzzyScore } from "@/src/core";
import type { ChatListItem, ChatListResponse } from "@/src/core";
import { SourceDragRow } from "@/components/source-folder-tree";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";

type SidebarOrganization = NonNullable<ChatListResponse["organization"]>;
type SidebarFolder = SidebarOrganization["folders"][number];

export type SidebarTreeNode =
	| { kind: "folder"; folder: SidebarFolder; expanded: boolean; children: SidebarTreeNode[] }
	| { kind: "chat"; chat: ChatListItem };

export interface SidebarFolderView {
	roots: SidebarTreeNode[];
	/** Chat IDs in rendered order, excluding chats inside collapsed branches. */
	visibleChatIds: string[];
}

interface ChatEntry {
	chat: ChatListItem;
	/** Parent folder id, or null for the root level. */
	key: string | null;
	/** Title match score while searching; null for folder-only matches. */
	titleScore: number | null;
}

/**
 * The session list as a tree over the shared folders (chat-folders S03).
 * Pure: chats arrive kind-filtered in activity (snapshot) order; this owns
 * query matching, folder reveal and the visible-chat order the keyboard
 * walk follows. Only teaching chats live in folders — a practice chat is
 * always a root chat whatever its stored placement says.
 */
export function buildSidebarFolderView(
	chats: readonly ChatListItem[],
	organization: SidebarOrganization | null,
	query: string,
	expandedIds: ReadonlySet<string>,
	searchCollapsedIds: ReadonlySet<string>,
): SidebarFolderView {
	const q = query.trim();
	const searching = q !== "";

	/* No organization snapshot (or it refused the read): the list stays
	 * flat — the same fuzzy filter + score order the old `shown` memo had. */
	if (organization === null) {
		let ordered: readonly ChatListItem[] = chats;
		if (searching) {
			ordered = chats
				.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
				.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
				.sort((a, b) => b.score - a.score)
				.map((r) => r.c);
		}
		const roots: SidebarTreeNode[] = ordered.map((chat) => ({ kind: "chat", chat }));
		return { roots, visibleChatIds: ordered.map((c) => c.id) };
	}

	const folderById = new Map(organization.folders.map((f) => [f.id, f]));
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const folderParent = (f: SidebarFolder): string | null =>
		f.parentId !== null && folderById.has(f.parentId) ? f.parentId : null;

	/* A placement counts only when it names an existing folder — a missing
	 * entry, folderId null and an unknown id all read as root. */
	const chatFolder = (chat: ChatListItem): string | null => {
		if ((chat.kind ?? "teach") === "practice") return null;
		if (!Object.hasOwn(organization.placements, chat.id)) return null;
		const folderId = organization.placements[chat.id]?.folderId;
		return folderId != null && folderById.has(folderId) ? folderId : null;
	};

	/* presentIds: folders that render at all. Without a query every folder
	 * renders (empty and notes-only included). While searching a folder
	 * renders when it is revealed — its own or an ancestor's name
	 * fuzzy-matches — or when a matching chat lives anywhere below it;
	 * markBranch walks each seed's ancestor chain so the kept folders form
	 * connected branches. chatEntries: the chats that render, each with its
	 * parent key and — in search — the title score ordering its level. */
	const presentIds = new Set<string>();
	const chatEntries: ChatEntry[] = [];

	if (!searching) {
		for (const f of organization.folders) presentIds.add(f.id);
		for (const chat of chats) chatEntries.push({ chat, key: chatFolder(chat), titleScore: null });
	} else {
		const nameMatch = (f: SidebarFolder) => fuzzyScore(q, f.name) !== null;
		const revealedCache = new Map<string, boolean>();
		const isRevealed = (id: string): boolean => {
			const cached = revealedCache.get(id);
			if (cached !== undefined) return cached;
			const seen = new Set<string>();
			let result = false;
			let cur: string | null = id;
			while (cur !== null && !seen.has(cur)) {
				seen.add(cur);
				const f = folderById.get(cur);
				if (!f) break;
				if (nameMatch(f)) {
					result = true;
					break;
				}
				cur = folderParent(f);
			}
			revealedCache.set(id, result);
			return result;
		};
		const markBranch = (id: string) => {
			const seen = new Set<string>();
			let cur: string | null = id;
			while (cur !== null && !seen.has(cur)) {
				seen.add(cur);
				presentIds.add(cur);
				const f = folderById.get(cur);
				if (!f) break;
				cur = folderParent(f);
			}
		};

		for (const f of organization.folders) if (isRevealed(f.id)) markBranch(f.id);

		for (const chat of chats) {
			const titleScore = fuzzyScore(q, chat.title);
			const folderId = chatFolder(chat);
			const matches =
				(chat.kind ?? "teach") === "practice"
					? titleScore !== null
					: titleScore !== null || (folderId !== null && isRevealed(folderId));
			if (!matches) continue;
			if (folderId !== null) markBranch(folderId);
			chatEntries.push({ chat, key: folderId, titleScore });
		}
	}

	const presentFolders = organization.folders.filter((f) => presentIds.has(f.id));

	/* Each folder's tree parent. Corrupt cyclic folder data could otherwise
	 * close a loop in the emitted tree: a folder whose resolved parent is
	 * its own descendant falls back to the root level. chainHas walks the
	 * resolved parent chain with a seen-set. */
	const chainHas = (fromId: string, targetId: string): boolean => {
		const seen = new Set<string>();
		let cur: string | null = fromId;
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			if (cur === targetId) return true;
			const f = folderById.get(cur);
			cur = f ? folderParent(f) : null;
		}
		return false;
	};
	const parentKeyOf = new Map<string, string | null>();
	for (const f of presentFolders) {
		const p = folderParent(f);
		parentKeyOf.set(f.id, p !== null && presentIds.has(p) && !chainHas(p, f.id) ? p : null);
	}

	const chatsByKey = new Map<string | null, ChatEntry[]>();
	for (const e of chatEntries) {
		const list = chatsByKey.get(e.key) ?? [];
		list.push(e);
		chatsByKey.set(e.key, list);
	}

	type FolderNode = Extract<SidebarTreeNode, { kind: "folder" }>;
	const expandedOf = (f: SidebarFolder) => (searching ? !searchCollapsedIds.has(f.id) : expandedIds.has(f.id));

	const emitLevel = (key: string | null): SidebarTreeNode[] => {
		const folderNodes: FolderNode[] = [];
		for (const f of presentFolders) {
			if (parentKeyOf.get(f.id) !== key) continue;
			folderNodes.push({ kind: "folder", folder: f, expanded: expandedOf(f), children: emitLevel(f.id) });
		}
		folderNodes.sort((a, b) => collator.compare(a.folder.name, b.folder.name) || a.folder.id.localeCompare(b.folder.id));

		const levelChats = [...(chatsByKey.get(key) ?? [])];
		if (searching) {
			/* Title matches first by descending score, then chats present
			 * only through a revealed folder. Array#sort is stable, so equal
			 * scores and the folder-only tail keep input (activity) order. */
			levelChats.sort((a, b) => {
				if (a.titleScore === null && b.titleScore === null) return 0;
				if (a.titleScore === null) return 1;
				if (b.titleScore === null) return -1;
				return b.titleScore - a.titleScore;
			});
		}
		const chatNodes: SidebarTreeNode[] = levelChats.map((e) => ({ kind: "chat" as const, chat: e.chat }));
		return [...folderNodes, ...chatNodes];
	};

	const roots = emitLevel(null);

	/* Pre-order over the rendered order (folders first, then chats at each
	 * level); a collapsed ancestor hides everything below it. */
	const visibleChatIds: string[] = [];
	const collect = (nodes: readonly SidebarTreeNode[]) => {
		for (const n of nodes) {
			if (n.kind === "chat") {
				visibleChatIds.push(n.chat.id);
				continue;
			}
			if (n.expanded) collect(n.children);
		}
	};
	collect(roots);
	return { roots, visibleChatIds };
}

/** Next chat in the visible order: no current (or a stale one) lands on the
 *  dir's end of the list; otherwise step with wrap-around. */
export function nextKbdChat(visibleChatIds: readonly string[], current: string | null, dir: 1 | -1): string | null {
	if (visibleChatIds.length === 0) return null;
	const i = current === null ? -1 : visibleChatIds.indexOf(current);
	if (i === -1) return dir === 1 ? (visibleChatIds[0] ?? null) : (visibleChatIds[visibleChatIds.length - 1] ?? null);
	return visibleChatIds[(i + dir + visibleChatIds.length) % visibleChatIds.length] ?? null;
}

/** Enter target: the walked chat while it is still visible, else the first. */
export function enterKbdChat(visibleChatIds: readonly string[], current: string | null): string | null {
	if (visibleChatIds.length === 0) return null;
	if (current !== null && visibleChatIds.includes(current)) return current;
	return visibleChatIds[0] ?? null;
}

/**
 * The folder header's inline rename field (chat-folders S06): same commit
 * rules as the session RenameRow — Enter blurs into the commit, Escape
 * cancels, blur commits once (the finished guard makes Enter+blur and
 * repeated blurs single writes).
 */
function FolderRenameInput({
	folder,
	depth,
	onRename,
	onCancel,
}: {
	folder: SidebarFolder;
	depth: number;
	onRename: (folderId: string, name: string) => void;
	onCancel: () => void;
}): ReactNode {
	const [draft, setDraft] = useState(folder.name);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const finished = useRef(false);
	const interactions = useOptionalInteractionLayers();
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	const commit = () => {
		if (finished.current) return;
		finished.current = true;
		onRename(folder.id, draft);
	};
	return (
		<div className="py-1.5 pr-2" style={{ paddingLeft: 8 + depth * 12 + 20 }}>
			<input
				ref={inputRef}
				type="text"
				value={draft}
				spellCheck={false}
				data-testid="sidebar-folder-rename"
				aria-label="Folder name"
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						if (interactions && !interactions.isElementEligible(e.currentTarget)) return;
						interactions?.claimEscape(e);
						e.stopPropagation(); // discard, not also the sidebar/chat chains
						finished.current = true;
						onCancel();
					}
				}}
				className="lh-input h-6 w-full min-w-0 rounded-sm border border-border bg-background px-1.5 text-xs text-foreground outline-none"
			/>
		</div>
	);
}

/**
 * Renders the folder tree. Pure and SSR-safe: expansion arrives via the
 * view; folder rows are buttons named by the folder (aria-expanded), chat
 * rows render through the caller inside data-sidebar-chat wrappers.
 * folderDrag (S06) wraps each folder header in a SourceDragRow — the
 * caller passes it only in the normal tree (never while searching or
 * without an organization). renamingFolderId swaps that folder's header
 * button for the inline rename input; onFolderContextMenu receives the
 * header button's contextmenu event.
 */
export function SidebarFolderTree({
	view,
	onToggleFolder,
	renderChat,
	drop,
	folderDrag = false,
	renamingFolderId = null,
	onRenameFolder,
	onCancelRenameFolder,
	onFolderContextMenu,
}: {
	view: SidebarFolderView;
	onToggleFolder: (folderId: string) => void;
	renderChat: (chat: ChatListItem) => ReactNode;
	/** Drag & drop (chat-folders S05): folder headers become drop targets.
	 *  activeTarget mirrors the hook's dropTarget — undefined = no
	 *  highlight, null = Outside folders (handled by the caller's own
	 *  zone), a folder id highlights that header. */
	drop?: {
		activeTarget: string | null | undefined;
		targetProps: (target: string) => Partial<Pick<DOMAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">>;
	};
	/** S06: folder headers are also drag SOURCES (kind "folder"). */
	folderDrag?: boolean;
	/** S06: the folder whose header renders the inline rename input. */
	renamingFolderId?: string | null;
	onRenameFolder?: (folderId: string, name: string) => void;
	onCancelRenameFolder?: () => void;
	onFolderContextMenu?: (e: MouseEvent<HTMLButtonElement>, folder: SidebarFolder) => void;
}): ReactNode {
	const renderLevel = (nodes: readonly SidebarTreeNode[], depth: number): ReactNode =>
		nodes.map((node) => {
			if (node.kind === "chat") {
				return (
					<div key={node.chat.id} data-sidebar-chat={node.chat.id} style={{ paddingLeft: depth * 12 }}>
						{renderChat(node.chat)}
					</div>
				);
			}
			const { folder } = node;
			const renaming = renamingFolderId === folder.id;
			const header = renaming ? (
				<FolderRenameInput
					folder={folder}
					depth={depth}
					onRename={(id, name) => onRenameFolder?.(id, name)}
					onCancel={() => onCancelRenameFolder?.()}
				/>
			) : (
				<button
					type="button"
					data-sidebar-folder={folder.id}
					aria-expanded={node.expanded}
					onClick={() => onToggleFolder(folder.id)}
					onContextMenu={onFolderContextMenu ? (e) => onFolderContextMenu(e, folder) : undefined}
					{...(drop?.targetProps(folder.id) ?? {})}
					data-drop-active={drop ? String(drop.activeTarget === folder.id) : undefined}
					className={cn(
						"flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
						drop?.activeTarget === folder.id && "bg-accent/50",
					)}
					style={{ paddingLeft: 8 + depth * 12 }}
				>
					{node.expanded ? (
						<FolderOpenIcon className="size-3.5 shrink-0" aria-hidden />
					) : (
						<FolderIcon className="size-3.5 shrink-0" aria-hidden />
					)}
					<span className="min-w-0 flex-1 truncate">{folder.name}</span>
				</button>
			);
			return (
				<div key={folder.id} data-testid={`sidebar-folder-${folder.id}`}>
					{folderDrag && !renaming ? (
						<SourceDragRow kind="folder" id={folder.id} name={folder.name} enabled>
							{header}
						</SourceDragRow>
					) : (
						header
					)}
					{node.expanded && <div role="group">{renderLevel(node.children, depth + 1)}</div>}
				</div>
			);
		});
	return <>{renderLevel(view.roots, 0)}</>;
}
