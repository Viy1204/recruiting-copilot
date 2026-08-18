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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
  },
  {
    name: "liepin",
    // liepin-cli 的固定 CDP 调试端口（LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT 可覆盖），
    // 紧跟 boss 的 53470。旧版 liepin-cli 用 puppeteer.launch() 分配随机端口，探不到。
    port: 53471,
    match: /liepin\.com/i,
    // 招聘者端落地页；也是 liepin-cli 里出现最多的页面
    homeUrl: "https://lpt.liepin.com/recommend",
    userDataDir: path.join(homedir(), ".liepin-cli", "user-data")
  }
];

const PROBE_TIMEOUT_MS = 900;
const COMMAND_TIMEOUT_MS = 6000;
/** screencast 静默超过这个时长就回落到主动截图（窗口最小化/被遮挡时会静默）。 */
const SCREENCAST_STALL_MS = 2500;
/** 回读页面 CSS 视口的节流间隔：坐标换算的分母，贴合或缩放变化后要尽快跟上。 */
const VIEWPORT_REFRESH_MS = 2000;
/**
 * 风控/验证页的 URL 形态（照 boss-cli 的 `RISK_NAVIGATION_RE` 抄，见
 * `boss-cli-repo/src/common/boss_page_guards.ts`）。命中即熔断，见 `_checkRiskUrl`。
 *
 * **不含 `about:blank`**：boss-cli 把它也当风险信号（风控会把主 frame 推去空白页），
 * 但在面板里 `about:blank` 是新标签的正常初始态，算进来会把面板自己锁死。
 *
 * 猎聘的风控形态一次都没观测过，所以这里只有 BOSS 的模式——对猎聘不会命中，也不添乱。
 */
const RISK_URL_RE =
  /\/web\/common\/(?:403|nonsupport)\.html|\/web\/user\/safe\/verify|\/web\/passport\/(?:zp\/(?:403|verify|security)\.html|cm\/(?:403|verify|security-check)\.html)/i;
/**
 * 熔断期间仍然允许的控制动作。
 *
 * 判据是「会不会对招聘站产生新的访问」：`watch`（关盯梢）、`clear-risk`（人工解除）、
 * `set-target`（只切抓取目标并断开重连）都不会；其余全拒——包括 `fit`/`unfit`，
 * 它们会让页面 resize，而秒级反复 resize 本身就是把账号推向风控的动作之一。
 */
const RISK_ALLOWED_ACTIONS = new Set(["watch", "clear-risk", "set-target"]);
/**
 * 回读视口偏离贴合基准多少像素算「覆盖没了」。
 *
 * 判据不能是「回读值 === 覆盖尺寸」——页面缩放叠在覆盖之上，两者合法地不相等
 * （958 覆盖 + 90% 缩放 = 1064，见 #28）。所以记住贴合当时回读到的值当基准，
 * 之后只看有没有偏离。阈值要盖过滚动条出现/消失那十几像素，又要小于缩放换一档
 * （最小 90%→100%，约 10%）与覆盖被清掉（通常几百像素）。
 */
const FIT_DRIFT_PX = 24;
/**
 * 连续这么多次重发都稳不住就停手。
 *
 * 无限重发会复刻引发账号被弹 403 的那个成因：反复 setDeviceMetricsOverride 让页面
 * 秒级内反复 resize。真有第三方在抢覆盖（如并挂第二个 host）时，重发赢不了，
 * 只能停下来把话说清楚。
 */
const FIT_DRIFT_LIMIT = 3;
/** 拉起浏览器后探针超过这个时长仍未就绪，判定启动失败（复位 launching）。 */
const LAUNCH_TIMEOUT_MS = 15000;

/**
 * CLI 占用锁的共享目录。三方（本插件 / boss-cli / liepin-cli）共用同一约定，
 * 与 `RECRUIT_BROWSER_HIDDEN` 同样的做法：CLI 命令开始时写 `<source>.busy.json`，
 * 结束时删掉；面板读它来判断「此刻有没有命令正在操作同一只浏览器」。
 *
 * 进程被 kill 会留下僵尸锁，所以**光有文件不算数**——必须 pid 还活着。
 * 这样既不需要 CLI 保证一定能跑完清理逻辑，也不会把面板永久锁死。
 */
