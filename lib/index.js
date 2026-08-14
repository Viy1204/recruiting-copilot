/**
 * recruiting-copilot —— DeepSeek Harness 宿主插件（node 半区）
 *
 * 把 boss-cli / liepin-cli 驱动的本机 Chrome 通过 Chrome DevTools Protocol
 * （CDP）实时镜像成 JPEG 帧，经 DSH Web 服务器暴露给右侧浏览器面板：
 *
 *   GET /plugins/recruiting-view/state.json         —— 各浏览器源的状态 + 标签列表
 *   GET /plugins/recruiting-view/frame.jpg?source=X —— 最新一帧 JPEG（客户端轮询）
 *   GET /plugins/recruiting-view/set-target?source=X&pageId=Y —— 切换抓取目标标签
 *
 * boss-cli 固定占用 53470 端口（见 boss-cli/src/browser/cdp_browser.ts：
 * REMOTE_DEBUGGING_PORT，可用 BOSS_BROWSER_REMOTE_DEBUGGING_PORT 覆盖），浏览器
 * 跨命令常驻，因此本插件可以并行挂到同一只浏览器上。
 * liepin-cli 目前用 puppeteer.launch() 且不带固定调试端口，暂不可挂载；
 * 等 liepin-cli 支持固定端口后，在 profile 配置的 sources 里加一项即可。
 *
 * 无第三方依赖：只使用 Node 内置 fetch / WebSocket（Node ≥ 22）。
 */

const NAME = "recruiting-copilot";
/** 不声明 inject：webServer 仅 web profile 存在，headless 等 profile 下优雅降级。 */
const inject = [];

const DEFAULT_SOURCES = [{ name: "boss", port: 53470, match: /zhipin\.com/i }];

const PROBE_TIMEOUT_MS = 900;
const COMMAND_TIMEOUT_MS = 6000;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * 一个浏览器源（如 boss）的镜像：探测 CDP 端点 → 连接目标页 → 周期截图。
 * 所有错误都被吞进 state.error，不影响宿主进程。
 */
export class BrowserMirror {
  constructor(source, config = {}) {
    this.name = source.name;
    this.port = clampInt(source.port, 53470, 1, 65535);
    this.match = source.match instanceof RegExp ? source.match : new RegExp(source.match ?? "", "i");
    this.quality = clampInt(config.jpegQuality, 60, 10, 95);
    this.state = {
      name: this.name,
      connected: false,
      browser: null,
      pages: [],
      targetId: null,
      targetTitle: null,
      targetUrl: null,
      lastFrameAt: 0,
      seq: 0,
      error: null
    };
    this._ws = null;
    this._wsTargetId = null;
    this._pending = new Map();
    this._commandSeq = 0;
    this._targetOverride = null;
    this._lastCaptureAt = 0;
  }

  /** 切换抓取目标（pageId 来自 state.pages[].id）。 */
  setTarget(pageId) {
    this._targetOverride = pageId || null;
    this._dropConnection();
  }

  /** 抓到的最后一帧（JPEG Buffer），没有则 undefined。 */
  get frame() {
    return this._frame;
  }

  _dropConnection() {
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
    this._wsTargetId = null;
  }

