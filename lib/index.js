/**
 * recruiting-copilot —— DeepSeek Harness 宿主插件（node 半区）
 *
 * 把 boss-cli / liepin-cli 驱动的本机 Chrome 通过 Chrome DevTools Protocol
 * （CDP）做成一只**可远程操作**的浏览器，经 DSH Web 服务器暴露给右侧面板：
 *
 *   GET  /plugins/recruiting-view/state.json   —— 各源状态 + 标签列表 + 视口尺寸
 *   GET  /plugins/recruiting-view/stream.mjpg  —— MJPEG 实时流（screencast 推帧）
 *   GET  /plugins/recruiting-view/frame.jpg    —— 最新一帧（兜底/调试）
 *   POST /plugins/recruiting-view/input        —— 鼠标/滚轮/键盘/文本注入
 *   POST /plugins/recruiting-view/control      —— 启动浏览器、导航、切标签、贴合视口
 *
 * 帧来源优先 Page.startScreencast（有变化才推，空闲零开销）；screencast 停推时看门狗
 * 自动回落到 Page.captureScreenshot 定时抓帧（无头下只用 fromSurface:true，见 _pollFrame）。
 *
 * 浏览器默认以**无头**方式拉起（`RECRUIT_BROWSER_HIDDEN=false` 可退回有头）：招聘浏览器
 * 不该抢前景与键盘焦点。实测「离屏有头」（--window-position 到屏幕外）做不到——在 Windows
 * 上创建可见窗口必然激活它，照样抢焦点；而无头下本面板依赖的每条 CDP 能力（screencast、
 * Emulation 贴合、Input 派发、captureScreenshot）与有头零退化。
 *
 * boss-cli 固定占用 53470 端口（boss-cli/src/browser/cdp_browser.ts 的
 * REMOTE_DEBUGGING_PORT，可用 BOSS_BROWSER_REMOTE_DEBUGGING_PORT 覆盖），浏览器
 * 跨命令常驻；浏览器没起时本插件可用相同 user-data-dir 与端口自行拉起，之后
 * boss-cli 会直连这只已存在的实例（同一登录态）。
 *
 * 无第三方依赖：只用 Node 内置 fetch / WebSocket / child_process（Node ≥ 22）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const NAME = "recruiting-copilot";
/** 不声明 inject：webServer 仅 web profile 存在，headless 等 profile 下优雅降级。 */
const inject = [];

/** 与 boss-cli 对齐的浏览器启动参数（详见其 cdp_browser.ts / puppeteer.defaultArgs）。 */
const CHROME_LAUNCH_ARGS = [
  "--allow-pre-commit-input",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-crash-reporter",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-hang-monitor",
  "--disable-infobars",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  "--disable-extensions"
];

/**
 * 隐藏模式（无头）：默认开启——本插件的目的就是让招聘浏览器不抢前景与键盘焦点。
 * 设 `RECRUIT_BROWSER_HIDDEN=false` 退回有头。这个变量是三方（本插件 / boss-cli /
 * liepin-cli）共读的单一来源，各 CLI 自家的变量作为更具体的覆盖项。
 */
function hiddenModeEnabled() {
  return process.env.RECRUIT_BROWSER_HIDDEN?.trim().toLowerCase() !== "false";
}

/**
 * 隐藏模式追加的启动参数。
 *
 * `--screen-info` 仅在无头下有效，所以与 `--headless=new` 成对出现：无头虚拟屏默认
 * 是 800x600（Chromium 文档化的默认值），这是个已知的强自动化指纹，而 `--window-size`
 * **抬不动它**——实测只有 `--screen-info` 能改（Chrome 142+）。`workAreaBottom=40`
 * 让 `screen.availHeight` 比 `screen.height` 小，模拟真实桌面的任务栏。
 * 注意命名参数是 workAreaTop/Bottom/Left/Right 四个分开写，写成 `workArea=` 会让
 * Chrome 直接启动失败。
 */
const HIDDEN_LAUNCH_ARGS = [
  "--headless=new",
  "--window-size=1400,900",
  "--screen-info={0,0 1920x1080 workAreaBottom=40}"
];

/** 有头模式下给个明确窗口尺寸，免得 Chrome 用上次记住的几何。 */
const HEADFUL_LAUNCH_ARGS = ["--window-size=1400,900"];

