window.__ModuleLoader__.load({
	id: "dsh-auto-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let clientStore = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/client/flow.js
		/**
		* The auto-workspace picking occupant (package-internal; the `./client`
		* surface exposes only the Loader exports). Renderless like the official
		* native occupant: each rising `open` edge runs exactly one pick and
		* reports exactly one outcome; the ref arms once per open so re-renders
		* (and an adoption keeping `open` true while `busy`) never launch a second
		* pick. The owner withdrawing `open` re-arms the next request.
		*
		* Unlike the official native occupant, `pick` NEVER opens an OS dialog:
		* it always routes through `uiWorkspace.pickDirectory()`, i.e. the host
		* Remote `directoryPicker/pick`, which the dsh-auto-workspace host half
		* answers by creating `<Documents>\deepseek-harness\<workspaceName>[-N]`
		* and returning its path. The Electron desktop bridge
		* (globalThis.__DSH_DIRECTORY_PICKER__) is deliberately ignored.
		* @param props - owner conversation plus the injected pick call.
		* @returns nothing — the pick resolves server-side.
		*/
		function AutoDirectoryFlow(props) {
			const { open, pick } = props;
			const armed = (0, react.useRef)(false);
			const outcome = (0, react.useRef)(props);
			outcome.current = props;
			const alive = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!open) {
					armed.current = false;
					return;
				}
				if (armed.current) return;
				armed.current = true;
				pick().then((path) => {
					if (!alive.current) return;
					if (path === null) outcome.current.onCancel();
					else outcome.current.onPicked(path);
				}, (reason) => {
					if (!alive.current) return;
					outcome.current.onError(reason instanceof Error ? reason.message : String(reason));
				});
			}, [open, pick]);
			return null;
		}
		//#endregion
		//#region lib/types/client/delete-copy.js
		/**
		* Patch the official ui-workspace `workspace` dictionaries so the
		* workspace-delete confirmation matches the new behavior installed by
		* this plugin's host half (deleting a workspace also removes its
		* directory from disk).
		*
		* The official ui-workspace plugin registers its dictionaries through
		* `ctx.effect(() => ctx.locale.register("workspace", { zh, en }))`
		* synchronously inside its apply. This plugin injects `uiWorkspace`
		* (provided by ui-workspace), so by the time our apply runs the
		* official registration has already completed. Re-registering the
		* namespace would throw ("already has locale"), so instead we mutate
		* the registered dictionary objects directly — `t()` lookups read the
		* live dict map on every call, so the new copy takes effect without
		* any republish.
		*
		* The patched copy is deliberately loud: the dialog now names the
		* disk folder and states plainly that files will be permanently
		* removed and the action cannot be undone.
		* @param locale - the LocaleRuntime service.
		* @returns true when the official dictionaries were found and patched.
		*/
		function patchWorkspaceDeleteCopy(locale) {
			if (locale === undefined || locale === null) return false;
			const namespaces = locale.dicts?.get("workspace");
			if (namespaces === undefined) return false;
			const zh = namespaces.get("zh");
			const en = namespaces.get("en");
			if (zh === undefined || en === undefined) return false;
			if (zh["delete.desc"] === undefined || en["delete.desc"] === undefined) return false;
			// 中文：标题、描述、进行中、确认按钮文案全部换成醒目警告。
			zh["delete.workspace"] = "删除分区并清空本地文件夹";
			zh["delete.desc"] = "⚠ 警告：此操作将删除分区“{name}”，并永久删除其磁盘文件夹中的全部文件和会话日志，无法恢复。确定要继续吗？";
			zh["delete.pending"] = "正在删除分区和本地文件夹…";
			// 英文保持同步的警告语义。
			en["delete.workspace"] = "Delete workspace and its folder";
			en["delete.desc"] = "WARNING: this deletes workspace “{name}” and permanently removes its folder on disk — all files and session logs inside it will be lost. This cannot be undone. Continue?";
			en["delete.pending"] = "Deleting workspace and folder…";
			return true;
		}
		//#endregion
		//#region lib/types/client/move-session.js
		/**
		* The "move session to another workspace" action: a
		* `sidebar.workspaces.session.menu.item` row (order 460, right after the
		* shipped session-id row) that raises a `shell.overlay` dialog, plus the
		* dialog itself which lists the target workspaces and calls the host
		* Remote `autoWorkspace/move`.
		*
		* Wire face: the host half registers a TypertRemoteService with the
		* `autoWorkspace` namespace and hand-written Remote method descriptors
		* (same marker shape the shipped `@Remote` decorator generates). The
		* client calls the raw connection rpc — SRC methods carry no strict
		* codec contribution, so there is no generated client namespace to mount.
		* `{ args: { sessionId, workspaceId } }` → `{ ok: true, value }` or
		* `{ ok: false, error: { code, message, details } }`.
		*
		* The dialog lives outside the row menu because the row unmounts with the
		* menu (same split the shipped rename/archive dialogs use). After a
		* successful move the workspace feed republishes both workspaces
		* (attach/detach mutate the durable records), so the sidebar updates by
		* itself; the dialog just closes.
		*/

		/** Stable per-dialog request record raised by the menu row. */
		function createMoveRequestStore() {
			return clientStore.createSnapshotStore(null);
		}

		/** Project the workspaces list into the slim target-candidates shape (official ui-workspace `derive` pattern). */
		function deriveStore(source, project) {
			let seen;
			let value;
			return {
				getSnapshot: () => {
					const snapshot = source.getSnapshot();
					if (value === undefined || snapshot !== seen) {
						seen = snapshot;
						value = project(snapshot);
					}
					return value;
				},
				subscribe: (listener) => source.subscribe(listener)
			};
		}

		/** Host error codes → user-facing copy (falls back to the wire message). */
		const MOVE_ERROR_COPY = {
			"autoWorkspace/session-active": "该会话仍在运行（或其任务还在执行），请先关闭再移动",
			"autoWorkspace/session-unknown": "会话不存在，或磁盘上已没有它的日志",
			"autoWorkspace/workspace-unknown": "目标分区不存在或已被删除",
			"autoWorkspace/same-workspace": "会话已经在这个分区里",
			"autoWorkspace/unsupported-log": "该会话的日志格式暂不支持移动（仅支持当前代 zstd 日志）",
			"autoWorkspace/io-failure": "移动时磁盘操作失败"
		};

		/**
		* Menu row (order 460): raise the move request, seeded with the row's
		* current workspace.
		* @param props - owner share, menu open state, the move share, and locale.
		* @returns the row.
		*/
		function MoveSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestSessionMove, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			return react.createElement(primitives.MenuItemButton, {
				icon: react.createElement(primitives.IconFolderOpenRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					requestSessionMove(sessionId, displayTitle);
				}
			}, t("move.menu"));
		}

		/**
		* The `shell.overlay` entry: nothing while no move is requested, otherwise
		* one dialog per request (keyed by the Session).
		* @param props - the request hook, target-candidates hook, settlement, the move hop, and locale.
		* @returns the open dialog, or null.
		*/
		function MoveSessionDialog({ useMoveRequest, useMoveTargets, settleSessionMove, performSessionMove, t }) {
			const request = useMoveRequest((pending) => pending);
			const allTargets = useMoveTargets((items) => items);
			if (request === null) return null;
			const targets = allTargets.filter((item) => item.workspaceId !== request.currentWorkspaceId);
			return react.createElement(MoveSessionForm, {
				request,
				targets,
				performSessionMove,
				onSettle: settleSessionMove,
				t
			}, request.sessionId);
		}

		/** One request's dialog: target pick, in-flight and error state die with it. */
		function MoveSessionForm({ request, targets, performSessionMove, onSettle, t }) {
			const [picked, setPicked] = react.useState(null);
			const [moving, setMoving] = react.useState(false);
			const [error, setError] = react.useState(null);
			const close = () => {
				if (moving) return;
				onSettle();
			};
			const confirm = () => {
				if (moving || picked === null) return;
				setMoving(true);
				setError(null);
				performSessionMove(request.sessionId, picked).then(() => {
					setMoving(false);
					onSettle();
				}, (reason) => {
					setMoving(false);
					const rpcCode = reason?.rpcError?.code;
					const detail = MOVE_ERROR_COPY[rpcCode] ?? (reason instanceof Error ? reason.message : String(reason));
					setError(detail);
				});
			};
			return react.createElement(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("move.close"),
				title: t("move.title"),
				description: t("move.desc", { name: request.displayTitle }),
				footer: react.createElement(react.Fragment, null,
					react.createElement(primitives.Button, { variant: "outline", disabled: moving, onClick: close }, t("move.cancel")),
					react.createElement(primitives.Button, {
						variant: "primary",
						disabled: moving || picked === null,
						onClick: confirm
					}, moving ? t("move.moving") : t("move.go"))
				)
			},
				request.currentPath !== "" && react.createElement("p", { className: "dsh-auto-workspace-move-current" }, t("move.current", { path: request.currentPath })),
				react.createElement("p", { className: "dsh-auto-workspace-move-targetLabel" }, t("move.targetLabel")),
				targets.length === 0
					? react.createElement("p", { className: "dsh-auto-workspace-move-empty" }, t("move.empty"))
					: react.createElement("div", { className: "dsh-auto-workspace-move-targets" },
						targets.map((target) => react.createElement("button", {
							key: target.workspaceId,
							type: "button",
							className: "dsh-auto-workspace-move-target",
							"data-selected": picked === target.workspaceId ? "true" : "false",
							disabled: moving,
							onClick: () => { setPicked(target.workspaceId); setError(null); }
						},
							react.createElement("span", { className: "dsh-auto-workspace-move-targetTitle" }, target.title),
							react.createElement("span", { className: "dsh-auto-workspace-move-targetPath", title: target.path }, target.path)
						))
					),
				moving && react.createElement("div", { className: "dsh-auto-workspace-move-status", role: "status" }, t("move.pending")),
				error !== null && react.createElement("div", { className: "dsh-auto-workspace-error", role: "alert" }, t("move.failed"), " ", error)
			);
		}
		//#endregion
		//#region lib/types/client/settings-card.js
		/**
		* Plugin-panel settings card: an input for the workspace base name plus
		* a save button. Mirrors the official plugin-settings pattern
		* (dsh-unrestricted): the settings namespace is `auto-workspace` and the
		* browser writes it through the injected `configForms` service, which
		* persists to the profile's cordis.patch.yml; the host half hot-applies
		* the value through the loader's volatile update.
		*/

		/** Strip characters that can never appear in a directory name. */
		function sanitizeNameInput(value) {
			return String(value ?? "")
				.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
				.replace(/\./g, "")
				.trim();
		}

		/** Windows/Unix 绝对路径判断：盘符或 UNC，或以 / 开头。 */
		function isAbsolutePath(value) {
			const s = String(value ?? "");
			return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.startsWith("/");
		}

		/**
		* Stylesheet for the settings card. One hand-written stylesheet injected
		* as a single <style data-plugin> tag (the loader convention for
		* plugin-owned styles); colors come from the shared --dsw-* tokens so the
		* card follows the current theme (light/dark) automatically.
		*/
		const CSS = `
.dsh-auto-workspace-card {
  display: block;
  width: 100%;
  max-width: 760px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
}

.dsh-auto-workspace-summary {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-sizing: border-box;
  padding: 12px 14px;
  cursor: pointer;
  list-style: none;
  touch-action: manipulation;
  user-select: none;
}

.dsh-auto-workspace-summary::-webkit-details-marker { display: none; }

.dsh-auto-workspace-summary:hover { background: var(--dsw-alias-interactive-bg-hover); }

.dsh-auto-workspace-summary:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

.dsh-auto-workspace-summary::after {
  width: 8px;
  height: 8px;
  flex: none;
  border-right: 2px solid var(--dsw-alias-label-tertiary);
  border-bottom: 2px solid var(--dsw-alias-label-tertiary);
  content: '';
  transform: rotate(45deg);
  transition: transform 160ms ease;
}

.dsh-auto-workspace-card[open] > .dsh-auto-workspace-summary {
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}

.dsh-auto-workspace-card[open] > .dsh-auto-workspace-summary::after {
  transform: rotate(225deg);
}

.dsh-auto-workspace-summaryText {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dsh-auto-workspace-title {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
}

.dsh-auto-workspace-summaryStatus {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  padding: 1px 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-auto-workspace-summaryStatus[data-state='active'] {
  color: var(--dsw-alias-state-business-primary);
}

.dsh-auto-workspace-summaryStatus[data-state='pending'] {
  color: var(--dsw-alias-label-tertiary);
}

.dsh-auto-workspace-summaryStatus[data-state='readonly'] {
  color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-tertiary));
}

.dsh-auto-workspace-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}

.dsh-auto-workspace-description {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-auto-workspace-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dsh-auto-workspace-label {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dsh-auto-workspace-input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.dsh-auto-workspace-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.dsh-auto-workspace-input:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l1);
}

.dsh-auto-workspace-input:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent);
}

.dsh-auto-workspace-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.dsh-auto-workspace-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.dsh-auto-workspace-save {
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  background: var(--dsw-alias-state-business-primary);
  color: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 6%, #ffffff);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
  transition: filter 120ms ease, opacity 120ms ease;
}

.dsh-auto-workspace-save:hover:not(:disabled) { filter: brightness(1.06); }

.dsh-auto-workspace-save:active:not(:disabled) { filter: brightness(0.96); }

.dsh-auto-workspace-save:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.dsh-auto-workspace-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dsh-auto-workspace-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}

.dsh-auto-workspace-note[data-kind='muted'] {
  color: var(--dsw-alias-label-tertiary);
}

.dsh-auto-workspace-note[data-kind='error'] {
  color: var(--dsw-alias-state-error-primary);
}

.dsh-auto-workspace-move-current {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.dsh-auto-workspace-move-targetLabel {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

.dsh-auto-workspace-move-targets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
}

.dsh-auto-workspace-move-target {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}

.dsh-auto-workspace-move-target:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l1);
}

.dsh-auto-workspace-move-target:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}

.dsh-auto-workspace-move-target[data-selected='true'] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, var(--dsw-alias-bg-layer-2));
}

.dsh-auto-workspace-move-target:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dsh-auto-workspace-move-targetTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
}

.dsh-auto-workspace-move-targetPath {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.dsh-auto-workspace-move-empty {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-auto-workspace-move-status {
  margin-top: 10px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-auto-workspace-error {
  margin: 0;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-auto-workspace-summary::after { transition: none; }
  .dsh-auto-workspace-input { transition: none; }
  .dsh-auto-workspace-save { transition: none; }
}
`;

		/** Inject the stylesheet once; the tag id doubles as the re-evaluation guard. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin=\"dsh-auto-workspace\"]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-auto-workspace";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Settings-card locale dictionaries (own namespace, no conflicts). */
		const NS = "settings.auto-workspace";
		const MOVE_NS = "workspace.auto-workspace-move";
		const zh = {
			title: "新建分区目录名",
			description: "每次点击「新建分区」时自动创建的分区目录名前缀：第一个分区直接使用该名称，后续分区依次追加 -2、-3…。保存后立即生效（下一次新建分区使用新名字），并持久化到 profile 配置。",
			nameLabel: "目录名前缀",
			namePlaceholder: "default-workspace",
			dirLabel: "分区存放位置（容器目录）",
			dirPlaceholder: "留空 = 文档\\deepseek-harness（默认）",
			dirHint: "填绝对路径后，新建的分区目录将分配到这个文件夹之下（如 D:\\DSH-Workspaces）。只影响之后新建的分区；留空恢复默认位置。",
			dirInvalid: "请输入绝对路径（例如 D:\\DSH-Workspaces）",
			save: "保存",
			saving: "保存中…",
			saved: "✓ 已保存，下一次新建分区使用新名字",
			loading: "读取中…",
			readonly: "只读",
			unsupported: "设置不可用（远程浏览器只读）。",
			failed: "保存失败："
		};
		const en = {
			title: "New workspace folder name",
			description: "The base name used for auto-created workspace folders: the first workspace takes the name itself, further ones append -2, -3… It applies from the next add and persists to the profile config.",
			nameLabel: "Base name",
			namePlaceholder: "default-workspace",
			dirLabel: "Workspace location (container folder)",
			dirPlaceholder: "Leave empty = Documents\\deepseek-harness (default)",
			dirHint: "Enter an absolute path and new workspace folders will be allocated under it (e.g. D:\\DSH-Workspaces). It only affects workspaces added afterwards; leave empty to restore the default location.",
			dirInvalid: "Enter an absolute path (e.g. D:\\DSH-Workspaces)",
			save: "Save",
			saving: "Saving…",
			saved: "✓ Saved — the next add uses the new name",
			loading: "Loading…",
			readonly: "Read-only",
			unsupported: "Settings unavailable (remote browser is read-only).",
			failed: "Save failed: "
		};

		/** Move-session dialog dictionaries. */
		const moveZh = {
			"move.menu": "移动到另一分区…",
			"move.close": "关闭",
			"move.title": "移动会话到另一分区",
			"move.desc": "将“{name}”的会话日志移动到另一个分区。移动后该对话会出现在目标分区下。",
			"move.current": "当前分区：{path}",
			"move.targetLabel": "选择目标分区",
			"move.empty": "没有其他分区可移动（请先新建一个分区）。",
			"move.cancel": "取消",
			"move.go": "移动",
			"move.moving": "移动中…",
			"move.pending": "正在移动会话日志并更新分区记账…",
			"move.failed": "移动失败："
		};
		const moveEn = {
			"move.menu": "Move to another workspace…",
			"move.close": "Close",
			"move.title": "Move session to another workspace",
			"move.desc": "Move the session log of “{name}” to another workspace. The conversation then shows up under the target workspace.",
			"move.current": "Current workspace: {path}",
			"move.targetLabel": "Pick a target workspace",
			"move.empty": "No other workspace to move into (create one first).",
			"move.cancel": "Cancel",
			"move.go": "Move",
			"move.moving": "Moving…",
			"move.pending": "Moving the session log and updating workspace accounting…",
			"move.failed": "Move failed: "
		};

		/** Card props assembled by the slot renderer. */
		/**
		* The settings card component. Props arrive through the slot share:
		* `t` from the `locale` key, `view`/`setName` from the inject face.
		* @param props - locale copy, view snapshot, and the persist action.
		* @returns the card.
		*/
		function AutoWorkspaceCard(props) {
			const { t } = props;
			const view = props.useView((s) => s);
			const [draft, setDraft] = (0, react.useState)(() => view.name);
			const [lastCommitted, setLastCommitted] = (0, react.useState)(view.name);
			const [dirDraft, setDirDraft] = (0, react.useState)(() => view.dir);
			const [lastCommittedDir, setLastCommittedDir] = (0, react.useState)(view.dir);
			// The settings scope may sync after the first render.
			(0, react.useEffect)(() => {
				if (view.status === "ready") {
					setDraft(view.name);
					setLastCommitted(view.name);
					setDirDraft(view.dir);
					setLastCommittedDir(view.dir);
				}
			}, [view.status, view.name, view.dir]);
			const busy = view.status !== "ready" || view.saving;
			const disabled = busy || view.writable !== true;
			const dirTrimmed = dirDraft.trim();
			const dirInvalid = dirTrimmed !== "" && !isAbsolutePath(dirTrimmed);
			const unchanged = sanitizeNameInput(draft) === sanitizeNameInput(lastCommitted)
				&& dirTrimmed === lastCommittedDir;
			const submit = () => {
				const cleaned = sanitizeNameInput(draft);
				if (cleaned === "") {
					setDraft("default-workspace");
					return;
				}
				if (dirInvalid) return;
				void props.setAll(cleaned, dirTrimmed);
			};
			// 摘要胶囊：当前生效名字 / 读取中 / 只读。
			const capsuleState = view.status === "loading"
				? "pending"
				: view.status === "unavailable" || view.writable !== true
					? "readonly"
					: "active";
			const capsuleText = view.status === "loading"
				? t("loading")
				: view.status === "unavailable" || view.writable !== true
					? t("readonly")
					: view.name;
			return (
				react.createElement("details", { open: true, className: "dsh-auto-workspace-card" },
					react.createElement("summary", { className: "dsh-auto-workspace-summary" },
						react.createElement("span", { className: "dsh-auto-workspace-summaryText" },
							react.createElement("span", { className: "dsh-auto-workspace-title" }, t("title")),
							react.createElement("span", {
								className: "dsh-auto-workspace-summaryStatus",
								"data-state": capsuleState,
								title: view.name
							}, capsuleText)
						)
					),
					react.createElement("div", { className: "dsh-auto-workspace-content" },
						react.createElement("p", { className: "dsh-auto-workspace-description" }, t("description")),
						react.createElement("label", { className: "dsh-auto-workspace-field" },
							react.createElement("span", { className: "dsh-auto-workspace-label" }, t("nameLabel")),
							react.createElement("input", {
								type: "text",
								className: "dsh-auto-workspace-input",
								value: draft,
								disabled,
								placeholder: t("namePlaceholder"),
								onChange: (event) => { setDraft(sanitizeNameInput(event.target.value)); }
							})
						),
						react.createElement("label", { className: "dsh-auto-workspace-field" },
							react.createElement("span", { className: "dsh-auto-workspace-label" }, t("dirLabel")),
							react.createElement("input", {
								type: "text",
								className: "dsh-auto-workspace-input",
								value: dirDraft,
								disabled,
								placeholder: t("dirPlaceholder"),
								spellCheck: false,
								onChange: (event) => { setDirDraft(event.target.value); }
							}),
							react.createElement("p", { className: "dsh-auto-workspace-note", "data-kind": dirInvalid ? "error" : "muted" },
								dirInvalid ? t("dirInvalid") : t("dirHint")
							)
						),
						react.createElement("div", { className: "dsh-auto-workspace-actions" },
							react.createElement("button", {
								type: "button",
								className: "dsh-auto-workspace-save",
								disabled: disabled || unchanged || dirInvalid,
								onClick: submit
							}, view.saving ? t("saving") : t("save"))
						),
						view.message !== undefined && (
							react.createElement("p", { className: "dsh-auto-workspace-error" }, t("failed"), view.message)
						),
						view.saved && !view.saving && view.message === undefined && (
							react.createElement("p", { className: "dsh-auto-workspace-note" }, t("saved"))
						),
						view.status === "unavailable" && (
							react.createElement("p", { className: "dsh-auto-workspace-note", "data-kind": "muted" }, t("unsupported"))
						)
					)
				)
			);
		}

		/**
		* Card controller: binds the `auto-workspace` settings namespace and the
		* persist action. Same shape as the official unrestricted controller.
		* @param ctx - the browser plugin context (configForms injected).
		* @returns the face handed to the slot register.
		*/
		function createAutoWorkspaceController(ctx) {
			const settings = ctx.configForms.get("auto-workspace");
			let snapshot = {
				name: "default-workspace",
				dir: "",
				writable: false,
				status: "loading",
				saving: false,
				saved: false,
				message: undefined
			};
			const listeners = new Set();
			const view = {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			};
			const publish = () => {
				const settingsSnapshot = settings.getSnapshot();
				const rawName = settingsSnapshot.value?.workspaceName;
				const rawDir = settingsSnapshot.value?.workspaceDir;
				snapshot = {
					name: typeof rawName === "string" && rawName !== "" ? rawName : "default-workspace",
					dir: typeof rawDir === "string" ? rawDir : "",
					writable: settingsSnapshot.writable,
					status: settingsSnapshot.status,
					saving: snapshot.saving,
					saved: snapshot.saved,
					message: snapshot.message
				};
				for (const listener of listeners) listener();
			};
			const setAll = (name, dir) => {
				if (snapshot.saving) return Promise.resolve();
				snapshot = { ...snapshot, saving: true, saved: false, message: undefined };
				for (const listener of listeners) listener();
				return Promise.all([
					settings.set("workspaceName", name),
					settings.set("workspaceDir", dir)
				]).then(
					() => {
						snapshot = { ...snapshot, saving: false, saved: true };
						for (const listener of listeners) listener();
					},
					(error) => {
						snapshot = {
							...snapshot,
							saving: false,
							saved: false,
							message: error instanceof Error ? error.message : String(error)
						};
						for (const listener of listeners) listener();
					}
				);
			};
			ctx.effect(() => settings.subscribe(publish), "dsh-auto-workspace: settings mirror");
			publish();
			return {
				face: () => ({ hooks: { view }, setAll })
			};
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services (cordis fiber inject): slots, workspace UI, locale, settings forms, the raw connection rpc, and the workspace snapshot model. */
		const inject = ["slots", "uiWorkspace", "locale", "configForms", "connection", "workspaces"];
		/**
		* Client plugin body: register the renderless auto flow into both
		* directory-flow holes through `slots.inject()` because the ui-workspace
		* entries may activate later or replace their declarations; patch the
		* official delete-confirmation copy to match the folder-removing host
		* behavior; and register the plugin-panel settings card for the
		* workspace base name.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			// 卡片样式只注入一次（data-plugin 标记去重）。
			ensureStyles();
			// Always the host Remote: the dsh-auto-workspace host half answers
			// directoryPicker/pick by auto-creating the default directory.
			const pick = () => ctx.uiWorkspace.pickDirectory();
			const injected = () => ({ pick });
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				yield ctx.slots.register({
					name: "conversation.hero.workspace.directoryFlow",
					inject: injected
				}, AutoDirectoryFlow);
				yield ctx.slots.register({
					name: "sidebar.workspaces.directoryFlow",
					inject: injected
				}, AutoDirectoryFlow);
			}));
			// 删除确认文案：apply 时官方字典必已注册（uiWorkspace 依赖保证），
			// 直接 patch；失败时监听服务事件兜底重试。
			const patchCopy = () => {
				try {
					return patchWorkspaceDeleteCopy(ctx.locale);
				} catch {
					return false;
				}
			};
			if (!patchCopy()) {
				ctx.on("internal/service", (name) => {
					if (name === "locale" || name === "uiWorkspace") patchCopy();
				});
			}
			// 插件管理页配置卡片：分区目录名前缀。
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-auto-workspace: dictionaries");
			const controller = createAutoWorkspaceController(ctx);
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-auto-workspace",
				locale: NS,
				inject: () => controller.face()
			}, AutoWorkspaceCard));

			// 「移动会话到另一分区」：菜单项（order 460，紧跟官方 session-id 450）
			// 与 shell.overlay 对话框。菜单项所属 slot 由 ui-workspace 声明
			// （kind: list, scope: root, inject: { hooks: { menuOpenState, shortcuts } }）
			// —— 本插件的 entry inject 里必须给全这两个 hook，否则 slot 框架
			// 装配 props 时拿不到 provider。
			ctx.effect(() => ctx.locale.register(MOVE_NS, { zh: moveZh, en: moveEn }), "dsh-auto-workspace: move dictionaries");
			const moveRequest = createMoveRequestStore();
			const workspaces = ctx.workspaces;
			// 目标候选：分区快照 items + 会话当前所在分区路径（为排除当前分区）。
			const moveTargets = deriveStore(workspaces.list, (snapshot) => {
				const items = snapshot?.items ?? [];
				return items.map((item) => ({
					workspaceId: item.workspaceId,
					title: item.title,
					path: item.path
				}));
			});
			const requestSessionMove = (sessionId, displayTitle) => {
				const snapshotItems = workspaces.list.getSnapshot()?.items ?? [];
				const current = snapshotItems.find((item) => item.sessionIds.includes(sessionId));
				const currentWorkspaceId = current?.workspaceId ?? null;
				const currentPath = current?.path ?? "";
				moveRequest.set({ sessionId, displayTitle, currentWorkspaceId, currentPath });
			};
			const performSessionMove = async (sessionId, workspaceId) => {
				const connection = ctx.connection;
				const rpc = connection?.rpc;
				if (rpc === undefined) throw new Error("client connection rpc is unavailable");
				const result = await rpc.call("/api", "autoWorkspace/move", { args: { sessionId, workspaceId } });
				if (!result.ok) {
					const failure = new Error(`autoWorkspace/move failed: ${result.error.code}: ${result.error.message}`);
					failure.rpcError = result.error;
					throw failure;
				}
				return result.value;
			};
			const moveInjected = () => ({
				hooks: {
					moveRequest,
					moveTargets
				},
				requestSessionMove,
				settleSessionMove: () => { moveRequest.set(null); },
				performSessionMove
			});
			// 菜单项注册进列表 slot；对话框注册进 shell.overlay。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "auto-workspace.move",
				order: 460,
				locale: MOVE_NS,
				inject: moveInjected
			}, MoveSessionMenuItem));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "auto-workspace.session-move",
				order: 460,
				locale: MOVE_NS,
				inject: moveInjected
			}, MoveSessionDialog));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