  async _probe() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data?.webSocketDebuggerUrl === "string" ? data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async _listPages() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: ctrl.signal });
      if (!res.ok) return [];
      const targets = await res.json();
      return (Array.isArray(targets) ? targets : []).filter((t) => t?.type === "page" && !String(t.url ?? "").startsWith("chrome://") && !String(t.title ?? "").startsWith("chrome://"));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  _pickTarget(pages) {
    if (this._targetOverride && pages.some((p) => p.id === this._targetOverride)) return this._targetOverride;
    const matched = pages.find((p) => this.match.test(p.url ?? ""));
    return (matched ?? pages[0])?.id ?? null;
  }

  async _ensureConnected() {
    const version = await this._probe();
    if (!version) {
      this.state.connected = false;
      this.state.browser = null;
      this.state.pages = [];
      this.state.targetId = null;
      this._dropConnection();
      return false;
    }
    const pages = await this._listPages();
    this.state.browser = version.Browser ?? version.browser ?? "unknown";
    this.state.pages = pages.map((p) => ({ id: p.id, title: p.title ?? "", url: p.url ?? "" }));
    const targetId = this._pickTarget(pages);
    this.state.targetId = targetId;
    if (targetId === null) {
      this.state.connected = false;
      this._dropConnection();
      return false;
    }
    const target = pages.find((p) => p.id === targetId);
    this.state.targetTitle = target?.title ?? null;
    this.state.targetUrl = target?.url ?? null;

    if (this._ws && this._wsTargetId === targetId && this._ws.readyState === 1) return true;

    this._dropConnection();
    const wsUrl = target.webSocketDebuggerUrl;
    if (!wsUrl) return false;

    await new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => reject(new Error("cdp connect timeout")), PROBE_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp websocket error"));
      }, { once: true });
      this._ws = ws;
      this._wsTargetId = targetId;
      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch { return; }
        if (msg?.id !== undefined && this._pending.has(msg.id)) {
          const { resolve: done, timer: t } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          clearTimeout(t);
          done(msg);
        }
      });
      ws.addEventListener("close", () => {
        if (this._ws === ws) {
          this._ws = null;
          this._wsTargetId = null;
          this.state.connected = false;
        }
        for (const { resolve: done, timer: t } of this._pending.values()) {
          clearTimeout(t);
          done({ error: { message: "cdp closed" } });
        }
        this._pending.clear();
      });
    });

    try {
      await this._command("Page.enable", {});
      this.state.connected = true;
      this.state.error = null;
      return true;
    } catch (error) {
      this.state.connected = false;
      this.state.error = String(error?.message ?? error);
      this._dropConnection();
      return false;
    }
  }

  _command(method, params) {
    return new Promise((resolve) => {
      if (!this._ws || this._ws.readyState !== 1) {
        resolve({ error: { message: "cdp not connected" } });
        return;
      }
      const id = ++this._commandSeq;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ error: { message: `cdp timeout: ${method}` } });
      }, COMMAND_TIMEOUT_MS);
      this._pending.set(id, { resolve, timer });
      try {
        this._ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        resolve({ error: { message: String(error?.message ?? error) } });
      }
    });
  }

  /** 一轮：确保连接 → 抓一帧（若有足够间隔）→ 更新状态。 */
  async tick() {
    try {
      const ok = await this._ensureConnected();
      if (!ok) return;
      const now = Date.now();
      if (now - this._lastCaptureAt < 600) return; // 与 frameIntervalMs 配合限速
      const msg = await this._command("Page.captureScreenshot", {
        format: "jpeg",
        quality: this.quality,
        fromSurface: true
      });
      if (msg?.result?.data) {
        const buf = Buffer.from(msg.result.data, "base64");
        if (buf.length > 0) {
          this._frame = buf;
          this.state.lastFrameAt = Date.now();
          this.state.seq += 1;
          this._lastCaptureAt = Date.now();
        }
      } else {
        this.state.error = msg?.error?.message ?? "capture failed";
      }
    } catch (error) {
      this.state.error = String(error?.message ?? error);
      this.state.connected = false;
    }
  }

  dispose() {
    this._dropConnection();
    for (const { resolve: done, timer: t } of this._pending.values()) {
      clearTimeout(t);
      done({ error: { message: "disposed" } });
    }
    this._pending.clear();
  }
}

/** 按查询串取源名（默认 boss）。 */
function sourceNameFrom(url) {
  const q = new URLSearchParams(url?.search ?? "");
  const name = q.get("source");
  return typeof name === "string" && name.length > 0 ? name : "boss";
}

/**
 * /plugins/recruiting-view/* 路由处理器。
 * @param mirrors - 各浏览器源的 BrowserMirror 列表。
 */
function makeRouteHandler(mirrors) {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.local");
    const pathname = url.pathname;
    if (pathname.endsWith("/state.json")) {
      const body = JSON.stringify({ sources: mirrors.map((m) => m.state), ts: Date.now() });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (pathname.endsWith("/frame.jpg")) {
      const mirror = mirrors.find((m) => m.name === sourceNameFrom(url)) ?? mirrors[0];
      const frame = mirror?.frame;
      if (!frame) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(`no frame yet for source "${mirror?.name ?? sourceNameFrom(url)}"`);
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "content-length": frame.length });
      res.end(frame);
      return;
    }
    if (pathname.endsWith("/set-target")) {
      const mirror = mirrors.find((m) => m.name === sourceNameFrom(url)) ?? mirrors[0];
      mirror?.setTarget(url.searchParams.get("pageId"));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}

/**
 * cordis 插件主体：注册 /plugins/recruiting-view/* 路由并周期性抓帧。
 * @param ctx - cordis 上下文。
 * @param rawConfig - profile 补丁里该 entry 的 config。
 */
export function apply(ctx, rawConfig = {}) {
  const config = rawConfig ?? {};
  const sources = Array.isArray(config.sources) && config.sources.length > 0
    ? config.sources
    : DEFAULT_SOURCES;
  const intervalMs = clampInt(config.frameIntervalMs, 1000, 300, 30000);
  const mirrors = sources.map((source) => new BrowserMirror(source, config));

  const tick = () => {
    for (const mirror of mirrors) mirror.tick().catch(() => { /* 已吞错 */ });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 200)?.unref?.();

  // webServer 由 dsh-host-webserver 提供；本 entry 不声明必选 inject（headless
  // 等 profile 无 webServer 也能挂载），因此路由放在 ctx.inject 子纤维里，
  // 等服务可用时再注册；一直不可用（headless）则自动跳过。
  if (typeof ctx.inject === "function") {
    ctx.inject({ webServer: {} }, (webCtx) => {
      webCtx.effect(() => {
        const disposeRoute = webCtx.webServer.register({
          kind: "prefix",
          path: "/plugins/recruiting-view",
          handler: makeRouteHandler(mirrors)
        });
        return () => {
          disposeRoute?.();
        };
      }, "recruiting-copilot: view routes");
    });
  }

  ctx.effect?.(() => () => {
    clearInterval(timer);
    for (const mirror of mirrors) mirror.dispose();
  }, "recruiting-copilot: browser mirror");
}

export { NAME, inject };