const BUSY_DIR = path.join(homedir(), ".recruit-browser");

/** 锁文件里的 pid 是否还活着。signal 0 只做权限/存在性检查，不真的发信号。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于本用户，仍然算活着
    return error?.code === "EPERM";
  }
}

/**
 * 读某个源的 CLI 占用锁。返回 null 表示空闲。
 * 锁存在但 pid 已死时顺手删掉——僵尸锁不该让面板一直拒绝切换。
 */
function readBusyLock(sourceName, now = Date.now()) {
  const file = path.join(BUSY_DIR, `${sourceName}.busy.json`);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    try { unlinkSync(file); } catch { /* 并发删除，忽略 */ }
    return null;
  }
  if (!pidAlive(lock?.pid)) {
    try { unlinkSync(file); } catch { /* 并发删除，忽略 */ }
    return null;
  }
  const startedAt = Number(lock.startedAt) || now;
  return {
    command: typeof lock.command === "string" ? lock.command : "(未命名命令)",
    pid: lock.pid,
    startedAt,
    ageMs: Math.max(0, now - startedAt)
  };
}

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
      /** 此刻是否有 CLI 命令在操作同一只浏览器（读共享锁，null = 空闲）。 */
      busy: null,
      /**
       * 熔断状态：观测到风控/验证页后置上，`{ url, at }`；null = 正常。
       *
       * 置上之后 host 停掉一切自动动作（自愈重启、贴合重发）并拒绝会产生访问的控制动作。
       * 画面照常推——用户要看得见发生了什么，才知道该去做什么。
       */
      risk: null,
      lastFrameAt: 0,
      seq: 0,
      error: null
    };
    this._ws = null;
    this._wsTargetId = null;
    this._pending = new Map();
    this._commandSeq = 0;
    this._targetOverride = null;
    /** setMode 重启后要回到的页面（只用一次，见 tick）。 */
    this._pendingHomeUrl = null;
    this._frame = null;
    this._subscribers = new Set();
    /** 当前这一路 MJPEG 的关闭函数（一个源同时只保留一路，见 takeoverStream）。 */
    this._streamStop = null;
    this._lastScreencastAt = 0;
    this._lastPollAt = 0;
    this._lastListAt = 0;
    this._fitRequest = null;
    this._appliedFit = null;
    /** 贴合当时回读到的视口，用作「覆盖还在不在」的基准（null = 还没测到）。 */
    this._fitBaseline = null;
    /** 上次判定失真时观测到的视口：用来看重发到底有没有生效。 */
    this._fitDriftAt = null;
    this._fitDriftCount = 0;
    /** 反复重发也稳不住后停手，等用户重按贴合或换连接才再试。 */
    this._fitGaveUp = false;
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

  /**
   * 看到风控/验证页就熔断：停掉一切自动动作，等人处理。
   *
   * 为什么必须有这个：boss-cli 那套保护（拦风控 SDK、把 6 个上报端点 204、注入守卫、
   * 三重熔断）全部挂在 CLI 进程自己的 CDP session 上，**进程一退出就全部失效**。
   * 面板和 host 从来不在那套保护之下，所以 host 至少要做到「平台说停就真的停」——
   * 这件事不是伪装成人类，是不再自己制造异常信号。
   *
   * 2026-08-18 的教训：账号被限期间，`boss shutdown` 关掉浏览器 16 秒后就被看门狗的
   * 自愈逻辑重新拉起（homeUrl 就是招聘站），限制被一路延长。没有任何一方在看到 403
   * 之后停手。
   */
  _checkRiskUrl(url) {
    if (typeof url !== "string" || url === "" || !RISK_URL_RE.test(url)) return;
    if (this.state.risk !== null) return;
    this.state.risk = { url, at: Date.now() };
    this.state.error =
      `检测到风控/验证页（${url}）。已停止本源的一切自动动作：不再自动重启浏览器、不再重发贴合、` +
      "拒绝导航与启动。请在浏览器里人工处理完，再点提示条上的解除。";
  }

  /** 人工确认处理完了：解除熔断。只有用户显式操作才走到这里。 */
  clearRisk() {
    if (this.state.risk === null) return { ok: true, already: true };
    this.state.risk = null;
    this.state.error = null;
    return { ok: true };
  }

  /**
   * 忘掉贴合缓存。
   *
   * 连接、抓取目标或浏览器进程换掉之后，之前那个覆盖不可能还在，缓存留着就会让
   * `_applyFit` 的早退分支命中、不再重发（就是 #30 那个「以为自己贴合了」）。
   */
  _resetFitCache() {
    this._appliedFit = null;
    this._fitBaseline = null;
    this._fitDriftAt = null;
    this._fitDriftCount = 0;
    this._fitGaveUp = false;
  }

  /** 切换抓取目标（pageId 来自 state.pages[].id）。 */
  setTarget(pageId) {
    this._targetOverride = pageId || null;
    this._resetFitCache();
    this._dropConnection();
  }

  /** 抓到的最后一帧（JPEG Buffer），没有则 null。 */
  get frame() {
    return this._frame;
  }

  /**
   * 接管本源的 MJPEG 通道：新的一路到来就把旧的那路关掉。
   *
   * 面板对一个源同时只显示一路画面，所以旧连接必然是废的。必须主动挤掉——客户端把
   * `<img>` 从 DOM 摘掉时 Chrome 不保证中断 multipart 请求，旧连接会连着却不再读取，
   * 占满浏览器的同源连接槽（HTTP/1.1 约 6 条），新 stream 就抢不到连接，表现为
   * 「切源卡顿，然后所有源都没画面」。
   *
   * 光靠背压超时回收不够：实测对面不读时，loopback 的内核缓冲能吞掉 1MB 以上才让
   * `res.write()` 返回 false（约 40 秒的帧量），那期间连接槽一直被占着。挤掉是即时的。
   */
  takeoverStream(stop) {
    const prev = this._streamStop;
    this._streamStop = stop;
    if (prev !== null && prev !== stop) prev();
  }

  /** 本路 MJPEG 自己结束时把登记撤掉（别把后来者的通道误清了）。 */
  releaseStream(stop) {
    if (this._streamStop === stop) this._streamStop = null;
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
      // 不用 metadata.deviceWidth/Height 当视口：它描述的是被抓取的**画面**尺寸，
      // 不是页面的 CSS 视口。两者在页面缩放不等于 100% 时会差一个 zoom 因子，
      // 而 `_toPageXY` 拿视口当分母——差多少，点击就偏多少。视口一律以页面
      // 自己报的 innerWidth/innerHeight 为准（见 `_refreshViewport`）。
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
      this._checkRiskUrl(this.state.targetUrl);
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
      this._resetFitCache();
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
    // 兜底：上一条 CLI 命令（或上一个 DSH 会话）可能已经把页面留在风控页上，
    // 那次导航的 frameNavigated 我们没在场，只能靠轮询到的 URL 认出来。
    this._checkRiskUrl(this.state.targetUrl);

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
      this._resetFitCache();
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
      this._fitGaveUp = false;
      this._fitDriftCount = 0;
      this._fitDriftAt = null;
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
    // 用户改了尺寸就是「再试一次」，把停手状态放开。
    this._fitGaveUp = false;
    this._fitDriftCount = 0;
    this._fitDriftAt = null;
  }

  async _applyFit() {
    // 熔断期间不动视口：反复 resize 本身就是把账号推向风控的动作之一。
    if (this.state.risk !== null) return;
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
    // 抢不过第三方时停手，别用重发跟它对刷（见 FIT_DRIFT_LIMIT）。
    if (this._fitGaveUp) return;
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
    // 基准先作废：紧接着那次回读是用来建立新基准的，不能拿旧基准判它失真。
    this._fitBaseline = null;
    // 不能假定 `innerWidth === want.width`：Chrome 的**每源页面缩放**会叠在
    // `setDeviceMetricsOverride` 之上，实测 zhipin.com 存着 90% 缩放时，覆盖
    // 958×1149 得到的 CSS 视口是 1064×1276（= 958/0.9）。假定下去分母小 10%，
    // 点击就落在光标左上方，离原点越远偏越多。强制立刻回读一次真实视口。
    this._lastViewportAt = 0;
    await this._refreshViewport();
    // 回读到了才立基准；回读失败时留空，宁可这一轮不做失真判定，也不能拿 0×0
    // 当基准——那会把之后任何正常回读都判成失真，变成无限重发。
    const vp = this.state.viewport;
    if (!(vp.width > 0 && vp.height > 0)) return;
    // 重发后视口和失真时一模一样，说明这次覆盖压根没生效（对面清得比我们发得快，
    // 或者覆盖被拒）。不能就这样立基准——基准立在「没贴合」的尺寸上，之后每次判定
    // 都会通过，于是又退回 #30 那个 fitted 说谎的状态，只是这回还多了一次无效重发。
    const drift = this._fitDriftAt;
    if (drift && Math.abs(vp.width - drift.width) < FIT_DRIFT_PX && Math.abs(vp.height - drift.height) < FIT_DRIFT_PX) {
      this.state.fitted = false;
      // 缓存也要作废：留着 want 会让早退分支命中，而基准为空又让失真判定瘫掉，
      // 结果卡在「没贴合、也不再重试、还谁都不报错」。
      this._appliedFit = null;
      this._countFitDrift();
      return;
    }
    this._fitBaseline = { width: vp.width, height: vp.height };
    this._fitDriftAt = null;
  }

  /** 记一次贴合没稳住；超过上限就停手。 */
  _countFitDrift() {
    this._fitDriftCount += 1;
    if (this._fitDriftCount <= FIT_DRIFT_LIMIT) return;
    this._fitGaveUp = true;
    this.state.error =
      `贴合反复被清掉（${this._fitDriftCount} 次），已停止重发：` +
      "多半有第二个程序在操作同一只浏览器（别并挂第二个 host），也可能是真窗口里改了页面缩放。";
  }

  /**
   * 覆盖还在不在：拿回读视口和贴合基准比。
   *
   * 偏离了说明覆盖被清掉（第三方接管、导航重置、崩溃重连）或页面缩放被改动，
   * 两种情况都该重发。这里只作废缓存，重发交给 tick 里既有的 `_applyFit`，
   * 免得判定路径上再多一条发命令的入口。
   */
  _checkFitDrift() {
    const base = this._fitBaseline;
    if (this._appliedFit === null || base === null) return;
    const vp = this.state.viewport;
    if (Math.abs(vp.width - base.width) < FIT_DRIFT_PX && Math.abs(vp.height - base.height) < FIT_DRIFT_PX) {
      this._fitDriftCount = 0;
      return;
    }
    this._appliedFit = null;
    this._fitBaseline = null;
    this._fitDriftAt = { width: vp.width, height: vp.height };
    this.state.fitted = false;
    this._countFitDrift();
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

  /**
   * 页面 CSS 视口——`_toPageXY` 的分母，坐标准不准全看它。
   *
   * 唯一可信的来源是页面自己报的 `innerWidth/innerHeight`：贴合的目标尺寸会被页面缩放
   * 改写，screencast 的 metadata 说的又是画面尺寸而非 CSS 视口，两个都不能拿来当分母。
   * 原先这里在 screencast 模式下直接返回，于是贴合写进去的错值一直没机会被纠正
   * （poll 模式反而是对的，因为每轮都会走到这里）。现在不分模式一律回读，按 2s 节流。
   */
  async _refreshViewport() {
    const now = Date.now();
    if (now - (this._lastViewportAt ?? 0) < VIEWPORT_REFRESH_MS) return;
    this._lastViewportAt = now;
    const msg = await this._command("Runtime.evaluate", {
      expression: "JSON.stringify({w:innerWidth,h:innerHeight})",
      returnByValue: true
    });
    try {
      const { w, h } = JSON.parse(msg?.result?.result?.value ?? "{}");
      if (w > 0 && h > 0) {
        this.state.viewport = { width: Math.round(w), height: Math.round(h) };
        this._checkFitDrift();
      }
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
        // 熔断期间绝不自愈：homeUrl 就是招聘站，被限期间每次拉起都是一次新的访问，
        // 只会把恢复时间越推越远（2026-08-18 实测）。
        if (this.state.risk === null && this._everConnected && this._watch && !this.state.launching && Date.now() - this._relaunchAt > 10000) {
          this._relaunchAt = Date.now();
          await this.launch();
        }
        return;
      }
      // 切换模式重启后回到切换前那一页（setMode 记下的），只做一次。
      if (this._pendingHomeUrl && this.state.connected) {
        const url = this._pendingHomeUrl;
        this._pendingHomeUrl = null;
        await this.navigate(url);
      }
      await this._applyFit();
      const now = Date.now();
      this.state.busy = readBusyLock(this.name, now);
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
        // `force` 决定页面拿到的 PointerEvent.pressure。不传时 CDP 默认 0，
        // 而真实鼠标按住时规范值是 0.5——实测面板按下全是 0、真手全是 0.5，
        // 是面板与真实输入之间唯一一处干净的结构性差异（#22）。
        if (params.buttons > 0) params.force = 0.5;
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
  async launch(hidden = null) {
    if (this.state.connected) return { ok: true, already: true };
    if (await this._probe()) return { ok: true, already: true };
    if (!this.userDataDir) return { ok: false, error: `源「${this.name}」未配置 userDataDir，无法拉起浏览器` };
    const exe = findChromeExecutable();
    if (!exe) return { ok: false, error: "未找到本机 Chrome/Edge：请设置 CHROME_PATH" };
    const args = [
      ...CHROME_LAUNCH_ARGS,
      ...((hidden ?? hiddenModeEnabled()) ? HIDDEN_LAUNCH_ARGS : HEADFUL_LAUNCH_ARGS),
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

  /** 关掉整只浏览器（浏览器级 CDP 会话发 Browser.close；页面级会话没有这个域）。 */
  async _closeBrowser() {
    const version = await this._probe();
    if (!version) return true; // 已经没了
    return await new Promise((resolve) => {
      let ws;
      const done = (ok) => {
        try { ws?.close(); } catch { /* ignore */ }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), COMMAND_TIMEOUT_MS);
      try {
        ws = new WebSocket(version.webSocketDebuggerUrl);
        ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} })));
        // Browser.close 之后连接会被关掉，收不到回执才是正常的
        ws.addEventListener("close", () => { clearTimeout(timer); done(true); });
        ws.addEventListener("error", () => { clearTimeout(timer); done(false); });
      } catch {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /**
   * 切换有头 / 无头。
   *
   * Chrome 起来之后不能热切模式，只能关掉重开，所以这个动作**必然**会打断这只浏览器上
   * 正在进行的一切。因此：
   *
   * 1. 有 CLI 命令正在操作同一只浏览器时**直接拒绝**并说明是哪条、跑了多久（#23 定的锁）。
   *    不排队等待——一条寻源命令可能跑几分钟，按钮点下去没反应比报错更糟。
   * 2. 关掉之前记住当前 URL，起来之后导航回去，否则每次切换都要手动找回页面。
   * 3. 登录态在 user-data-dir 里，关掉重启不会丢。
   */
  async setMode(hidden) {
    const want = hidden === true;
    const busy = readBusyLock(this.name);
    if (busy) {
      const secs = Math.round(busy.ageMs / 1000);
      return {
        ok: false,
        busy,
        error: `「${busy.command}」正在操作这只浏览器（已跑 ${secs}s，pid ${busy.pid}）。` +
          `切换模式要关掉浏览器重开，会打断它。等它结束，或先停掉它再切。`
      };
    }
    if (this.state.connected && this.state.headless === want) {
      return { ok: true, already: true, headless: want };
    }
    const back = this.state.targetUrl && this.state.targetUrl !== "about:blank" ? this.state.targetUrl : this.homeUrl;
    const closed = await this._closeBrowser();
    if (!closed) return { ok: false, error: "关闭浏览器失败：可能有别的程序占着调试端口" };
    this._dropConnection();
    this._resetFitCache();
    // 端口释放要一点时间，没等到就 launch 会撞上「已存在实例」的探测分支
    for (let i = 0; i < 20 && (await this._probe()); i++) await new Promise((r) => setTimeout(r, 250));
    const launched = await this.launch(want);
    if (!launched.ok) return launched;
    this._pendingHomeUrl = back;
    return { ok: true, headless: want, restoring: back };
  }

  dispose() {
    this._streamStop?.();
    this._streamStop = null;
    this._subscribers.clear();
    // 插件卸载/DSH 退出时把视口还原，别让真实浏览器卡在面板尺寸。
    if (this._appliedFit !== null) {
      this._command("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
      this._command("Emulation.clearDeviceMetricsOverride", {});
      this._command("Page.stopScreencast", {});
      this._resetFitCache();
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
/**
 * 写不动（backedUp）持续超过这个时长就断掉该连接。
 *
 * 这是第三道防线，不是主力：僵尸连接主要靠客户端显式掐断（client.js 的 setImgEl）和
 * 本源只保留一路（takeoverStream）解决。留着它是为了兜住「连接一直在但再没有新 stream
 * 来挤掉它」这种情况——注意实测对面不读时 loopback 内核缓冲能吞 1MB 以上才让
 * `res.write()` 返回 false（约 40 秒的帧量），所以它触发得很慢，不能当主要手段。
 */
const STREAM_STALL_MS = 8000;

/** MJPEG 长连接：每来一帧写一段 multipart；写不动就丢帧，不排队。 */
function streamMjpeg(mirror, req, res) {
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    "cache-control": "no-store, no-transform",
    connection: "close",
    pragma: "no-cache"
  });
  let backedUp = false;
  let backedUpSince = 0;
  res.on("drain", () => {
    backedUp = false;
    backedUpSince = 0;
  });
  let unsubscribe = () => {};
  const stop = () => {
    unsubscribe();
    mirror.releaseStream(stop);
    try {
      res.end();
    } catch { /* ignore */ }
  };
  // 挤掉这个源上一路（大概率已经是客户端摘掉 <img> 后残留的僵尸）
  mirror.takeoverStream(stop);
  unsubscribe = mirror.subscribe((buf) => {
    if (res.writableEnded) return;
    if (backedUp) {
      // 一直写不动说明对面不读了（`<img>` 被摘掉但连接没断）。断掉它，否则这条僵尸
      // 会一直占着浏览器的同源连接槽和本镜像的订阅者。
      if (Date.now() - backedUpSince > STREAM_STALL_MS) stop();
      return;
    }
    const head = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
    res.write(head);
    const ok = res.write(buf);
    res.write("\r\n");
    if (!ok) {
      backedUp = true;
      backedUpSince = Date.now();
    }
  });
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
      // 熔断期间只放行不产生访问的动作（见 RISK_ALLOWED_ACTIONS）。
      if (mirror.state.risk !== null && !RISK_ALLOWED_ACTIONS.has(action)) {
        sendJson(res, 409, {
          ok: false,
          error: `已因风控页熔断（${mirror.state.risk.url}）：「${action}」会对招聘站产生新的访问，已拒绝。人工处理完再解除。`
        });
        return;
      }
      if (action === "clear-risk") result = mirror.clearRisk();
      else if (action === "launch") result = await mirror.launch();
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
      } else if (action === "set-mode") {
        result = await mirror.setMode(body.hidden === true);
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

export { NAME, inject, normalizeSources, hiddenModeEnabled, readHeadless, streamMjpeg, readBusyLock, BUSY_DIR };
