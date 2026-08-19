/**
 * BrowserMirror 单测：只桩掉 _command，验证对外行为——坐标换算、输入参数、
 * 贴合/还原的 CDP 调用序列。不需要真浏览器。
 *
 *   node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserMirror, normalizeSources, hiddenModeEnabled, readHeadless, streamMjpeg, readBusyLock, BUSY_DIR } from "../lib/index.js";

/** 造一只不连 CDP 的 mirror，记录所有下发的命令。 */
function stubMirror(viewport = { width: 1000, height: 800 }) {
  const mirror = new BrowserMirror({ name: "test", port: 1, match: /x/ });
  const calls = [];
  mirror._command = (method, params) => {
    calls.push({ method, params });
    return Promise.resolve({ result: {} });
  };
  mirror.state.viewport = viewport;
  return { mirror, calls };
}

test("鼠标坐标按视口反归一化，越界被夹住", () => {
  const { mirror, calls } = stubMirror();
  mirror.dispatchInput([
    { kind: "mouse", type: "mouseMoved", nx: 0.25, ny: 0.5 },
    { kind: "mouse", type: "mousePressed", nx: 1.4, ny: -0.3, button: "left", buttons: 1, clickCount: 2 }
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    { x: calls[0].params.x, y: calls[0].params.y },
    { x: 250, y: 400 }
  );
  assert.deepEqual(
    { x: calls[1].params.x, y: calls[1].params.y, clickCount: calls[1].params.clickCount },
    { x: 1000, y: 0, clickCount: 2 }
  );
});

test("按住键时带 force，未按住不带——决定页面拿到的 PointerEvent.pressure", () => {
  const { mirror, calls } = stubMirror();
  mirror.dispatchInput([
    { kind: "mouse", type: "mouseMoved", nx: 0.5, ny: 0.5, buttons: 0 },
    { kind: "mouse", type: "mousePressed", nx: 0.5, ny: 0.5, button: "left", buttons: 1, clickCount: 1 },
    { kind: "mouse", type: "mouseMoved", nx: 0.6, ny: 0.5, buttons: 1 },
    { kind: "mouse", type: "mouseReleased", nx: 0.6, ny: 0.5, button: "left", buttons: 0, clickCount: 1 }
  ]);
  assert.equal(calls[0].params.force, undefined);
  assert.equal(calls[1].params.force, 0.5);
  assert.equal(calls[2].params.force, 0.5);
  assert.equal(calls[3].params.force, undefined);
});

test("滚轮增量按视口尺寸放大", () => {
  const { mirror, calls } = stubMirror();
  mirror.dispatchInput([{ kind: "mouse", type: "mouseWheel", nx: 0.5, ny: 0.5, ndx: 0.1, ndy: -0.25 }]);
  assert.equal(calls[0].params.deltaX, 100);
  assert.equal(calls[0].params.deltaY, -200);
  assert.equal(calls[0].params.button, "none");
});

test("可打印字符带 text，功能键不带", () => {
  const { mirror, calls } = stubMirror();
  mirror.dispatchInput([
    { kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a" },
    { kind: "key", type: "rawKeyDown", key: "Enter", code: "Enter", keyCode: 13 }
  ]);
  assert.equal(calls[0].params.text, "a");
  assert.equal(calls[0].params.windowsVirtualKeyCode, 65);
  assert.equal(calls[1].params.text, undefined);
  assert.equal(calls[1].params.windowsVirtualKeyCode, 13);
});

test("中文/粘贴走 insertText", () => {
  const { mirror, calls } = stubMirror();
  mirror.dispatchInput([{ kind: "text", text: "你好" }]);
  assert.equal(calls[0].method, "Input.insertText");
  assert.equal(calls[0].params.text, "你好");
});

test("非法事件被忽略，不下发命令", () => {
  const { mirror, calls } = stubMirror();
  const sent = mirror.dispatchInput([null, { kind: "nope" }, { kind: "text", text: "" }]);
  assert.equal(sent, 0);
  assert.equal(calls.length, 0);
});

test("贴合请求抖动小于 12px 时不重设", async () => {
  const { mirror, calls } = stubMirror();
  mirror.requestFit(900, 700, 1.5);
  await mirror._applyFit();
  const first = calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length;
  mirror.requestFit(905, 703, 1.5);
  await mirror._applyFit();
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, first);
  mirror.requestFit(1200, 700, 1.5);
  await mirror._applyFit();
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, first + 1);
});