/**
 * 判断已在跑的这只浏览器是不是无头：读 `/json/version` 的 User-Agent，无头 Chrome 会
 * 报 `HeadlessChrome/<ver>` 而有头报 `Chrome/<ver>`（实测确认，且这是两种模式之间唯一
 * 的指纹差异）。
 *
 * 用它而不是读 RECRUIT_BROWSER_HIDDEN，是因为这只浏览器可能是别人（boss-cli /
 * liepin-cli）拉起的——要的是**实际状态**，不是本进程的意图。
 *
 * ⚠️ 一旦决定伪装 UA 来规避指纹，这个判据就失效，需要换信号（启动时写 sidecar 记录
 * 模式，或读页面的 screen 特征）。
 */
function readHeadless(version) {
  const ua = version?.["User-Agent"] ?? version?.userAgent;
  return typeof ua === "string" ? /HeadlessChrome/i.test(ua) : null;
}

const DEFAULT_SOURCES = [
  {
    name: "boss",
    port: 53470,
    match: /zhipin\.com/i,
    homeUrl: "https://www.zhipin.com/web/chat/index",
    userDataDir: path.join(homedir(), ".boss-cli", ".cache", "browser-data")
  }
];

const PROBE_TIMEOUT_MS = 900;
const COMMAND_TIMEOUT_MS = 6000;
/** screencast 静默超过这个时长就回落到主动截图（窗口最小化/被遮挡时会静默）。 */
const SCREENCAST_STALL_MS = 2500;
/** 拉起浏览器后探针超过这个时长仍未就绪，判定启动失败（复位 launching）。 */
const LAUNCH_TIMEOUT_MS = 15000;

/**
 * 合并 patch 配置与内置默认：patch 里的 source 只写差异（port/match），
 * userDataDir / homeUrl 等默认从 DEFAULT_SOURCES 补上；同名源不存在时
 * 原样保留（如未来的 liepin 源，仍由构造函数给兜底值）。
 */
