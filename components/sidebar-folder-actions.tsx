"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { HostDialog } from "@/components/host-dialog";
import { SOURCE_DRAG_TYPE } from "@/components/source-folder-tree";
import {
	canMoveFolder,
	chainSourceDirectory,
	folderEntries,
	type ChatListItem,
	type ChatListResponse,
	type SourceDirectory,
	type SourceEntry,
	type SourceFolder,
	type SourceOrganization,
} from "@/src/core";

export type SidebarOrganization = NonNullable<ChatListResponse["organization"]>;
export type SidebarFolder = SidebarOrganization["folders"][number];

export interface FolderTarget {
	id: string | null;
	label: string;
}

export type FolderCommand =
	| { action: "create-folder"; name: string; parentId: string | null }
	| { action: "move"; kind: "source"; id: string; parentId: string | null }
	| { action: "move"; kind: "folder"; id: string; parentId: string | null }
	| { action: "rename-folder"; id: string; name: string };

export type FolderPlan =
	| { kind: "command"; command: FolderCommand }
	| { kind: "skip" }
	| { kind: "error"; error: string };

export type FolderWriteResult = { ok: true } | { ok: false; error: string };

/** Shared with the dialogs: the pre-send planner's "target vanished" text —
 *  the wrappers reset the selection to Outside folders on exactly this. */
const FOLDER_GONE_MESSAGE = "That folder no longer exists.";
const FOLDER_WRITE_AMBIGUOUS =
	"Could not confirm the folder change. The list was refreshed; try again if it is still needed.";

const folderIndex = (organization: SidebarOrganization): Map<string, SidebarFolder> =>
	new Map(organization.folders.map((f) => [f.id, f]));

/** A folder's parent id, or null when it sits at the root — a parentId
 *  naming no folder reads as root (the store rejects cycles and dangling
 *  parents on read, so the client never sees either). */
export const folderParentId = (folderById: Map<string, SidebarFolder>, f: SidebarFolder): string | null =>
	f.parentId !== null && folderById.has(f.parentId) ? f.parentId : null;

/** The folder's ancestor chain root → leaf ([] for an unknown id). */
export function folderChain(folderById: Map<string, SidebarFolder>, id: string): SidebarFolder[] {
	const chain: SidebarFolder[] = [];
	for (let cur = folderById.get(id); cur !== undefined;) {
		chain.unshift(cur);
		const p = folderParentId(folderById, cur);
		cur = p === null ? undefined : folderById.get(p);
	}
	return chain;
}

/**
 * The move/create picker's options: "Outside folders" (id null) first,
 * then every folder labelled by its full path, sorted by the
 * base/numeric collator on that path, ties by id. Folders sharing one
 * full path each get a ` (${id.slice(-6)})` suffix so the picker can
 * tell them apart; sorting keys on the unsuffixed path so duplicates
 * stay adjacent.
 */
export function folderTargets(organization: SidebarOrganization): FolderTarget[] {
	const folderById = folderIndex(organization);
	const pathOf = new Map<string, string>();
	for (const f of organization.folders) {
		pathOf.set(f.id, folderChain(folderById, f.id).map((x) => x.name).join(" / "));
	}

	const pathCount = new Map<string, number>();
	for (const label of pathOf.values()) pathCount.set(label, (pathCount.get(label) ?? 0) + 1);

	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const folders = [...organization.folders].sort((a, b) => {
		const byLabel = collator.compare(pathOf.get(a.id) ?? "", pathOf.get(b.id) ?? "");
		return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
	});
	return [
		{ id: null, label: "Outside folders" },
		...folders.map((f) => {
			const path = pathOf.get(f.id) ?? f.name;
			return { id: f.id, label: (pathCount.get(path) ?? 0) > 1 ? `${path} (${f.id.slice(-6)})` : path };
		}),
	];
}

/** The sidebar snapshot carries the same folders/placements as the Chains
 *  directory minus the version stamp canMoveFolder's state type wants. */
