/**
 * recruiting-copilot —— 浏览器端面板（右侧实时浏览器镜像）
 *
 * 挂进 shell.overlay（list 插槽），渲染一个右侧悬浮面板：
 * - 轮询 /plugins/recruiting-view/state.json（2s）拿各浏览器源状态与标签列表
 * - 轮询 /plugins/recruiting-view/frame.jpg（~1s）刷新最新一帧
 * - 可折叠成右缘小条、可拖宽、可选源（boss / 未来 liepin）、可选标签
 */
window.__ModuleLoader__.load({
	id: "recruiting-copilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── 样式（注入一次）──────────────────────────────────────────────
		const css = [
			".rcp-panel{position:fixed;right:10px;top:10px;bottom:10px;width:460px;min-width:260px;max-width:70vw;z-index:60;display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:12px;background:var(--dsw-specific-menu,#1b1b1f);box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.4));overflow:hidden}",
			".rcp-head{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262b);flex:none}",
			".rcp-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#eee);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".rcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-text-danger,#f2574b)}",
			".rcp-dot[data-ok='true']{background:var(--dsw-alias-text-success,#3fb68b)}",
			".rcp-btn{flex:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary,#8a8a93);cursor:pointer;font-size:11px;line-height:18px;padding:2px 6px;border-radius:6px}",
			".rcp-btn:hover{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-fill-l2,#26262b)}",
			".rcp-tabs{display:flex;gap:4px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262b);flex:none;overflow-x:auto}",
			".rcp-tab{flex:none;font-size:11px;line-height:20px;padding:0 10px;border-radius:999px;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;background:0 0}",
			".rcp-tab[data-active='true']{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-fill-l2,#26262b);border-color:var(--dsw-alias-border-l2,#333)}",
			".rcp-url{flex:none;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-mono,ui-monospace,monospace)}",
			".rcp-pages{flex:none;padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262b);display:flex;gap:4px;overflow-x:auto}",
			".rcp-page{flex:none;max-width:220px;font-size:11px;line-height:20px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#26262b);color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;background:0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".rcp-page[data-active='true']{color:var(--dsw-alias-label-primary,#eee);border-color:var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-fill-l2,#26262b)}",
			".rcp-body{flex:1;min-height:0;position:relative;background:#fff}",
			".rcp-body img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}",
			".rcp-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:12px;background:var(--dsw-specific-bg-base,#141417)}",
			".rcp-resizer{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:2}",
			".rcp-pill{position:fixed;right:0;top:40%;z-index:60;display:flex;align-items:center;gap:6px;padding:10px 10px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#333);border-right:0;border-radius:12px 0 0 12px;background:var(--dsw-specific-menu,#1b1b1f);color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;font-size:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 40px rgba(0,0,0,.4))}"
		].join("\n");
		const tagId = "recruiting-copilot/BrowserPanel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "recruiting-copilot";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── 面板组件 ────────────────────────────────────────────────────
		function BrowserPanel() {
			const [state, setState] = react.useState(null);
			const [activeSource, setActiveSource] = react.useState("boss");
			const [frameSrc, setFrameSrc] = react.useState(null);
			const [collapsed, setCollapsed] = react.useState(false);
			const [width, setWidth] = react.useState(460);
			const dragging = react.useRef(false);

			react.useEffect(() => {
				const loadState = () => {
					fetch("/plugins/recruiting-view/state.json", { cache: "no-store" })
						.then((r) => (r.ok ? r.json() : null))
						.then((data) => {
							if (data) setState(data);
						})
						.catch(() => {});
				};
				loadState();
				const timer = setInterval(loadState, 2000);
				return () => clearInterval(timer);
			}, []);

			// 帧轮询：以当前源 + 时间戳作缓存破坏
			react.useEffect(() => {
				const loadFrame = () => setFrameSrc(`/plugins/recruiting-view/frame.jpg?source=${encodeURIComponent(activeSource)}&t=${Date.now()}`);
				loadFrame();
				const timer = setInterval(loadFrame, 1000);
				return () => clearInterval(timer);
			}, [activeSource]);

			react.useEffect(() => {
				const onMove = (e) => {
					if (!dragging.current) return;
					const next = Math.min(Math.max(window.innerWidth - e.clientX - 10, 260), Math.floor(window.innerWidth * 0.7));
					setWidth(next);
				};
				const onUp = () => { dragging.current = false; };
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
			}, []);

			if (collapsed) {
				return react.createElement("div", {
					className: "rcp-pill",
					onClick: () => setCollapsed(false),
					title: "展开招聘浏览器"
				}, "▶ 招聘浏览器");
			}

			const sources = (state?.sources ?? []).filter((s) => s != null);
			const active = sources.find((s) => s.name === activeSource) ?? sources[0];
			const sourceName = active?.name ?? "boss";
			const pages = active?.pages ?? [];
			const connected = active?.connected === true;
			const frameTs = active?.seq ?? 0;

			const onPagePick = (pageId) => {
				fetch(`/plugins/recruiting-view/set-target?source=${encodeURIComponent(sourceName)}&pageId=${encodeURIComponent(pageId)}`, { cache: "no-store" }).catch(() => {});
			};

			return react.createElement("div", {
				className: "rcp-panel",
				style: { width }
			},
				react.createElement("div", { className: "rcp-resizer", onMouseDown: () => { dragging.current = true; } }),
				react.createElement("div", { className: "rcp-head" },
					react.createElement("span", { className: "rcp-dot", "data-ok": String(connected) }),
					react.createElement("span", { className: "rcp-title" }, "招聘浏览器 · " + sourceName + (connected ? "" : "（未连接）")),
					react.createElement("button", { className: "rcp-btn", onClick: () => setCollapsed(true), title: "折叠" }, "—")
				),
				react.createElement("div", { className: "rcp-tabs" },
					sources.length > 0
						? sources.map((s) => react.createElement("button", {
							key: s.name,
							className: "rcp-tab",
							"data-active": String(s.name === sourceName),
							onClick: () => setActiveSource(s.name)
						}, s.name + (s.connected === true ? "" : " ⚠")))
						: react.createElement("span", { className: "rcp-tab", "data-active": "true" }, "boss")
				),
				react.createElement("div", { className: "rcp-url" }, active?.targetUrl ?? "等待浏览器…"),
				pages.length > 1
					? react.createElement("div", { className: "rcp-pages" },
						pages.map((p) => react.createElement("button", {
							key: p.id,
							className: "rcp-page",
							"data-active": String(p.id === active?.targetId),
							onClick: () => onPagePick(p.id),
							title: p.url
						}, (p.title || p.url || "untitled").slice(0, 40)))
					)
					: null,
				react.createElement("div", { className: "rcp-body" },
					connected && frameSrc
						? react.createElement("img", { key: frameTs, src: frameSrc, alt: "browser frame" })
						: react.createElement("div", { className: "rcp-empty" },
							react.createElement("span", null, connected ? "正在连接浏览器…" : "浏览器未运行"),
							react.createElement("span", null, "运行 boss/liepin 命令后这里会实时显示操作界面")
						)
				)
			);
		}

		/** 客户端插件主体：注册右侧面板到 shell.overlay。 */
		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "shell.overlay",
				id: "recruiting-view",
				priority: 0,
				label: "招聘浏览器"
			}, BrowserPanel), "recruiting-copilot: browser panel");
		}

		exports.apply = apply;
		return module.exports;
	}
});