function normalizeSources(configSources) {
  const list = Array.isArray(configSources) && configSources.length > 0 ? configSources : DEFAULT_SOURCES;
  return list.map((source) => ({ ...DEFAULT_SOURCES.find((d) => d.name === source.name), ...source }));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 常见 Chrome / Edge 安装位置（与 boss-cli 的探测顺序一致）。 */
function findChromeExecutable() {
  const fromEnv = process.env.CHROME_PATH?.trim() || process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const pf = process.env.PROGRAMFILES;
    const pf86 = process.env["PROGRAMFILES(X86)"];
    if (local) candidates.push(path.join(local, "Google", "Chrome", "Application", "chrome.exe"));
    if (pf) {
      candidates.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    if (pf86) {
      candidates.push(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge-stable"
    );
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 一个浏览器源（如 boss）的镜像：探测 CDP → 连接目标页 → 推帧 + 收输入。
 * 所有错误都被吞进 state.error，不影响宿主进程。
 */
export class BrowserMirror {
  constructor(source, config = {}) {
    this.name = source.name;
    this.port = clampInt(source.port, 53470, 1, 65535);
    this.match = source.match instanceof RegExp ? source.match : new RegExp(source.match ?? "", "i");
    this.homeUrl = typeof source.homeUrl === "string" ? source.homeUrl : "about:blank";
    this.userDataDir = typeof source.userDataDir === "string" ? source.userDataDir : null;
    this.quality = clampInt(config.jpegQuality, 80, 10, 100);
    this.maxWidth = clampInt(config.maxFrameWidth, 1800, 320, 4096);
    this.state = {
      name: this.name,
      connected: false,
      launching: false,
      browser: null,
      pages: [],
      targetId: null,
      targetTitle: null,
      targetUrl: null,
      /** 已连上的这只浏览器是否无头（null = 还没连上）。判据见 _readHeadless。 */
      headless: null,
      /** 页面 CSS 视口尺寸：客户端据此把面板坐标换算成页面坐标。 */
      viewport: { width: 0, height: 0 },
      /** 当前是否用 Emulation 把页面视口贴合到了面板尺寸。 */
      fitted: false,
      frameMode: "idle",
      lastFrameAt: 0,
      seq: 0,
      error: null
    };
    this._ws = null;
    this._wsTargetId = null;
    this._pending = new Map();
    this._commandSeq = 0;
    this._targetOverride = null;
    this._frame = null;
    this._subscribers = new Set();
    this._lastScreencastAt = 0;
    this._lastPollAt = 0;
    this._lastListAt = 0;
    this._fitRequest = null;
    this._appliedFit = null;
    this._clearedOnce = false;
    this._launchingSince = 0;
    this._everConnected = false;
    this._watch = false;
    this._relaunchAt = 0;
  }

  /** 面板是否在盯梢：打开时崩溃后自动重新拉起浏览器。 */
  setWatch(on) {
    this._watch = on === true;
  }

  /** 切换抓取目标（pageId 来自 state.pages[].id）。 */
  setTarget(pageId) {
    this._targetOverride = pageId || null;
    this._appliedFit = null;
    this._dropConnection();
  }

  /** 抓到的最后一帧（JPEG Buffer），没有则 null。 */
  get frame() {
    return this._frame;
  }

  /** MJPEG 订阅：返回退订函数。 */
  subscribe(sink) {
    this._subscribers.add(sink);
    if (this._frame) sink(this._frame);
    return () => this._subscribers.delete(sink);
  }

  _publish(buf) {
    this._frame = buf;
    this.state.lastFrameAt = Date.now();
    this.state.seq += 1;
    for (const sink of this._subscribers) {
      try {
        sink(buf);
      } catch {
        this._subscribers.delete(sink);
      }
    }
  }

  _dropConnection() {
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
    this._wsTargetId = null;
    this.state.frameMode = "idle";
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
      return (Array.isArray(targets) ? targets : []).filter(
        (t) => t?.type === "page" && !String(t.url ?? "").startsWith("chrome://") && !String(t.title ?? "").startsWith("chrome://")
      );
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

  _onEvent(msg) {
    if (msg.method === "Page.screencastFrame") {
      const meta = msg.params?.metadata ?? {};
      const width = Math.round(Number(meta.deviceWidth) || 0);
      const height = Math.round(Number(meta.deviceHeight) || 0);
      if (width > 0 && height > 0) this.state.viewport = { width, height };
      this._lastScreencastAt = Date.now();
      this.state.frameMode = "screencast";
      if (msg.params?.sessionId !== undefined) {
        this._command("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
      }
      if (typeof msg.params?.data === "string" && msg.params.data.length > 0) {
        const buf = Buffer.from(msg.params.data, "base64");
        if (buf.length > 0) this._publish(buf);
      }
      return;
    }
    if (msg.method === "Page.frameNavigated" && msg.params?.frame?.parentId === undefined) {
      this.state.targetUrl = msg.params.frame.url ?? this.state.targetUrl;
      this._lastListAt = 0; // 触发下一轮刷新标签标题
    }
  }

  async _ensureConnected() {
    const version = await this._probe();
    if (!version) {
      this.state.connected = false;
      this.state.browser = null;
      this.state.headless = null;
      this.state.pages = [];
      this.state.targetId = null;
      this.state.viewport = { width: 0, height: 0 };
      this.state.fitted = false;
      // 浏览器没在跑不是错误：清掉上次连接受损留下的误导性报错（如
      // "cdp not connected"），空态文案自己会说明该启动浏览器。
      this.state.error = null;
      this._appliedFit = null;
      this._dropConnection();
      return false;
    }
    this.state.launching = false;
    this.state.browser = version.Browser ?? version.browser ?? "unknown";
    this.state.headless = readHeadless(version);

    const needList = Date.now() - this._lastListAt > 2000 || this._ws === null;
    let pages = this._rawPages ?? [];
    if (needList) {
      pages = await this._listPages();
      this._rawPages = pages;
      this._lastListAt = Date.now();
      this.state.pages = pages.map((p) => ({ id: p.id, title: p.title ?? "", url: p.url ?? "" }));
    }
    const targetId = this._pickTarget(pages);
    this.state.targetId = targetId;
    if (targetId === null) {
      this.state.connected = false;
      this._dropConnection();
      return false;
    }
    const target = pages.find((p) => p.id === targetId);
    this.state.targetTitle = target?.title ?? null;
    if (needList) this.state.targetUrl = target?.url ?? null;

    if (this._ws && this._wsTargetId === targetId && this._ws.readyState === 1) return true;

    this._dropConnection();
    const wsUrl = target?.webSocketDebuggerUrl;
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
          return;
        }
        if (typeof msg?.method === "string") this._onEvent(msg);
      });
      ws.addEventListener("close", () => {
        if (this._ws === ws) {
          this._ws = null;
          this._wsTargetId = null;
          this.state.connected = false;
          this.state.frameMode = "idle";
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
      // 注意：不要发 Runtime.enable —— BOSS 反爬模块把它当调试器挂载信号，
      // 会主动杀掉整个浏览器（实测 0/4 存活）；不开它抓帧 4/4 全活。
      // Runtime.evaluate 等命令不需要 enable 也能用（镜像也不消费 Runtime 事件）。
      this._appliedFit = null;
      this._clearedOnce = false;
      await this._applyFit();
      await this._startScreencast();
      this.state.connected = true;
      this.state.error = null;
      this._everConnected = true;
      return true;
    } catch (error) {
      this.state.connected = false;
      this.state.error = String(error?.message ?? error);
      this._dropConnection();
      return false;
    }
  }

  async _startScreencast() {
    this._lastScreencastAt = Date.now();
    await this._command("Page.startScreencast", {
      format: "jpeg",
      quality: this.quality,
      maxWidth: this.maxWidth,
      maxHeight: this.maxWidth,
      everyNthFrame: 1
    });
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

  /** 请求把页面视口贴合到面板尺寸（客户端传 CSS 尺寸）；width<=0 表示取消贴合。 */
  requestFit(width, height, deviceScaleFactor) {
    if (!(width > 0) || !(height > 0)) {
      this._fitRequest = null;
      return;
    }
    const next = {
      width: clampInt(width, 1280, 320, 3840),
      height: clampInt(height, 900, 320, 3840),
      deviceScaleFactor: clampNum(deviceScaleFactor, 1.5, 1, 3)
    };
    const prev = this._fitRequest;
    // 抖动过滤：宽高变化不足 12px 不重设，避免拖动面板时刷屏。
    if (prev && Math.abs(prev.width - next.width) < 12 && Math.abs(prev.height - next.height) < 12 && prev.deviceScaleFactor === next.deviceScaleFactor) {
      return;
    }
    this._fitRequest = next;
  }

  async _applyFit() {
    const want = this._fitRequest;
    const applied = this._appliedFit;
    if (want === null) {
      // 覆盖可能是上一条 CDP 会话留下的（Chrome 不保证断开即还原），所以每条新
      // 会话在无贴合需求时都补发一次 clear，只发一次。
      if (applied !== null || !this._clearedOnce) {
        // 只发 clear 清不掉「别的（已断开）会话留下的」覆盖：先用 0 宽高把覆盖
        // 接管到本会话名下，再 clear 才会真的还原成窗口实际尺寸。
        await this._command("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
        await this._command("Emulation.clearDeviceMetricsOverride", {});
        this._appliedFit = null;
        this._clearedOnce = true;
        this.state.fitted = false;
      }
      return;
    }
    if (applied && applied.width === want.width && applied.height === want.height && applied.deviceScaleFactor === want.deviceScaleFactor) {
      return;
    }
    // 不传 screenWidth/screenHeight：传了会把 window.screen 一起盖成视口尺寸（958x1149
    // 这种竖屏、且 availHeight === height 没有任务栏），本身就是自动化指纹。实测不传时
    // innerWidth/innerHeight 依然精确等于 want，面板要的视口固定效果不变，而真实
    // screen（无头下由 --screen-info 给定）能透出来。
    const msg = await this._command("Emulation.setDeviceMetricsOverride", {
      width: want.width,
      height: want.height,
      deviceScaleFactor: want.deviceScaleFactor,
      mobile: false
    });
    if (msg?.error) {
      this.state.error = msg.error.message ?? "fit failed";
      return;
    }
    this._appliedFit = want;
    this._clearedOnce = false;
    this.state.fitted = true;
    this.state.viewport = { width: want.width, height: want.height };
  }

  /**
   * 主动抓一帧（screencast 静默时的兜底路径）。
   *
   * `fromSurface: false` 是**文档化的 headful-only**（"works only in headful mode"）：
   * 无头下没有可读像素的真实 view，会返回一张空/降级图。所以无头时不能退到这一跳——
   * 否则 fromSurface:true 失败的那一刻（正是需要兜底的时刻）会把废图当成有效帧发布出去，
   * 面板显示一张假画面，比没有兜底更糟。
   */
  async _pollFrame() {
    const msg = await this._command("Page.captureScreenshot", { format: "jpeg", quality: this.quality, fromSurface: true });
    let data = msg?.result?.data;
    if (!(typeof data === "string" && data.length > 0) && this.state.headless === false) {
      data = (await this._command("Page.captureScreenshot", { format: "jpeg", quality: this.quality, fromSurface: false }))?.result?.data;
    }
    if (typeof data === "string" && data.length > 0) {
      const buf = Buffer.from(data, "base64");
      if (buf.length > 0) {
        this.state.frameMode = "poll";
        this._publish(buf);
      }
    }
  }

  /** 页面 CSS 视口（贴合模式下即面板尺寸；否则读真实窗口）。 */
  async _refreshViewport() {
    if (this.state.viewport.width > 0 && this.state.frameMode === "screencast") return;
    const msg = await this._command("Runtime.evaluate", {
      expression: "JSON.stringify({w:innerWidth,h:innerHeight})",
      returnByValue: true
    });
    try {
      const { w, h } = JSON.parse(msg?.result?.result?.value ?? "{}");
      if (w > 0 && h > 0) this.state.viewport = { width: Math.round(w), height: Math.round(h) };
    } catch { /* ignore */ }
  }

  /** 看门狗一轮：保连接 → 应用贴合 → screencast 静默时兜底抓帧。 */
  async tick() {
    try {
      const ok = await this._ensureConnected();
      if (!ok) {
        // 启动后探针迟迟不就绪：复位 launching，免得空态永远转圈。
        if (this.state.launching && Date.now() - this._launchingSince > LAUNCH_TIMEOUT_MS) {
          this.state.launching = false;
          this.state.error = `浏览器启动超时：端口 ${this.port} 未就绪（检查是否有别的实例占用 boss profile）`;
        }
        // 自愈：面板在盯梢（watch）且浏览器曾连上过、又意外掉线（崩溃等），
        // 冷却后自动重新拉起；冷启动（从没连上过）仍走面板按钮。
        if (this._everConnected && this._watch && !this.state.launching && Date.now() - this._relaunchAt > 10000) {
          this._relaunchAt = Date.now();
          await this.launch();
        }
        return;
      }
      await this._applyFit();
      const now = Date.now();
      const stalled = now - this._lastScreencastAt > SCREENCAST_STALL_MS;
      if (stalled && this._subscribers.size > 0 && now - this._lastPollAt > 700) {
        this._lastPollAt = now;
        await this._pollFrame();
        // 顺手重开一次 screencast：窗口重新可见后能自动回到推流模式。
        if (now - this._lastScreencastAt > SCREENCAST_STALL_MS * 4) await this._startScreencast();
      }
      await this._refreshViewport();
    } catch (error) {
      this.state.error = String(error?.message ?? error);
      this.state.connected = false;
    }
  }

  /** 面板坐标（0..1 归一化）→ 页面 CSS 坐标。 */
  _toPageXY(nx, ny) {
    const vw = this.state.viewport.width || 1280;
    const vh = this.state.viewport.height || 900;
    return {
      x: Math.max(0, Math.min(vw, clampNum(nx, 0, -1, 2) * vw)),
      y: Math.max(0, Math.min(vh, clampNum(ny, 0, -1, 2) * vh))
    };
  }

  /** 批量派发输入事件（顺序即 TCP 顺序，不等回执）。 */
  dispatchInput(events) {
    if (!Array.isArray(events)) return 0;
    let sent = 0;
    for (const ev of events.slice(0, 200)) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.kind === "mouse") {
        const { x, y } = this._toPageXY(ev.nx, ev.ny);
        const vw = this.state.viewport.width || 1280;
        const vh = this.state.viewport.height || 900;
        const params = {
          type: ev.type,
          x,
          y,
          button: ev.button ?? "none",
          buttons: clampInt(ev.buttons, 0, 0, 31),
          clickCount: clampInt(ev.clickCount, 0, 0, 3),
          modifiers: clampInt(ev.modifiers, 0, 0, 15)
        };
        if (ev.type === "mouseWheel") {
          params.deltaX = clampNum(ev.ndx, 0, -10, 10) * vw;
          params.deltaY = clampNum(ev.ndy, 0, -10, 10) * vh;
        }
        this._command("Input.dispatchMouseEvent", params);
        sent += 1;
        continue;
      }
      if (ev.kind === "key") {
        this._command("Input.dispatchKeyEvent", {
          type: ev.type,
          key: typeof ev.key === "string" ? ev.key : undefined,
          code: typeof ev.code === "string" ? ev.code : undefined,
          windowsVirtualKeyCode: clampInt(ev.keyCode, 0, 0, 255),
          nativeVirtualKeyCode: clampInt(ev.keyCode, 0, 0, 255),
          text: typeof ev.text === "string" ? ev.text : undefined,
          unmodifiedText: typeof ev.text === "string" ? ev.text : undefined,
          autoRepeat: ev.autoRepeat === true,
          isKeypad: ev.isKeypad === true,
          location: clampInt(ev.location, 0, 0, 3),
          modifiers: clampInt(ev.modifiers, 0, 0, 15)
        });
        sent += 1;
        continue;
      }
      if (ev.kind === "text" && typeof ev.text === "string" && ev.text.length > 0) {
        this._command("Input.insertText", { text: ev.text.slice(0, 4096) });
        sent += 1;
      }
    }
    return sent;
  }

  async navigate(url) {
    if (typeof url !== "string" || url.length === 0) return { ok: false, error: "empty url" };
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    const msg = await this._command("Page.navigate", { url: target });
    return msg?.error ? { ok: false, error: msg.error.message } : { ok: true };
  }

  async reload() {
    await this._command("Page.reload", {});
    return { ok: true };
  }

  /** 前进/后退：读导航历史后跳到相邻条目。 */
  async history(delta) {
    const msg = await this._command("Page.getNavigationHistory", {});
    const entries = msg?.result?.entries;
    const index = msg?.result?.currentIndex;
    if (!Array.isArray(entries) || typeof index !== "number") return { ok: false, error: "no history" };
    const next = index + delta;
    if (next < 0 || next >= entries.length) return { ok: false, error: "history boundary" };
    await this._command("Page.navigateToHistoryEntry", { entryId: entries[next].id });
    return { ok: true };
  }

  async bringToFront() {
    await this._command("Page.bringToFront", {});
    return { ok: true };
  }

  async newTab(url) {
    const target = typeof url === "string" && url.length > 0 ? url : this.homeUrl;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(target)}`, { method: "PUT" });
      if (!res.ok) return { ok: false, error: `new tab: HTTP ${res.status}` };
      const created = await res.json();
      this._lastListAt = 0;
      if (created?.id) this.setTarget(created.id);
      return { ok: true, id: created?.id ?? null };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async closeTab(pageId) {
    if (typeof pageId !== "string" || pageId.length === 0) return { ok: false, error: "no pageId" };
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(pageId)}`);
      if (this._targetOverride === pageId) this._targetOverride = null;
      this._lastListAt = 0;
      this._dropConnection();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 拉起浏览器：与 boss-cli 同一 user-data-dir 和调试端口，因此后续 boss 命令
   * 会直连这只实例（同一登录态），不会另开一只。
   */
  async launch() {
    if (this.state.connected) return { ok: true, already: true };
    if (await this._probe()) return { ok: true, already: true };
    if (!this.userDataDir) return { ok: false, error: `源「${this.name}」未配置 userDataDir，无法拉起浏览器` };
    const exe = findChromeExecutable();
    if (!exe) return { ok: false, error: "未找到本机 Chrome/Edge：请设置 CHROME_PATH" };
    const args = [
      ...CHROME_LAUNCH_ARGS,
      ...(hiddenModeEnabled() ? HIDDEN_LAUNCH_ARGS : HEADFUL_LAUNCH_ARGS),
      `--user-data-dir=${this.userDataDir}`,
      `--remote-debugging-port=${this.port}`,
      this.homeUrl
    ];
    try {
      const proc = spawn(exe, args, { detached: true, stdio: "ignore", env: process.env });
      proc.unref();
      this.state.launching = true;
      this._launchingSince = Date.now();
      this.state.error = null;
      return { ok: true, pid: proc.pid ?? null };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  dispose() {
    this._subscribers.clear();
    // 插件卸载/DSH 退出时把视口还原，别让真实浏览器卡在面板尺寸。
    if (this._appliedFit !== null) {
      this._command("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
      this._command("Emulation.clearDeviceMetricsOverride", {});
      this._command("Page.stopScreencast", {});
      this._appliedFit = null;
      this.state.fitted = false;
    }
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
  const name = url.searchParams.get("source");
  return typeof name === "string" && name.length > 0 ? name : "boss";
}

function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const MJPEG_BOUNDARY = "rcpframe";

/** MJPEG 长连接：每来一帧写一段 multipart；写不动就丢帧，不排队。 */
function streamMjpeg(mirror, req, res) {
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    "cache-control": "no-store, no-transform",
    connection: "close",
    pragma: "no-cache"
  });
  let backedUp = false;
  res.on("drain", () => { backedUp = false; });
  const unsubscribe = mirror.subscribe((buf) => {
    if (backedUp || res.writableEnded) return;
    const head = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
    res.write(head);
    const ok = res.write(buf);
    res.write("\r\n");
    if (!ok) backedUp = true;
  });
  const stop = () => {
    unsubscribe();
    try {
      res.end();
    } catch { /* ignore */ }
  };
  req.on("close", stop);
  req.on("error", stop);
  res.on("error", stop);
}

/**
 * /plugins/recruiting-view/* 路由处理器。
 * @param mirrors - 各浏览器源的 BrowserMirror 列表。
 */
function makeRouteHandler(mirrors) {
  const pick = (url) => mirrors.find((m) => m.name === sourceNameFrom(url)) ?? mirrors[0];
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.local");
    const pathname = url.pathname;
    const mirror = pick(url);

    if (pathname.endsWith("/state.json")) {
      sendJson(res, 200, { sources: mirrors.map((m) => m.state), ts: Date.now() });
      return;
    }
    if (pathname.endsWith("/stream.mjpg")) {
      if (!mirror) {
        sendJson(res, 404, { ok: false, error: "no source" });
        return;
      }
      streamMjpeg(mirror, req, res);
      return;
    }
    if (pathname.endsWith("/frame.jpg")) {
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
    if (pathname.endsWith("/input")) {
      const body = await readJsonBody(req);
      if (body === null || !mirror) {
        sendJson(res, 400, { ok: false, error: "bad input body" });
        return;
      }
      const sent = mirror.dispatchInput(body.events);
      sendJson(res, 200, { ok: true, sent, viewport: mirror.state.viewport });
      return;
    }
    if (pathname.endsWith("/control")) {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      if (body === null || !mirror) {
        sendJson(res, 400, { ok: false, error: "bad control body" });
        return;
      }
      const action = String(body.action ?? url.searchParams.get("action") ?? "");
      let result = { ok: false, error: `unknown action "${action}"` };
      if (action === "launch") result = await mirror.launch();
      else if (action === "navigate") result = await mirror.navigate(body.url);
      else if (action === "reload") result = await mirror.reload();
      else if (action === "back") result = await mirror.history(-1);
      else if (action === "forward") result = await mirror.history(1);
      else if (action === "activate") result = await mirror.bringToFront();
      else if (action === "new-tab") result = await mirror.newTab(body.url);
      else if (action === "close-tab") result = await mirror.closeTab(body.pageId);
      else if (action === "set-target") {
        mirror.setTarget(body.pageId);
        result = { ok: true };
      } else if (action === "fit") {
        mirror.requestFit(body.width, body.height, body.deviceScaleFactor);
        result = { ok: true };
      } else if (action === "unfit") {
        mirror.requestFit(0, 0, 1);
        result = { ok: true };
      } else if (action === "watch") {
        mirror.setWatch(body.on === true);
        result = { ok: true };
      }
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (pathname.endsWith("/set-target")) {
      mirror?.setTarget(url.searchParams.get("pageId"));
      sendJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}

/**
 * cordis 插件主体：注册 /plugins/recruiting-view/* 路由并跑镜像看门狗。
 * @param ctx - cordis 上下文。
 * @param rawConfig - profile 补丁里该 entry 的 config。
 */
export function apply(ctx, rawConfig = {}) {
  const config = rawConfig ?? {};
  const sources = normalizeSources(config.sources);
  const intervalMs = clampInt(config.watchdogIntervalMs ?? config.frameIntervalMs, 700, 200, 30000);
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

export { NAME, inject, normalizeSources, hiddenModeEnabled, readHeadless };