const asSourceOrganization = (organization: SidebarOrganization): SourceOrganization => ({
	version: 1,
	folders: organization.folders,
	placements: organization.placements,
});

/** folderTargets minus the folder itself and its descendants — canMoveFolder
 *  rejects exactly those targets, so the current parent stays listed and
 *  the dialog disables confirming it. */
export function folderMoveTargets(organization: SidebarOrganization, folderId: string): FolderTarget[] {
	const state = asSourceOrganization(organization);
	return folderTargets(organization).filter((t) => t.id === null || canMoveFolder(state, folderId, t.id));
}

/**
 * Folder IDs from the root down to folderId inclusive — the chain the
 * sidebar expands after a write so the target is visible. [] for null or
 * an unknown id.
 */
export function folderPath(organization: SidebarOrganization, folderId: string | null): string[] {
	if (folderId === null) return [];
	return folderChain(folderIndex(organization), folderId).map((f) => f.id);
}

/** The folder a chat currently renders in: practice chats are always at
 *  the root, a placement counts only when it names an existing folder,
 *  and a missing entry, folderId null or an unknown id all read as root. */
export function currentChatFolder(organization: SidebarOrganization, chat: ChatListItem): string | null {
	if ((chat.kind ?? "teach") === "practice") return null;
	if (!Object.hasOwn(organization.placements, chat.id)) return null;
	const folderId = organization.placements[chat.id]?.folderId;
	return folderId != null && organization.folders.some((f) => f.id === folderId) ? folderId : null;
}

/** Parse the SourceDragRow payload; anything but { kind: "source" | "folder", id: non-empty string } → null. */
export function readDragPayload(raw: string): { kind: "source" | "folder"; id: string } | null {
	let item: unknown;
	try {
		item = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!item || typeof item !== "object") return null;
	const { kind, id } = item as { kind?: unknown; id?: unknown };
	if ((kind !== "source" && kind !== "folder") || typeof id !== "string" || id === "") return null;
	return { kind, id };
}

/** Whether the sidebar may drop the item on target (folder id or null =
 *  Outside folders): exactly when the pre-send planner below would emit
 *  a command — a real change to an existing, legal target. */
function canDrop(
	organization: SidebarOrganization,
	chats: readonly ChatListItem[],
	item: { kind: "source" | "folder"; id: string },
	target: string | null,
): boolean {
	const plan =
		item.kind === "source"
			? planMoveChat(organization, chats, item.id, target)
			: planMoveFolder(organization, item.id, target);
	return plan.kind === "command";
}

/**
 * Sidebar drag state. dragItem arms only on a dragstart bubbled from this
 * list's own SourceDragRow payload (a teaching chat in chats, or an
 * existing folder id); drops are accepted only when the drop payload's
 * kind and id equal dragItem's — foreign drags never become a move.
 */
