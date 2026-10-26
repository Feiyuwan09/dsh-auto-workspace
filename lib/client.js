window.__ModuleLoader__.load({
	id: "dsh-auto-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
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
		const zh = {
			title: "新建分区目录名",
			description: "每次点击「新建分区」时自动创建的分区目录名前缀：第一个分区直接使用该名称，后续分区依次追加 -2、-3…。保存后立即生效（下一次新建分区使用新名字），并持久化到 profile 配置。",
			nameLabel: "目录名前缀",
			namePlaceholder: "default-workspace",
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
			save: "Save",
			saving: "Saving…",
			saved: "✓ Saved — the next add uses the new name",
			loading: "Loading…",
			readonly: "Read-only",
			unsupported: "Settings unavailable (remote browser is read-only).",
			failed: "Save failed: "
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
			// The settings scope may sync after the first render.
			(0, react.useEffect)(() => {
				if (view.status === "ready") {
					setDraft(view.name);
					setLastCommitted(view.name);
				}
			}, [view.status, view.name]);
			const busy = view.status !== "ready" || view.saving;
			const disabled = busy || view.writable !== true;
			const unchanged = sanitizeNameInput(draft) === sanitizeNameInput(lastCommitted);
			const submit = () => {
				const cleaned = sanitizeNameInput(draft);
				if (cleaned === "") {
					setDraft("default-workspace");
					return;
				}
				void props.setName(cleaned);
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
						react.createElement("div", { className: "dsh-auto-workspace-actions" },
							react.createElement("button", {
								type: "button",
								className: "dsh-auto-workspace-save",
								disabled: disabled || unchanged,
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
				snapshot = {
					name: typeof rawName === "string" && rawName !== "" ? rawName : "default-workspace",
					writable: settingsSnapshot.writable,
					status: settingsSnapshot.status,
					saving: snapshot.saving,
					saved: snapshot.saved,
					message: snapshot.message
				};
				for (const listener of listeners) listener();
			};
			const setName = (name) => {
				if (snapshot.saving) return Promise.resolve();
				snapshot = { ...snapshot, saving: true, saved: false, message: undefined };
				for (const listener of listeners) listener();
				return settings.set("workspaceName", name).then(
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
				face: () => ({ hooks: { view }, setName })
			};
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services (cordis fiber inject): slots, workspace UI, locale, and the settings forms. */
		const inject = ["slots", "uiWorkspace", "locale", "configForms"];
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
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