test("取消贴合先用 0 宽高接管覆盖再 clear（否则清不掉别的会话留下的覆盖）", async () => {
  const { mirror, calls } = stubMirror();
  mirror.requestFit(900, 700, 1.5);
  await mirror._applyFit();
  assert.equal(mirror.state.fitted, true);
  calls.length = 0;
  mirror.requestFit(0, 0, 1);
  await mirror._applyFit();
  assert.deepEqual(calls.map((c) => c.method), [
    "Emulation.setDeviceMetricsOverride",
    "Emulation.clearDeviceMetricsOverride"
  ]);
  assert.deepEqual(calls[0].params, { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
  assert.equal(mirror.state.fitted, false);
});

test("新会话在无贴合需求时补发一次还原，且只发一次", async () => {
  const { mirror, calls } = stubMirror();
  await mirror._applyFit();
  assert.equal(calls.length, 2);
  await mirror._applyFit();
  assert.equal(calls.length, 2);
});

test("screencast 帧广播给订阅者，但不拿 metadata 当视口", () => {
  // metadata.deviceWidth/Height 说的是被抓取的画面尺寸，不是页面 CSS 视口。
  // 页面缩放不等于 100% 时两者差一个 zoom 因子，而视口是坐标换算的分母——
  // 让 metadata 写它，点击就会整体偏移。
  const { mirror } = stubMirror({ width: 1064, height: 1276 });
  const got = [];
  mirror.subscribe((buf) => got.push(buf));
  mirror._onEvent({
    method: "Page.screencastFrame",
    params: { data: Buffer.from("hello").toString("base64"), sessionId: 7, metadata: { deviceWidth: 640, deviceHeight: 480 } }
  });
  assert.deepEqual(mirror.state.viewport, { width: 1064, height: 1276 });
  assert.equal(mirror.state.frameMode, "screencast");
  assert.equal(got.length, 1);
  assert.equal(got[0].toString(), "hello");
});

test("退订后不再收到帧", () => {
  const { mirror } = stubMirror();
  const got = [];
  const off = mirror.subscribe((buf) => got.push(buf));
  off();
  mirror._onEvent({ method: "Page.screencastFrame", params: { data: Buffer.from("x").toString("base64"), sessionId: 1, metadata: {} } });
  assert.equal(got.length, 0);
});

test("贴合不把 window.screen 一起盖掉（不传 screenWidth/screenHeight）", async () => {
  const { mirror, calls } = stubMirror();
  mirror.requestFit(958, 1149, 1.5);
  await mirror._applyFit();
  const fit = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(fit.params, { width: 958, height: 1149, deviceScaleFactor: 1.5, mobile: false });
  assert.equal(mirror.state.fitted, true);
});

test("贴合后回读真实视口，而不是假定等于覆盖尺寸", async () => {
  // Chrome 的每源页面缩放叠在 setDeviceMetricsOverride 之上：实测 zhipin.com 存着
  // 90% 缩放时，覆盖 958×1149 得到的 CSS 视口是 1064×1276。假定下去分母小 10%，
  // 点击会落在光标左上方，离原点越远偏越多。
  const { mirror, calls } = stubMirror({ width: 0, height: 0 });
  mirror._command = (method, params) => {
    calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      return Promise.resolve({ result: { result: { value: JSON.stringify({ w: 1064, h: 1276 }) } } });
    }
    return Promise.resolve({ result: {} });
  };
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();
  assert.deepEqual(mirror.state.viewport, { width: 1064, height: 1276 });

  // 分母用回读值，坐标才对得上：面板最右下角应映射到 1064×1276，而不是 958×1149。
  calls.length = 0;
  mirror.dispatchInput([{ kind: "mouse", type: "mousePressed", nx: 1, ny: 1, button: "left", buttons: 1 }]);
  const click = calls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(click.params.x, 1064);
  assert.equal(click.params.y, 1276);
});

test("screencast 模式下视口依然会被回读纠正", async () => {
  const { mirror } = stubMirror({ width: 958, height: 1149 });
  mirror.state.frameMode = "screencast";
  mirror._lastViewportAt = 0;
  mirror._command = (method) =>
    method === "Runtime.evaluate"
      ? Promise.resolve({ result: { result: { value: JSON.stringify({ w: 1064, h: 1276 }) } } })
      : Promise.resolve({ result: {} });
  await mirror._refreshViewport();
  assert.deepEqual(mirror.state.viewport, { width: 1064, height: 1276 });
});

/**
 * 造一只带「页面会响应覆盖」行为的 mirror：发 setDeviceMetricsOverride 后回读值就变成
 * `覆盖尺寸 / 0.9`（模拟 zhipin.com 那个 90% 页面缩放，见 #28）。
 *
 * - `clearOverride()` 模拟第三方把覆盖清掉：回读值跳回真实窗口尺寸。
 * - `honorOverride(false)` 模拟重发压根不生效（对面清得比我们发得快）。
 * - `reread()` 绕过 2s 节流，好在一个测试里连着回读多轮。
 */
const WINDOW_VIEWPORT = { w: 1537, h: 894 };
function fitDriftMirror() {
  const { mirror, calls } = stubMirror({ width: 0, height: 0 });
  let read = { ...WINDOW_VIEWPORT };
  let honor = true;
  mirror._command = (method, params) => {
    calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      return Promise.resolve({ result: { result: { value: JSON.stringify(read) } } });
    }
    if (method === "Emulation.setDeviceMetricsOverride" && honor && params.width > 0) {
      read = { w: Math.round(params.width / 0.9), h: Math.round(params.height / 0.9) };
    }
    return Promise.resolve({ result: {} });
  };
  return {
    mirror,
    calls,
    clearOverride: () => {
      read = { ...WINDOW_VIEWPORT };
    },
    honorOverride: (on) => {
      honor = on;
    },
    setViewport: (w, h) => {
      read = { w, h };
    },
    reread: async () => {
      mirror._lastViewportAt = 0;
      await mirror._refreshViewport();
    }
  };
}