export function useSidebarDrag(deps: {
	organization: SidebarOrganization | null;
	chats: readonly ChatListItem[];
	moveChat: (chatId: string, parentId: string | null) => Promise<string | null>;
	moveFolder: (folderId: string, parentId: string | null) => Promise<string | null>;
}): {
	dragItem: { kind: "source" | "folder"; id: string } | null;
	/** undefined = no highlighted target; null = Outside folders; string = folder id. */
	dropTarget: string | null | undefined;
	error: string | null;
	containerProps: { onDragStart(e: DragEvent): void; onDragEnd(e: DragEvent): void };
	targetProps(target: string | null): { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void };
} {
	const [dragItem, setDragItem] = useState<{ kind: "source" | "folder"; id: string } | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(armTimer.current), []);

	/* Arming waits for the next task: React would otherwise re-render
	   inside dragstart, and the Outside folders zone (or a cleared error)
	   shifts the row under the pointer — Chrome then cancels the native
	   drag with an immediate dragend. dragover/drop arrive much later. */
	const containerProps = {
		onDragStart(e: DragEvent) {
			clearTimeout(armTimer.current);
			const organization = deps.organization;
			const payload = readDragPayload(e.dataTransfer.getData(SOURCE_DRAG_TYPE));
			let armed: { kind: "source" | "folder"; id: string } | null = null;
			if (organization !== null && payload !== null) {
				if (payload.kind === "source") {
					const chat = deps.chats.find((c) => c.id === payload.id);
					if (chat !== undefined && (chat.kind ?? "teach") !== "practice") {
						armed = { kind: "source", id: chat.id };
					}
				} else if (organization.folders.some((f) => f.id === payload.id)) {
					armed = { kind: "folder", id: payload.id };
				}
			}
			armTimer.current = setTimeout(() => {
				setError(null);
				if (armed !== null) setDragItem(armed);
			}, 0);
		},
		onDragEnd() {
			clearTimeout(armTimer.current);
			setDragItem(null);
			setDropTarget(undefined);
		},
	};

	const targetProps = (target: string | null) => ({
		onDragOver(e: DragEvent) {
			if (!Array.from(e.dataTransfer.types).includes(SOURCE_DRAG_TYPE)) return;
			const organization = deps.organization;
			if (dragItem === null || organization === null || !canDrop(organization, deps.chats, dragItem, target)) {
				e.dataTransfer.dropEffect = "none";
				setDropTarget((previous) => (previous === target ? undefined : previous));
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			setDropTarget(target);
		},
		onDragLeave(e: DragEvent) {
			if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
			setDropTarget((previous) => (previous === target ? undefined : previous));
		},
		onDrop(e: DragEvent) {
			const raw = e.dataTransfer.getData(SOURCE_DRAG_TYPE);
			if (raw === "") return;
			e.preventDefault();
			e.stopPropagation();
			const item = dragItem;
			setDragItem(null);
			setDropTarget(undefined);
			const payload = readDragPayload(raw);
			const organization = deps.organization;
			if (payload === null || item === null || payload.kind !== item.kind || payload.id !== item.id) return;
			if (organization === null || !canDrop(organization, deps.chats, item, target)) return;
			const write = payload.kind === "source" ? deps.moveChat(payload.id, target) : deps.moveFolder(payload.id, target);
			void write.then((failure) => {
				if (failure !== null) setError(failure);
			});
		},
	});

	return { dragItem, dropTarget, error, containerProps, targetProps };
}

/** Pre-send validation against the freshest snapshot (server validation
 *  stays authoritative): blank name and unknown parent are user-facing
 *  errors; a valid plan carries the trimmed name. */
export function planCreateFolder(
	organization: SidebarOrganization,
	name: string,
	parentId: string | null,
): FolderPlan {
	const trimmed = name.trim();
	if (trimmed === "") return { kind: "error", error: "Enter a folder name." };
	if (parentId !== null && !organization.folders.some((f) => f.id === parentId)) {
		return { kind: "error", error: FOLDER_GONE_MESSAGE };
	}
	return { kind: "command", command: { action: "create-folder", name: trimmed, parentId } };
}

/** Same pre-send validation for the chat move: the chat must exist in the
 *  snapshot and be a teaching chat, the target must exist, and a target
 *  equal to the current folder is a skip — no POST for a no-op. */
export function planMoveChat(
	organization: SidebarOrganization,
	chats: readonly ChatListItem[],
	chatId: string,
	parentId: string | null,
): FolderPlan {
	const chat = chats.find((c) => c.id === chatId);
	if (!chat) return { kind: "error", error: "This session no longer exists." };
	if ((chat.kind ?? "teach") === "practice") {
		return { kind: "error", error: "Practice sessions stay outside folders." };
	}
	if (parentId !== null && !organization.folders.some((f) => f.id === parentId)) {
		return { kind: "error", error: FOLDER_GONE_MESSAGE };
	}
	if (currentChatFolder(organization, chat) === parentId) return { kind: "skip" };
	return { kind: "command", command: { action: "move", kind: "source", id: chatId, parentId } };
}

