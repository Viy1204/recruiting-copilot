/**
 * BrowserMirror 单测：只桩掉 _command，验证对外行为——坐标换算、输入参数、
 * 贴合/还原的 CDP 调用序列。不需要真浏览器。
 *
 *   node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserMirror, normalizeSources } from "../lib/index.js";

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

test("screencast 帧更新视口尺寸并广播给订阅者", () => {
  const { mirror } = stubMirror({ width: 0, height: 0 });
  const got = [];
  mirror.subscribe((buf) => got.push(buf));
  mirror._onEvent({
    method: "Page.screencastFrame",
    params: { data: Buffer.from("hello").toString("base64"), sessionId: 7, metadata: { deviceWidth: 640, deviceHeight: 480 } }
  });
  assert.deepEqual(mirror.state.viewport, { width: 640, height: 480 });
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

test("normalizeSources：无配置用内置默认；未知源原样保留", () => {
  const defs = normalizeSources(undefined);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, "boss");
  assert.ok(defs[0].userDataDir.includes(".boss-cli"));
  const custom = normalizeSources([{ name: "liepin", port: 53471 }]);
  assert.equal(custom[0].userDataDir, undefined);
  assert.equal(custom[0].homeUrl, undefined);
});