test("覆盖被第三方清掉后，fitted 不再说谎且下一轮会重发", async () => {
  const { mirror, calls, clearOverride, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();
  assert.equal(mirror.state.fitted, true);
  // 基准是回读值（958/0.9），不是覆盖尺寸本身。
  assert.deepEqual(mirror._fitBaseline, { width: 1064, height: 1277 });

  // 第二个 host 清掉了覆盖：页面回到真实窗口尺寸。
  clearOverride();
  await reread();
  assert.equal(mirror.state.fitted, false, "state.fitted 要跟着实际走，不能停在 true");

  // 缓存已作废 → tick 里的 _applyFit 会真的再发一次覆盖。
  calls.length = 0;
  await mirror._applyFit();
  const resent = calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.equal(resent.length, 1);
  assert.equal(resent[0].params.width, 958);
  assert.equal(mirror.state.fitted, true);
  // 计数要等下一轮验证过「覆盖真还在」才归零：重发当场归零的话，「每轮都被清」
  // 这个正需要停手的场景会永远攒不到上限。
  assert.equal(mirror._fitDriftCount, 1);
  await reread();
  assert.equal(mirror._fitDriftCount, 0);
  assert.equal(mirror.state.fitted, true);
});

test("页面缩放让回读值合法地不等于覆盖尺寸，不算失真", async () => {
  const { mirror, calls, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();

  // 回读 1064×1277 ≠ 覆盖 958×1149（90% 缩放），但和基准一致 —— 不该重发。
  calls.length = 0;
  await reread();
  await mirror._applyFit();
  assert.equal(mirror.state.fitted, true);
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, 0);
});

test("滚动条那点尺寸变化不触发重发", async () => {
  const { mirror, calls, setViewport, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();

  calls.length = 0;
  setViewport(1064 - 15, 1277);
  await reread();
  assert.equal(mirror.state.fitted, true);
  await mirror._applyFit();
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, 0);
});

test("反复被抢就停手，不跟第三方对刷 setDeviceMetricsOverride", async () => {
  const { mirror, calls, clearOverride, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();

  // 对面每轮都把覆盖清掉：失真 → 重发 → 又被清……
  for (let i = 0; i < 4; i++) {
    clearOverride();
    await reread();
    await mirror._applyFit();
  }
  assert.equal(mirror._fitGaveUp, true);
  assert.match(mirror.state.error, /停止重发/);

  calls.length = 0;
  clearOverride();
  await reread();
  await mirror._applyFit();
  assert.equal(
    calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length,
    0,
    "停手后不能再发覆盖——无限重发就是把页面按秒 resize，正是引发 403 的那个成因"
  );
});

test("重发压根不生效时也算失败，不把基准立在没贴合的尺寸上", async () => {
  const { mirror, clearOverride, honorOverride, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();

  // 覆盖从此发不动了（对面清得比我们发得快）。
  honorOverride(false);
  clearOverride();
  for (let i = 0; i < 4; i++) {
    await reread();
    await mirror._applyFit();
  }
  assert.equal(mirror.state.fitted, false);
  assert.notDeepEqual(
    mirror._fitBaseline,
    { width: WINDOW_VIEWPORT.w, height: WINDOW_VIEWPORT.h },
    "基准不能立成未贴合的窗口尺寸，否则之后每次判定都通过、fitted 又开始说谎"
  );
  assert.equal(mirror._fitGaveUp, true);
});

test("用户重设尺寸把停手状态放开", async () => {
  const { mirror, calls, clearOverride, reread } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();
  for (let i = 0; i < 4; i++) {
    clearOverride();
    await reread();
    await mirror._applyFit();
  }
  assert.equal(mirror._fitGaveUp, true);

  calls.length = 0;
  mirror.requestFit(1440, 1149, 1);
  assert.equal(mirror._fitGaveUp, false);
  await mirror._applyFit();
  const resent = calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.equal(resent.length, 1);
  assert.equal(resent[0].params.width, 1440);
});

test("换连接/换目标会忘掉贴合缓存（覆盖不可能还在）", async () => {
  const { mirror } = fitDriftMirror();
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();
  mirror._fitGaveUp = true;

  mirror.setTarget("page-2");
  assert.equal(mirror._appliedFit, null);
  assert.equal(mirror._fitBaseline, null);
  assert.equal(mirror._fitGaveUp, false, "换目标后要重新试，不该带着上一只页面的停手状态");
});

test("回读失败时不立基准，免得把 0×0 当基准无限重发", async () => {
  const { mirror, calls } = stubMirror({ width: 0, height: 0 });
  mirror._command = (method, params) => {
    calls.push({ method, params });
    if (method === "Runtime.evaluate") return Promise.resolve({ result: {} });
    return Promise.resolve({ result: {} });
  };
  mirror.requestFit(958, 1149, 1);
  await mirror._applyFit();
  assert.equal(mirror._fitBaseline, null);

  // 基准为空时不做判定，也就不会误判失真。
  calls.length = 0;
  mirror._lastViewportAt = 0;
  await mirror._refreshViewport();
  assert.equal(mirror._appliedFit !== null, true);
  await mirror._applyFit();
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, 0);
});

test("无头下截图兜底不退到 fromSurface:false（那是 headful-only，会拿到废图）", async () => {
  const { mirror, calls } = stubMirror();
  mirror.state.headless = true;
  mirror._command = (method, params) => {
    calls.push({ method, params });
    return Promise.resolve({ result: {} }); // 模拟 fromSurface:true 抓不到
  };
  await mirror._pollFrame();
  const shots = calls.filter((c) => c.method === "Page.captureScreenshot");
  assert.equal(shots.length, 1);
  assert.equal(shots[0].params.fromSurface, true);
  assert.equal(mirror.frame, null);
});

test("有头下截图兜底才退到 fromSurface:false", async () => {
  const { mirror, calls } = stubMirror();
  mirror.state.headless = false;
  mirror._command = (method, params) => {
    calls.push({ method, params });
    if (method === "Page.captureScreenshot" && params.fromSurface === false) {
      return Promise.resolve({ result: { data: Buffer.from("frame").toString("base64") } });
    }
    return Promise.resolve({ result: {} });
  };
  await mirror._pollFrame();
  assert.deepEqual(
    calls.filter((c) => c.method === "Page.captureScreenshot").map((c) => c.params.fromSurface),
    [true, false]
  );
  assert.equal(mirror.frame.toString(), "frame");
  assert.equal(mirror.state.frameMode, "poll");
});

test("readHeadless 按 /json/version 的 UA 判模式", () => {
  const headless = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36";
  const headful = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  assert.equal(readHeadless({ "User-Agent": headless }), true);
  assert.equal(readHeadless({ "User-Agent": headful }), false);
  assert.equal(readHeadless({}), null);
  assert.equal(readHeadless(null), null);
});

test("共读变量是统一覆盖开关，不设时各源用自己的默认", () => {
  const saved = process.env.RECRUIT_BROWSER_HIDDEN;
  try {
    // 不设：boss 有头（实测无头会被判成第三方辅助工具）、猎聘无头（风控形态没观测过）
    delete process.env.RECRUIT_BROWSER_HIDDEN;
    assert.equal(hiddenModeEnabled(false), false, "boss 默认有头");
    assert.equal(hiddenModeEnabled(true), true, "猎聘默认无头");

    // 显式设置就拉平两家，源默认不再起作用
    for (const v of ["true", "TRUE", "1", "yes", "y"]) {
      process.env.RECRUIT_BROWSER_HIDDEN = v;
      assert.equal(hiddenModeEnabled(false), true, v);
      assert.equal(hiddenModeEnabled(true), true, v);
    }
    for (const v of ["false", "FALSE", "0", "no", "n"]) {
      process.env.RECRUIT_BROWSER_HIDDEN = v;
      assert.equal(hiddenModeEnabled(false), false, v);
      assert.equal(hiddenModeEnabled(true), false, v);
    }

    // 无意义值不当覆盖，回落到源默认
    for (const v of ["maybe", ""]) {
      process.env.RECRUIT_BROWSER_HIDDEN = v;
      assert.equal(hiddenModeEnabled(false), false, v);
      assert.equal(hiddenModeEnabled(true), true, v);
    }
  } finally {
    if (saved === undefined) delete process.env.RECRUIT_BROWSER_HIDDEN;
    else process.env.RECRUIT_BROWSER_HIDDEN = saved;
  }
});

test("两个内置源的默认模式与各自 CLI 对齐（boss 有头 / 猎聘无头）", () => {
  const sources = normalizeSources(undefined);
  const boss = sources.find((s) => s.name === "boss");
  const liepin = sources.find((s) => s.name === "liepin");
  assert.equal(boss.defaultHidden, false);
  assert.equal(liepin.defaultHidden, true);
});

test("normalizeSources：patch 只写差异，userDataDir/homeUrl 从内置默认补", () => {
  const list = normalizeSources([{ name: "boss", port: 53470, match: "zhipin\\.com" }]);
  assert.equal(list[0].name, "boss");
  assert.equal(list[0].port, 53470);
  assert.equal(list[0].match, "zhipin\\.com");
  assert.ok(list[0].userDataDir && list[0].userDataDir.includes(".boss-cli"));
  assert.equal(list[0].homeUrl, "https://www.zhipin.com/web/chat/index");
});

test("normalizeSources：显式配置覆盖内置默认", () => {
  const list = normalizeSources([{ name: "boss", userDataDir: "/custom/dir", homeUrl: "about:blank" }]);
  assert.equal(list[0].userDataDir, "/custom/dir");
  assert.equal(list[0].homeUrl, "about:blank");
});

test("normalizeSources：无配置时内置 boss 与 liepin 两个源", () => {
  const defs = normalizeSources(undefined);
  assert.deepEqual(defs.map((s) => s.name), ["boss", "liepin"]);
  assert.deepEqual(defs.map((s) => s.port), [53470, 53471]);
  assert.ok(defs[0].userDataDir.includes(".boss-cli"));
  assert.ok(defs[1].userDataDir.includes(".liepin-cli"));
  assert.ok(defs[1].homeUrl.includes("lpt.liepin.com"));
});

test("normalizeSources：liepin 只写端口时，userDataDir/homeUrl 从内置默认补", () => {
  const list = normalizeSources([{ name: "liepin", port: 53471, match: "liepin\\.com" }]);
  assert.equal(list.length, 1);
  assert.ok(list[0].userDataDir.includes(".liepin-cli"));
  assert.equal(list[0].homeUrl, "https://lpt.liepin.com/recommend");
});

test("normalizeSources：未知源原样保留，不硬塞默认值", () => {
  const custom = normalizeSources([{ name: "zhaopin", port: 53472 }]);
  assert.equal(custom[0].name, "zhaopin");
  assert.equal(custom[0].userDataDir, undefined);
  assert.equal(custom[0].homeUrl, undefined);
});

/** 假的 req/res：write 永远返回 false（模拟对面不读），drain 永不触发。 */
function stubHttp() {
  const handlers = { req: {}, res: {} };
  const written = [];
  const state = { ended: false };
  const req = { on: (ev, fn) => { handlers.req[ev] = fn; } };
  const res = {
    writeHead() {},
    write(chunk) { written.push(chunk); return false; },
    end() { state.ended = true; },
    on: (ev, fn) => { handlers.res[ev] = fn; },
    get writableEnded() { return state.ended; }
  };
  return { req, res, written, state, handlers };
}

test("客户端不读时，僵尸 stream 超时被断开（否则占满同源连接槽）", () => {
  const { mirror } = stubMirror();
  const { req, res, state, written } = stubHttp();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    streamMjpeg(mirror, req, res);

    mirror._publish(Buffer.from("frame-1"));
    const afterFirst = written.length;
    assert.ok(afterFirst > 0, "第一帧应该写出去（此时还没 backedUp）");

    // 已经 backedUp：还在阈值内的帧只丢掉，不断连接
    clock += 3000;
    mirror._publish(Buffer.from("frame-2"));
    assert.equal(written.length, afterFirst, "backedUp 期间不再写入");
    assert.equal(state.ended, false, "阈值内不该断开");

    // 超过阈值：断掉，并退订（否则看门狗会一直以为有人在看，持续轮询截图）
    clock += 9000;
    mirror._publish(Buffer.from("frame-3"));
    assert.equal(state.ended, true, "写不动超过阈值应断开连接");
    assert.equal(mirror._subscribers.size, 0, "断开后必须退订");
  } finally {
    Date.now = realNow;
  }
});

test("对面正常读取时，stream 不会被误断", () => {
  const { mirror } = stubMirror();
  const { req, res, state, written, handlers } = stubHttp();
  streamMjpeg(mirror, req, res);

  for (let i = 0; i < 5; i++) {
    mirror._publish(Buffer.from(`frame-${i}`));
    handlers.res.drain?.();   // 客户端读完了，内核缓冲腾空
  }
  assert.equal(state.ended, false);
  assert.equal(mirror._subscribers.size, 1);
  assert.ok(written.length >= 5 * 3, "每帧写 head + body + CRLF");
});

test("req close 时退订，不留订阅者", () => {
  const { mirror } = stubMirror();
  const { req, res, handlers } = stubHttp();
  streamMjpeg(mirror, req, res);
  assert.equal(mirror._subscribers.size, 1);
  handlers.req.close();
  assert.equal(mirror._subscribers.size, 0);
  void res;
});

test("同一个源的新 stream 挤掉旧的（切源留下的僵尸不许占着连接槽）", () => {
  const { mirror } = stubMirror();
  const a = stubHttp();
  streamMjpeg(mirror, a.req, a.res);
  assert.equal(mirror._subscribers.size, 1);

  // 切走再切回来 = 同一个源上来了第二路
  const b = stubHttp();
  streamMjpeg(mirror, b.req, b.res);
  assert.equal(a.state.ended, true, "旧的那路必须被断开");
  assert.equal(b.state.ended, false, "新的那路要留着");
  assert.equal(mirror._subscribers.size, 1, "订阅者不许累积");

  // 反复切十次也不该堆积
  for (let i = 0; i < 10; i++) streamMjpeg(mirror, stubHttp().req, stubHttp().res);
  assert.equal(mirror._subscribers.size, 1);
});

test("旧 stream 自己先断开时，不会把后来者的通道误清掉", () => {
  const { mirror } = stubMirror();
  const a = stubHttp();
  streamMjpeg(mirror, a.req, a.res);
  const b = stubHttp();
  streamMjpeg(mirror, b.req, b.res);   // a 已被挤掉
  a.handlers.req.close();              // a 的 close 事件姗姗来迟

  const c = stubHttp();
  streamMjpeg(mirror, c.req, c.res);
  assert.equal(b.state.ended, true, "b 该被 c 挤掉");
  assert.equal(c.state.ended, false, "c 不该受 a 的迟到 close 影响");
  assert.equal(mirror._subscribers.size, 1);
});

test("dispose 时把在跑的 stream 一并收掉", () => {
  const { mirror } = stubMirror();
  const a = stubHttp();
  streamMjpeg(mirror, a.req, a.res);
  mirror.dispose();
  assert.equal(a.state.ended, true);
  assert.equal(mirror._subscribers.size, 0);
});

test("CLI 占用锁：pid 还活着才算数，僵尸锁自动清掉", () => {
  const name = "__test_busy__";
  const file = path.join(BUSY_DIR, `${name}.busy.json`);
  mkdirSync(BUSY_DIR, { recursive: true });
  try {
    assert.equal(readBusyLock(name), null, "没有文件时应为空闲");

    writeFileSync(file, JSON.stringify({ pid: process.pid, command: "boss search", startedAt: Date.now() - 3000 }));
    const live = readBusyLock(name);
    assert.equal(live.command, "boss search");
    assert.ok(live.ageMs >= 3000);

    // 几乎不可能存在的 pid：锁应被判为僵尸并删除
    writeFileSync(file, JSON.stringify({ pid: 0x7ffffffe, command: "boss greet", startedAt: Date.now() }));
    assert.equal(readBusyLock(name), null, "pid 已死时应视为空闲");
    assert.equal(existsSync(file), false, "僵尸锁应被删掉");

    writeFileSync(file, "{ 这不是 json");
    assert.equal(readBusyLock(name), null, "坏文件应视为空闲");
    assert.equal(existsSync(file), false, "坏文件应被删掉");
  } finally {
    try { unlinkSync(file); } catch { /* 已删 */ }
  }
});

test("导航到风控页就熔断，并说清停了什么", () => {
  const { mirror } = stubMirror();
  assert.equal(mirror.state.risk, null);
  mirror._onEvent({
    method: "Page.frameNavigated",
    params: { frame: { url: "https://www.zhipin.com/web/common/403.html?ka=x" } }
  });
  assert.equal(mirror.state.risk.url, "https://www.zhipin.com/web/common/403.html?ka=x");
  assert.match(mirror.state.error, /风控\/验证页/);
});

test("验证页/安全页的各种形态都算风控页，about:blank 不算", () => {
  const hit = [
    "https://www.zhipin.com/web/user/safe/verify",
    "https://www.zhipin.com/web/passport/zp/verify.html",
    "https://www.zhipin.com/web/passport/cm/security-check.html",
    "https://www.zhipin.com/web/common/nonsupport.html"
  ];
  for (const url of hit) {
    const { mirror } = stubMirror();
    mirror._checkRiskUrl(url);
    assert.notEqual(mirror.state.risk, null, url);
  }
  // about:blank 是新标签正常初始态，算进来会把面板自己锁死。
  const { mirror: m2 } = stubMirror();
  m2._checkRiskUrl("about:blank");
  m2._checkRiskUrl("https://www.zhipin.com/web/geek/chat");
  assert.equal(m2.state.risk, null);
});

test("熔断期间不重发贴合（反复 resize 本身就是风控信号）", async () => {
  const { mirror, calls } = stubMirror();
  mirror.requestFit(958, 1149, 1);
  mirror._checkRiskUrl("https://www.zhipin.com/web/common/403.html");
  calls.length = 0;
  await mirror._applyFit();
  assert.equal(calls.filter((c) => c.method === "Emulation.setDeviceMetricsOverride").length, 0);
});

test("熔断期间看门狗不自愈重启浏览器", async () => {
  const { mirror } = stubMirror();
  mirror.setWatch(true);
  mirror._everConnected = true;
  mirror._probe = () => Promise.resolve(null); // 浏览器不在跑
  let launched = 0;
  mirror.launch = () => { launched += 1; return Promise.resolve({ ok: true }); };

  mirror._checkRiskUrl("https://www.zhipin.com/web/common/403.html");
  await mirror.tick();
  assert.equal(launched, 0, "被限期间每次拉起都是一次新访问，只会把恢复时间越推越远");

  // 人工解除后才恢复自愈
  mirror.clearRisk();
  await mirror.tick();
  assert.equal(launched, 1);
});

test("熔断只认第一次，后续导航不覆盖首次记录", () => {
  const { mirror } = stubMirror();
  mirror._checkRiskUrl("https://www.zhipin.com/web/common/403.html");
  const first = mirror.state.risk;
  mirror._checkRiskUrl("https://www.zhipin.com/web/passport/zp/verify.html");
  assert.equal(mirror.state.risk, first);
});

test("clearRisk 幂等，重复解除不报错", () => {
  const { mirror } = stubMirror();
  assert.deepEqual(mirror.clearRisk(), { ok: true, already: true });
  mirror._checkRiskUrl("https://www.zhipin.com/web/common/403.html");
  assert.deepEqual(mirror.clearRisk(), { ok: true });
  assert.equal(mirror.state.risk, null);
  assert.equal(mirror.state.error, null);
});

test("有 CLI 命令在跑时拒绝切换模式，并说清是哪条、跑了多久", async () => {
  const { mirror } = stubMirror();
  mirror.name = "__test_busy2__";
  const file = path.join(BUSY_DIR, `${mirror.name}.busy.json`);
  mkdirSync(BUSY_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, command: "boss search", startedAt: Date.now() - 12000 }));
  try {
    const res = await mirror.setMode(false);
    assert.equal(res.ok, false);
    assert.equal(res.busy.command, "boss search");
    assert.match(res.error, /boss search/);
    assert.match(res.error, /12s/);
    assert.match(res.error, new RegExp(String(process.pid)));
  } finally {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
});