/** Same pre-send validation for the folder move: folder and target must
 *  exist, canMoveFolder rules out itself/descendants, and a target equal
 *  to the current parent (unknown parentId reads as null) is a skip. */
export function planMoveFolder(
	organization: SidebarOrganization,
	folderId: string,
	parentId: string | null,
): FolderPlan {
	const folderById = folderIndex(organization);
	const folder = folderById.get(folderId);
	if (!folder) return { kind: "error", error: FOLDER_GONE_MESSAGE };
	if (parentId !== null && !folderById.has(parentId)) {
		return { kind: "error", error: FOLDER_GONE_MESSAGE };
	}
	if (!canMoveFolder(asSourceOrganization(organization), folderId, parentId)) {
		return { kind: "error", error: "A folder cannot be moved into itself or its descendants." };
	}
	if (folderParentId(folderById, folder) === parentId) return { kind: "skip" };
	return { kind: "command", command: { action: "move", kind: "folder", id: folderId, parentId } };
}

/** Pre-send validation for the folder rename: unknown folder is an error;
 *  a blank name or the unchanged name (after trim) is a skip — the inline
 *  editor's cancel, no write. */
export function planRenameFolder(
	organization: SidebarOrganization,
	folderId: string,
	name: string,
): FolderPlan {
	const folder = organization.folders.find((f) => f.id === folderId);
	if (!folder) return { kind: "error", error: FOLDER_GONE_MESSAGE };
	const trimmed = name.trim();
	if (trimmed === "") return { kind: "skip" };
	if (trimmed === folder.name) return { kind: "skip" };
	return { kind: "command", command: { action: "rename-folder", id: folderId, name: trimmed } };
}

/**
 * POST the command as JSON to the shared write route. A readable 2xx body
 * → ok; an unreadable one means the write MAY have landed — the
 * confirm-failure text, not success. 400 is the server's definite
 * refusal — its message verbatim, never ambiguous. Any other status or a
 * thrown fetch is the same confirm-failure (no automatic retries).
 */
export async function postFolderCommand(
	command: FolderCommand,
	fetchImpl: typeof fetch = fetch,
): Promise<FolderWriteResult> {
	let res: Response;
	try {
		res = await fetchImpl("/api/graph/sources", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(command),
		});
	} catch {
		return { ok: false, error: FOLDER_WRITE_AMBIGUOUS };
	}
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	if (res.ok) return body === null ? { ok: false, error: FOLDER_WRITE_AMBIGUOUS } : { ok: true };
	if (res.status === 400) {
		const message = typeof body?.error === "string" ? body.error : undefined;
		return { ok: false, error: message ?? "The folder change was rejected." };
	}
	return { ok: false, error: FOLDER_WRITE_AMBIGUOUS };
}

/**
 * One sidebar write at a time: a write arriving while another is in
 * flight resolves the "still saving" refusal WITHOUT posting; every
 * posted command is followed by afterWrite — success or failure — before
 * write() resolves, so the sidebar's invalidate/refresh always runs.
 */
export function createFolderWriter(deps: {
	post: (command: FolderCommand) => Promise<FolderWriteResult>;
	afterWrite: (command: FolderCommand, result: FolderWriteResult) => void | Promise<void>;
}): { write(command: FolderCommand): Promise<FolderWriteResult> } {
	let inFlight = false;
	return {
		async write(command) {
			if (inFlight) {
				return { ok: false, error: "Another folder change is still saving." };
			}
			inFlight = true;
			try {
				const result = await deps.post(command);
				await deps.afterWrite(command, result);
				return result;
			} finally {
				inFlight = false;
			}
		},
	};
}

/** The folder picker's <select>: "Outside folders" (value "") plus one
 *  option per target, labelled by full path — shared by the create and
 *  move dialogs, which differ only in id/label. */
