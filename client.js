/**
 * recruiting-copilot —— 浏览器端面板（可操作的远程浏览器）
 *
 * 挂进 shell.overlay（list 插槽），渲染一个右侧 dock 面板：
 * - 画面走 /plugins/recruiting-view/stream.mjpg（host 侧 CDP screencast 推帧）
 * - 鼠标 / 滚轮 / 键盘 / 中文 IME / 粘贴 全部回传 /input，等于在这里直接操作浏览器
 * - 默认「贴合」：把页面视口 emulate 成面板尺寸，所以文字是原生大小，不是缩小糊图
 * - 浏览器没起时面板里一键拉起（同 user-data-dir 同端口，boss 命令随后直连这只）
 *
 * 形态：dock 列而不是浮层 —— 面板打开时给 #root 加 margin-right 让聊天区真正
 * 让出宽度（借鉴 dsh-better-sidebar 的 layout-push 手法），视觉上就是 DSH 的
 * 第四列；颜色全部走 --dsw-* token。
 */
window.__ModuleLoader__.load({
	id: "recruiting-copilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		const BASE = "/plugins/recruiting-view";
		const MIN_W = 360;
		const WIDTH_KEY = "rcp.panel.width";
		// 页面视口固定尺寸：BOSS 页面在这个尺寸下渲染最完整（用户确认 958×1149 刚好），
		// 面板自身可随意拖宽，画面按比例缩放，黑边由 normalize() 兜底。
		const FIXED_VIEWPORT = { width: 958, height: 1149 };

		// ── 样式（注入一次）──────────────────────────────────────────────
		const css = [
			// dock 推挤：面板打开时应用让出宽度（--rcp-dock-width 由组件写入）
			"#root{margin-right:var(--rcp-dock-width,0px);transition:margin-right var(--ds-transition-duration-slow,.3s) var(--ds-ease-in-out,ease)}",
			"body[data-rcp-dragging='true'] #root{transition:none}",
			"@media (prefers-reduced-motion:reduce){#root{transition:none}}",
			// 面板本体：dock 列 = 通栏贴边、无圆角无阴影、左边框，像 DSH 的 details 列
			".rcp-panel{position:fixed;z-index:60;display:flex;flex-direction:column;box-sizing:border-box;border-left:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-alias-bg-layer-1,#1b1b1f);overflow:hidden}",
			".rcp-panel[data-mode='side']{right:0;top:0;bottom:0;min-width:360px;max-width:92vw}",
			".rcp-panel[data-mode='max']{left:0;right:0;top:0;bottom:0;width:auto!important;border-left:none}",
			".rcp-head{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262b);flex:none}",
			".rcp-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;flex:none}",
			".rcp-spacer{flex:1}",
			".rcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-error-primary,#f2574b)}",
			".rcp-dot[data-ok='true']{background:var(--dsw-alias-state-success-primary,#3fb68b)}",
			".rcp-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;border:1px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;font-size:13px;line-height:1;padding:0 5px;border-radius:6px}",
			".rcp-btn:hover{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".rcp-btn[data-on='true']{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));border-color:var(--dsw-alias-border-l2,#3a3a42)}",
			".rcp-btn:disabled{opacity:.35;cursor:default;background:0 0}",
			".rcp-addr{flex:1;min-width:60px;height:24px;font-size:11px;line-height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#26262b);background:var(--dsw-alias-bg-layer-2,#141417);color:var(--dsw-alias-label-secondary,#b8b8c0);font-family:var(--ds-font-family-code,ui-monospace,monospace);outline:0}",
			".rcp-addr:focus{border-color:var(--dsw-alias-border-l3,#4a4a55);color:var(--dsw-alias-label-primary,#eee)}",
			".rcp-pages{flex:none;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#26262b);display:flex;gap:4px;overflow-x:auto;scrollbar-width:thin}",
			".rcp-page{flex:none;display:flex;align-items:center;gap:4px;max-width:220px;font-size:11px;line-height:20px;padding:0 4px 0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#26262b);color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;background:0 0;white-space:nowrap}",
			".rcp-page span{overflow:hidden;text-overflow:ellipsis;max-width:170px}",
			".rcp-page[data-active='true']{color:var(--dsw-alias-label-primary,#eee);border-color:var(--dsw-alias-border-l2,#3a3a42);background:var(--dsw-alias-bg-module-platform,#26262b)}",
			".rcp-x{opacity:.45;padding:0 3px;border-radius:4px;cursor:pointer}",
			".rcp-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".rcp-body{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-layer-3,#0b0b0d);overflow:hidden;outline:0}",
			".rcp-body img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none}",
			".rcp-body[data-live='true']{cursor:default}",
			".rcp-focus{position:absolute;inset:0;pointer-events:none;border:2px solid transparent;border-radius:2px;transition:border-color .15s}",
			".rcp-body[data-focus='true'] .rcp-focus{border-color:var(--dsw-alias-state-success-primary,#3fb68b)}",
			".rcp-ime{position:absolute;width:2px;height:16px;opacity:0;border:0;padding:0;margin:0;background:0 0;color:transparent;resize:none;outline:0;pointer-events:none;overflow:hidden}",
			".rcp-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:12px;text-align:center;padding:20px}",
			".rcp-empty-icon{font-size:30px;line-height:1}",
			".rcp-empty-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#eee)}",
			".rcp-cta{border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4176e6));color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}",
			".rcp-cta:hover{background:var(--dsw-alias-button-primary-hover,#2f4c8f)}",
			".rcp-foot{flex:none;display:flex;align-items:center;gap:8px;padding:3px 8px;border-top:1px solid var(--dsw-alias-border-l1,#26262b);font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93);font-family:var(--ds-font-family-code,ui-monospace,monospace)}",
			".rcp-resizer{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2}",
			".rcp-pill{position:fixed;right:0;top:40%;z-index:60;display:flex;align-items:center;gap:6px;padding:10px 10px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#333);border-right:0;border-radius:12px 0 0 12px;background:var(--dsw-alias-bg-layer-1,#1b1b1f);color:var(--dsw-alias-label-secondary,#b8b8c0);cursor:pointer;font-size:12px;box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.2))}"
		].join("\n");
		const tagId = "recruiting-copilot/BrowserPanel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "recruiting-copilot";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── 输入事件队列：单飞行 POST，按 TCP 顺序到达 host ────────────────
		function makeInputQueue(source) {
			let queue = [];
			let flying = false;
			const flush = () => {
				if (flying || queue.length === 0) return;
				const events = queue;
				queue = [];
				flying = true;
				fetch(`${BASE}/input?source=${encodeURIComponent(source())}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ events })
				})
					.catch(() => {})
					.finally(() => {
						flying = false;
						if (queue.length > 0) flush();
					});
			};
			return {
				push(ev) {
					// 连续 mouseMoved 合并成最后一个，避免拖动时堆积。
					const last = queue[queue.length - 1];
					if (ev.kind === "mouse" && ev.type === "mouseMoved" && last && last.kind === "mouse" && last.type === "mouseMoved") {
						queue[queue.length - 1] = ev;
					} else {
						queue.push(ev);
					}
					flush();
				}
			};
		}

		/** DOM 修饰键位 → CDP modifiers 位掩码（alt1 ctrl2 meta4 shift8）。 */
		function modifiersOf(e) {
			return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
		}

		/** 事件坐标 → 图像内容区归一化坐标（兼容 object-fit: contain 的黑边）。 */
		function normalize(e, box, img) {
			const rect = box.getBoundingClientRect();
			const natW = img?.naturalWidth || 0;
			const natH = img?.naturalHeight || 0;
			let dispW = rect.width;
			let dispH = rect.height;
			let offX = 0;
			let offY = 0;
			if (natW > 0 && natH > 0) {
				const scale = Math.min(rect.width / natW, rect.height / natH);
				dispW = natW * scale;
				dispH = natH * scale;
				offX = (rect.width - dispW) / 2;
				offY = (rect.height - dispH) / 2;
			}
			return {
				nx: dispW > 0 ? (e.clientX - rect.left - offX) / dispW : 0,
				ny: dispH > 0 ? (e.clientY - rect.top - offY) / dispH : 0,
				dispW,
				dispH
			};
		}

		const BUTTONS = ["left", "middle", "right", "back", "forward"];

		function readStoredWidth() {
			try {
				const saved = Number.parseInt(localStorage.getItem(WIDTH_KEY), 10);
				if (Number.isFinite(saved) && saved >= MIN_W) return Math.min(saved, Math.floor(window.innerWidth * 0.92));
			} catch { /* 无 localStorage 时走默认 */ }
			return Math.min(Math.round(window.innerWidth * 0.42), 720);
		}

		// ── 面板组件 ────────────────────────────────────────────────────
		function BrowserPanel() {
			const [state, setState] = react.useState(null);
			const [activeSource, setActiveSource] = react.useState("boss");
			const [collapsed, setCollapsed] = react.useState(false);
			const [mode, setMode] = react.useState("side");
			const [width, setWidth] = react.useState(readStoredWidth);
			const [fit, setFit] = react.useState(true);
			const [interactive, setInteractive] = react.useState(true);
			const [focused, setFocused] = react.useState(false);
			const [addr, setAddr] = react.useState("");
			const [addrDirty, setAddrDirty] = react.useState(false);
			const [streamKey, setStreamKey] = react.useState(0);

			const bodyRef = react.useRef(null);
			const imgRef = react.useRef(null);
			const imeRef = react.useRef(null);
			const dragging = react.useRef(false);
			const sourceRef = react.useRef(activeSource);
			sourceRef.current = activeSource;
			const queueRef = react.useRef(null);
			if (queueRef.current === null) queueRef.current = makeInputQueue(() => sourceRef.current);

			const control = react.useCallback((action, payload) => {
				return fetch(`${BASE}/control?source=${encodeURIComponent(sourceRef.current)}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(Object.assign({ action }, payload ?? {}))
				})
					.then((r) => r.json())
					.catch(() => ({ ok: false }));
			}, []);

			// 状态轮询
			react.useEffect(() => {
				let alive = true;
				const loadState = () => {
					fetch(`${BASE}/state.json`, { cache: "no-store" })
						.then((r) => (r.ok ? r.json() : null))
						.then((data) => {
							if (alive && data) setState(data);
						})
						.catch(() => {});
				};
				loadState();
				const timer = setInterval(loadState, 1500);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			// dock 推挤：dock 态把宽度写给 #root 的 margin-right；折叠/整屏时让出 0。
			react.useEffect(() => {
				const dock = mode === "side" && !collapsed ? Math.round(width) : 0;
				document.documentElement.style.setProperty("--rcp-dock-width", `${dock}px`);
				return () => {
					document.documentElement.style.removeProperty("--rcp-dock-width");
				};
			}, [mode, collapsed, width]);

			// 记住面板宽度（刷新后恢复）
			react.useEffect(() => {
				try {
					localStorage.setItem(WIDTH_KEY, String(width));
				} catch { /* 忽略 */ }
			}, [width]);

			// 盯梢：面板未折叠时告诉 host「浏览器崩了自动重新拉起」
			react.useEffect(() => {
				control("watch", { on: !collapsed });
				return () => {
					control("watch", { on: false });
				};
			}, [collapsed, control]);

			const sources = (state?.sources ?? []).filter((s) => s != null);
			const active = sources.find((s) => s.name === activeSource) ?? sources[0];
			const sourceName = active?.name ?? "boss";
			const pages = active?.pages ?? [];
			const connected = active?.connected === true;
			const launching = active?.launching === true;
			const viewport = active?.viewport ?? { width: 0, height: 0 };

			// 地址栏跟随真实 URL（用户正在编辑时不覆盖）
			react.useEffect(() => {
				if (!addrDirty) setAddr(active?.targetUrl ?? "");
			}, [active?.targetUrl, addrDirty]);

			// 贴合：页面视口固定为 FIXED_VIEWPORT（与面板大小解耦——面板拖宽只影响
			// 显示缩放，不影响页面渲染尺寸，保证 BOSS 页面永远截得全）。
			react.useEffect(() => {
				if (!fit) {
					control("unfit");
					return undefined;
				}
				control("fit", {
					width: FIXED_VIEWPORT.width,
					height: FIXED_VIEWPORT.height,
					deviceScaleFactor: Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
				});
			}, [fit, collapsed, mode, control]);

			// 断线后重连：重挂 MJPEG（img 的 src 不变时不会自动重连）
			react.useEffect(() => {
				if (connected) setStreamKey((k) => k + 1);
			}, [connected, sourceName]);

			// 面板拖宽（dock 贴边：宽度 = 视口右缘到鼠标）
			react.useEffect(() => {
				const onMove = (e) => {
					if (!dragging.current) return;
					setWidth(Math.min(Math.max(window.innerWidth - e.clientX, MIN_W), Math.floor(window.innerWidth * 0.92)));
				};
				const onUp = () => {
					dragging.current = false;
					document.body.removeAttribute("data-rcp-dragging");
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					document.body.removeAttribute("data-rcp-dragging");
				};
			}, []);

			// ── 输入转发 ─────────────────────────────────────────────────
			const sendMouse = react.useCallback((type, e, extra) => {
				const box = bodyRef.current;
				if (!box) return;
				const { nx, ny, dispW, dispH } = normalize(e, box, imgRef.current);
				const ev = {
					kind: "mouse",
					type,
					nx,
					ny,
					button: type === "mouseMoved" && e.buttons === 0 ? "none" : BUTTONS[e.button] ?? "left",
					buttons: e.buttons ?? 0,
					clickCount: type === "mousePressed" || type === "mouseReleased" ? e.detail || 1 : 0,
					modifiers: modifiersOf(e)
				};
				if (type === "mouseWheel") {
					ev.button = "none";
					ev.ndx = dispW > 0 ? extra.deltaX / dispW : 0;
					ev.ndy = dispH > 0 ? extra.deltaY / dispH : 0;
				}
				queueRef.current.push(ev);
			}, []);

			const focusIme = react.useCallback((e) => {
				const ime = imeRef.current;
				const box = bodyRef.current;
				if (!ime || !box) return;
				if (e) {
					const rect = box.getBoundingClientRect();
					ime.style.left = `${Math.round(e.clientX - rect.left)}px`;
					ime.style.top = `${Math.round(e.clientY - rect.top)}px`;
				}
				ime.focus({ preventScroll: true });
			}, []);

			const onMouseDown = react.useCallback((e) => {
				if (!interactive || !connected) return;
				e.preventDefault();
				focusIme(e);
				sendMouse("mousePressed", e);
			}, [interactive, connected, focusIme, sendMouse]);

			const onMouseMove = react.useCallback((e) => {
				if (!interactive || !connected) return;
				sendMouse("mouseMoved", e);
			}, [interactive, connected, sendMouse]);

			const onMouseUp = react.useCallback((e) => {
				if (!interactive || !connected) return;
				e.preventDefault();
				sendMouse("mouseReleased", e);
			}, [interactive, connected, sendMouse]);

			// wheel 要用非 passive 监听才能 preventDefault，React 的 onWheel 是 passive
			react.useEffect(() => {
				const box = bodyRef.current;
				if (!box) return undefined;
				const onWheel = (e) => {
					if (!interactive || !connected) return;
					e.preventDefault();
					sendMouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY });
				};
				box.addEventListener("wheel", onWheel, { passive: false });
				return () => box.removeEventListener("wheel", onWheel);
			}, [interactive, connected, sendMouse]);

			const onKey = react.useCallback((e, type) => {
				if (!interactive || !connected) return;
				if (e.isComposing || e.keyCode === 229) return; // 交给 IME，compositionend 再发
				e.preventDefault();
				e.stopPropagation();
				const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
				queueRef.current.push({
					kind: "key",
					type: type === "down" ? (printable ? "keyDown" : "rawKeyDown") : "keyUp",
					key: e.key,
					code: e.code,
					keyCode: e.keyCode || e.which || 0,
					text: type === "down" && printable ? e.key : undefined,
					autoRepeat: e.repeat === true,
					location: e.location ?? 0,
					modifiers: modifiersOf(e)
				});
			}, [interactive, connected]);

			const onCompositionEnd = react.useCallback((e) => {
				const text = e.data ?? "";
				if (text.length > 0) queueRef.current.push({ kind: "text", text });
				if (imeRef.current) imeRef.current.value = "";
			}, []);

			const onPaste = react.useCallback((e) => {
				if (!interactive || !connected) return;
				const text = e.clipboardData?.getData("text") ?? "";
				e.preventDefault();
				if (text.length > 0) queueRef.current.push({ kind: "text", text });
			}, [interactive, connected]);

			const submitAddr = react.useCallback((e) => {
				e.preventDefault();
				setAddrDirty(false);
				control("navigate", { url: addr });
			}, [addr, control]);

			if (collapsed) {
				return h("div", {
					className: "rcp-pill",
					onClick: () => setCollapsed(false),
					title: "展开招聘浏览器"
				}, "▶ 招聘浏览器");
			}

			const btn = (label, title, onClick, extra) =>
				h("button", Object.assign({ className: "rcp-btn", title, onClick, key: title }, extra ?? {}), label);

			const head = h("div", { className: "rcp-head" },
				h("span", { className: "rcp-dot", "data-ok": String(connected) }),
				h("span", { className: "rcp-title", title: active?.targetTitle ?? sourceName }, active?.targetTitle || sourceName),
				btn("←", "后退", () => control("back"), { disabled: !connected }),
				btn("→", "前进", () => control("forward"), { disabled: !connected }),
				btn("⟳", "刷新", () => control("reload"), { disabled: !connected }),
				h("form", { className: "rcp-spacer", style: { display: "flex" }, onSubmit: submitAddr },
					h("input", {
						className: "rcp-addr",
						value: addr,
						placeholder: connected ? "输入网址回车跳转" : "浏览器未连接",
						spellCheck: false,
						disabled: !connected,
						onChange: (e) => { setAddr(e.target.value); setAddrDirty(true); },
						onBlur: () => setAddrDirty(false)
					})
				),
				btn("＋", "新标签页", () => control("new-tab"), { disabled: !connected }),
				btn(interactive ? "🖱" : "🔒", interactive ? "可操作（点画面直接操作浏览器）" : "只读（点击不再传给浏览器）", () => setInteractive((v) => !v), { "data-on": String(interactive) }),
				btn("贴合", "贴合：页面视口固定 958×1149（截得全）；关掉则显示浏览器真实窗口画面", () => setFit((v) => !v), { "data-on": String(fit) }),
				btn(mode === "max" ? "⇲" : "⇱", mode === "max" ? "还原为右侧面板" : "放大到整屏", () => setMode((m) => (m === "max" ? "side" : "max"))),
				btn("—", "折叠", () => setCollapsed(true))
			);

			const tabs = h("div", { className: "rcp-pages" },
				sources.length > 1
					? sources.map((s) => h("button", {
						key: `src-${s.name}`,
						className: "rcp-page",
						"data-active": String(s.name === sourceName),
						onClick: () => setActiveSource(s.name)
					}, h("span", null, s.name)))
					: null,
				pages.map((p) => h("div", {
					key: p.id,
					className: "rcp-page",
					"data-active": String(p.id === active?.targetId),
					title: p.url,
					onClick: () => control("set-target", { pageId: p.id })
				},
					h("span", null, p.title || p.url || "untitled"),
					h("span", {
						className: "rcp-x",
						title: "关闭标签",
						onClick: (e) => { e.stopPropagation(); control("close-tab", { pageId: p.id }); }
					}, "×")
				))
			);

			const body = h("div", {
				className: "rcp-body",
				ref: bodyRef,
				"data-live": String(connected && interactive),
				"data-focus": String(focused && interactive),
				onMouseDown,
				onMouseMove,
				onMouseUp,
				onContextMenu: (e) => e.preventDefault()
			},
				connected
					? h("img", {
						key: `${sourceName}-${streamKey}`,
						ref: imgRef,
						src: `${BASE}/stream.mjpg?source=${encodeURIComponent(sourceName)}&k=${streamKey}`,
						alt: "browser",
						draggable: false
					})
					: h("div", { className: "rcp-empty" },
						h("span", { className: "rcp-empty-icon" }, "🌐"),
						h("span", { className: "rcp-empty-title" }, launching ? "正在启动浏览器…" : "浏览器未运行"),
						h("button", {
							className: "rcp-cta",
							onClick: () => control("launch").then(() => setTimeout(() => setStreamKey((k) => k + 1), 1500))
						}, launching ? "启动中…" : "在这里启动浏览器"),
						h("span", { style: { opacity: .7 } }, "用 boss-cli 同一用户数据目录和调试端口，登录态通用"),
						active?.error ? h("span", { style: { color: "var(--dsw-alias-state-error-primary,#f2574b)" } }, String(active.error)) : null
					),
				h("textarea", {
					ref: imeRef,
					className: "rcp-ime",
					autoComplete: "off",
					spellCheck: false,
					onKeyDown: (e) => onKey(e, "down"),
					onKeyUp: (e) => onKey(e, "up"),
					onCompositionEnd,
					onPaste,
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false),
					onInput: (e) => { if (!e.nativeEvent.isComposing) e.target.value = ""; }
				}),
				h("div", { className: "rcp-focus" })
			);

			const foot = h("div", { className: "rcp-foot" },
				h("span", null, connected ? `${viewport.width}×${viewport.height}` : "—"),
				h("span", null, active?.frameMode === "screencast" ? "推流" : active?.frameMode === "poll" ? "轮询" : "空闲"),
				h("span", { className: "rcp-spacer" }),
				h("span", { className: "rcp-x", title: "把真实浏览器窗口唤到前台", onClick: () => control("activate") }, "唤起窗口")
			);

			return h("div", {
				className: "rcp-panel",
				"data-mode": mode,
				style: mode === "side" ? { width } : undefined
			},
				mode === "side"
					? h("div", {
						className: "rcp-resizer",
						onMouseDown: () => {
							dragging.current = true;
							document.body.setAttribute("data-rcp-dragging", "true");
						}
					})
					: null,
				head,
				pages.length > 0 || sources.length > 1 ? tabs : null,
				body,
				foot
			);
		}

		/** 客户端插件主体：注册右侧面板到 shell.overlay。 */
		function apply(ctx) {
			// slots 是 cordis 服务，必须经 inject 才能访问；放子纤维里等服务就绪再注册。
			ctx.inject(["slots"], (ctx) => {
				ctx.effect(() => ctx.slots.register({
					name: "shell.overlay",
					id: "recruiting-view",
					priority: 0,
					label: "招聘浏览器"
				}, BrowserPanel), "recruiting-copilot: browser panel");
			});
		}

		exports.apply = apply;
		return module.exports;
	}
});