function FolderSelect({
	id,
	label,
	targets,
	value,
	onChange,
	selectRef,
}: {
	id: string;
	label: string;
	targets: readonly FolderTarget[];
	value: string | null;
	onChange: (id: string | null) => void;
	selectRef?: Ref<HTMLSelectElement>;
}): ReactNode {
	return (
		<div className="mt-3">
			<label htmlFor={id} className="block text-xs text-muted-foreground">
				{label}
			</label>
			<select
				id={id}
				ref={selectRef}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				data-testid={id}
				className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
			>
				{targets.map((t) => (
					<option key={t.id ?? "outside"} value={t.id ?? ""}>
						{t.label}
					</option>
				))}
			</select>
		</div>
	);
}

function DialogError({ testId, error }: { testId: string; error: string | null }): ReactNode {
	if (error === null) return null;
	return (
		<div role="alert" data-testid={testId} className="mt-3 text-xs text-error">
			{error}
		</div>
	);
}

/** Cancel/Confirm row shared by the folder dialogs. */
function DialogActions({
	cancelTestId,
	confirmTestId,
	busy,
	confirmDisabled,
	confirmIdle,
	confirmBusy,
	onCancel,
	onConfirm,
}: {
	cancelTestId: string;
	confirmTestId: string;
	busy: boolean;
	confirmDisabled: boolean;
	confirmIdle: string;
	confirmBusy: string;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactNode {
	return (
		<div className="mt-4 flex justify-end gap-2">
			<button
				type="button"
				data-testid={cancelTestId}
				onClick={onCancel}
				disabled={busy}
				className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
			>
				Cancel
			</button>
			<button
				type="button"
				data-testid={confirmTestId}
				onClick={onConfirm}
				disabled={busy || confirmDisabled}
				className="rounded-sm border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{busy ? confirmBusy : confirmIdle}
			</button>
		</div>
	);
}

/** The folder dialogs' shared HostDialog frame (the delete-source-dialog
 *  renderFrame pattern): one backdrop, busy blocks closing, each dialog
 *  passes its own initial-focus ref. */
function FolderDialogFrame({
	frame,
	busy,
	onClose,
	initialFocusRef,
}: {
	frame: ReactElement<{ children: ReactNode }>;
	busy: boolean;
	onClose: () => void;
	initialFocusRef?: RefObject<HTMLElement | null>;
}): ReactNode {
	return (
		<HostDialog
			open
			frame={frame}
			initialFocusRef={initialFocusRef}
			onClose={() => {
				if (busy) return "blocked";
				onClose();
				return "closed";
			}}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
		>
			{frame.props.children}
		</HostDialog>
	);
}

/** Shared submit state for the folder dialogs: busy + error around one
 *  in-flight submit; a FOLDER_GONE failure resets the target selection to
 *  Outside folders (onFolderGone), anything else just shows the error. */
function useFolderSubmit({
	onSubmit,
	onClose,
	onFolderGone,
}: {
	onSubmit: () => Promise<string | null>;
	onClose: () => void;
	onFolderGone?: () => void;
}): { busy: boolean; error: string | null; submit: () => void } {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const failure = await onSubmit();
		if (failure === null) {
			onClose();
			return;
		}
		setError(failure);
		if (failure === FOLDER_GONE_MESSAGE) onFolderGone?.();
		setBusy(false);
	};
	return { busy, error, submit: () => void submit() };
}

/**
 * The new-folder form's pure body — exported for SSR pins (the
 * delete-session-dialog body pattern). The wrapper owns state + portal.
 */
export function NewFolderBody({
	name,
	parentId,
	targets,
	busy,
	error,
	onName,
	onParent,
	onCancel,
	onCreate,
	nameRef,
	renderFrame,
}: {
	name: string;
	parentId: string | null;
	targets: FolderTarget[];
	busy: boolean;
	error: string | null;
	onName: (name: string) => void;
	onParent: (id: string | null) => void;
	onCancel: () => void;
	onCreate: () => void;
	nameRef?: Ref<HTMLInputElement>;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}): ReactNode {
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="New folder"
			data-testid="new-folder-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">New folder</h2>
			<div className="mt-3">
				<label htmlFor="new-folder-name" className="block text-xs text-muted-foreground">
					Name
				</label>
				<input
					id="new-folder-name"
					ref={nameRef}
					type="text"
					value={name}
					onChange={(e) => onName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !busy && name.trim() !== "") onCreate();
					}}
					data-testid="new-folder-name"
					className="mt-1 h-7 w-full rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
				/>
			</div>
			<FolderSelect id="new-folder-parent" label="Parent folder" targets={targets} value={parentId} onChange={onParent} />
			<DialogError testId="new-folder-error" error={error} />
			<DialogActions
				cancelTestId="new-folder-cancel"
				confirmTestId="new-folder-create"
				busy={busy}
				confirmDisabled={name.trim() === ""}
				confirmIdle="Create"
				confirmBusy="Creating…"
				onCancel={onCancel}
				onConfirm={onCreate}
			/>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/** What the move dialog is moving: a chat (kind "source") or a folder —
 *  the entity stays captured from menu-open so a snapshot refresh can't
 *  swap the subject mid-edit. */
export type MoveSubject =
	| { kind: "source"; chat: ChatListItem }
	| { kind: "folder"; folder: SidebarFolder };

/**
 * The move-to-folder form's pure body — same SSR-pin pattern as
 * NewFolderBody, shared by chat and folder moves (the testids stay
 * move-chat-*). Move stays disabled while the target equals the current
 * folder: the planner would skip the write anyway.
 */
export function MoveTargetBody({
	title,
	currentId,
	targetId,
	targets,
	busy,
	error,
	onTarget,
	onCancel,
	onMove,
	selectRef,
	renderFrame,
}: {
	title: string;
	currentId: string | null;
	targetId: string | null;
	targets: FolderTarget[];
	busy: boolean;
	error: string | null;
	onTarget: (id: string | null) => void;
	onCancel: () => void;
	onMove: () => void;
	selectRef?: Ref<HTMLSelectElement>;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}): ReactNode {
	const currentLabel = targets.find((t) => t.id === currentId)?.label ?? "Outside folders";
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Move to folder"
			data-testid="move-chat-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Move to folder</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{title}</code>
			</div>
			<p data-testid="move-chat-current" className="mt-2 text-xs text-muted-foreground">
				Currently in: {currentLabel}
			</p>
			<FolderSelect id="move-chat-target" label="Folder" targets={targets} value={targetId} onChange={onTarget} selectRef={selectRef} />
			<DialogError testId="move-chat-error" error={error} />
			<DialogActions
				cancelTestId="move-chat-cancel"
				confirmTestId="move-chat-confirm"
				busy={busy}
				confirmDisabled={targetId === currentId}
				confirmIdle="Move"
				confirmBusy="Moving…"
				onCancel={onCancel}
				onConfirm={onMove}
			/>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}

/**
 * The new-folder dialog — mount it only while open (`{open && …}`), so
 * every opening is a fresh form with no reset effect. Targets recompute
 * from the live organization prop every render: a folder deleted
 * elsewhere drops out of the picker after the sidebar refreshes. Initial
 * focus lands in the name input.
 */
export function NewFolderDialog({
	organization,
	onClose,
	onSubmit,
}: {
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (name: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const [name, setName] = useState("");
	const [parentId, setParentId] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement | null>(null);
	const { busy, error, submit } = useFolderSubmit({
		onSubmit: () => onSubmit(name, parentId),
		onClose,
		onFolderGone: () => setParentId(null),
	});

	return (
		<NewFolderBody
			name={name}
			parentId={parentId}
			targets={folderTargets(organization)}
			busy={busy}
			error={error}
			onName={setName}
			onParent={setParentId}
			onCancel={onClose}
			onCreate={submit}
			nameRef={nameRef}
			renderFrame={(frame) => <FolderDialogFrame frame={frame} busy={busy} onClose={onClose} initialFocusRef={nameRef} />}
		/>
	);
}

/**
 * The one move-target dialog for chats and folders: mount it only while
 * a subject is picked, keyed by subject id, so every opening is a fresh
 * form whose target starts at the current folder/parent — a snapshot
 * refresh can't reset the user's choice. Initial focus lands in the
 * target select.
 */
export function MoveTargetDialog({
	subject,
	organization,
	onClose,
	onSubmit,
}: {
	subject: MoveSubject;
	organization: SidebarOrganization;
	onClose: () => void;
	/** null = done (the dialog closes); a string is the error to show. */
	onSubmit: (id: string, parentId: string | null) => Promise<string | null>;
}): ReactNode {
	const folderById = folderIndex(organization);
	const currentId =
		subject.kind === "source" ? currentChatFolder(organization, subject.chat) : folderParentId(folderById, subject.folder);
	const [targetId, setTargetId] = useState<string | null>(currentId);
	const selectRef = useRef<HTMLSelectElement | null>(null);
	const { busy, error, submit } = useFolderSubmit({
		onSubmit: () => onSubmit(subject.kind === "source" ? subject.chat.id : subject.folder.id, targetId),
		onClose,
		onFolderGone: () => setTargetId(null),
	});
	const targets = subject.kind === "source" ? folderTargets(organization) : folderMoveTargets(organization, subject.folder.id);

	return (
		<MoveTargetBody
			title={subject.kind === "source" ? subject.chat.title : subject.folder.name}
			currentId={currentId}
			targetId={targetId}
			targets={targets}
			busy={busy}
			error={error}
			onTarget={setTargetId}
			onCancel={onClose}
			onMove={submit}
			selectRef={selectRef}
			renderFrame={(frame) => <FolderDialogFrame frame={frame} busy={busy} onClose={onClose} initialFocusRef={selectRef} />}
		/>
	);
}

/**
 * Everything "Delete folder…" offers the shared DeleteSourceDialog: the
 * folder's whole Chains-visible content — itself and every descendant
 * folder, plus the directory sources placed anywhere inside (practice
 * chats are Chains-hidden, so they stay out). Sources keep the
 * directory's order; folders keep the organization's.
 */
export function deleteFolderSelection(
	directory: SourceDirectory,
	folderId: string,
): { sources: SourceEntry[]; folders: SourceFolder[] } {
	const visible = chainSourceDirectory(directory);
	const entries = folderEntries(visible, folderId);
	const sourceIds = new Set(entries.sources);
	const folderIds = new Set(entries.folders);
	return {
		sources: visible.sources.filter((s) => sourceIds.has(s.id)),
		folders: directory.organization.folders.filter((f) => folderIds.has(f.id)),
	};
}

/**
 * DELETE /api/graph/sources with the folder deletion's JSON — the same
 * call Chains makes (chain-table's onDelete). Non-ok throws the body's
 * error string (fallback "Could not delete sources."); a thrown fetch or
 * an unreadable body throws the same fallback. On ok returns the body's
 * numeric graphRevision, or undefined when absent/non-number.
 */
export async function deleteSources(
	request: { sourceIds: string[]; folderIds: string[]; deleteSessions: boolean },
	fetchImpl: typeof fetch = fetch,
): Promise<{ graphRevision: number | undefined }> {
	let res: Response;
	try {
		res = await fetchImpl("/api/graph/sources", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
	} catch {
		throw new Error("Could not delete sources.");
	}
	const body = (await res.json().catch(() => null)) as { error?: unknown; graphRevision?: unknown } | null;
	if (!res.ok) {
		const message = body?.error;
		throw new Error(typeof message === "string" ? message : "Could not delete sources.");
	}
	if (body === null) throw new Error("Could not delete sources.");
	const graphRevision = body.graphRevision;
	return { graphRevision: typeof graphRevision === "number" ? graphRevision : undefined };
}
