/**
 * 端到端验证输入回传：自己开一条 CDP 在页面里装一个探针（记录收到的
 * mousemove / keydown / wheel），再通过 harness 的 /input 发事件，读回探针结果。
 * 用 F13 这种无副作用的键，不会在页面里留下任何输入。
 *
 *   node tests/input-e2e.mjs [harnessPort] [cdpPort]
 */
const harnessPort = Number(process.argv[2] ?? 3081);
const cdpPort = Number(process.argv[3] ?? 53470);

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && /zhipin\.com/i.test(t.url ?? "")) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false });
  if (r?.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.text));
  return r?.result?.result?.value;
};

await evaluate(`(() => {
  (window.__rcpHandlers ?? []).forEach(([t, f]) => window.removeEventListener(t, f, true));
  window.__rcpProbe = { move: null, key: null, wheel: null, down: null };
  const hMove = (e) => { window.__rcpProbe.move = { x: Math.round(e.clientX), y: Math.round(e.clientY) }; };
  const hDown = (e) => { window.__rcpProbe.down = { x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button }; };
  const hKey = (e) => { window.__rcpProbe.key = { key: e.key, code: e.code, keyCode: e.keyCode }; };
  const hWheel = (e) => { window.__rcpProbe.wheel = { dy: Math.round(e.deltaY) }; };
  window.__rcpHandlers = [['mousemove', hMove], ['mousedown', hDown], ['keydown', hKey], ['wheel', hWheel]];
  window.__rcpHandlers.forEach(([t, f]) => window.addEventListener(t, f, true));
  return 'probe installed';
})()`);

const post = (path, body) => fetch(`http://127.0.0.1:${harnessPort}/plugins/recruiting-view/${path}?source=boss`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
}).then((r) => r.json());

const viewport = (await post("input", { events: [] })).viewport;

// 键盘事件只送到焦点元素；页面焦点常在 iframe 里，先把焦点拉回顶层文档再验。
await evaluate("(() => { document.body.tabIndex = -1; document.body.focus(); return document.activeElement?.tagName; })()");

await post("input", {
  events: [
    { kind: "mouse", type: "mouseMoved", nx: 0.111, ny: 0.132, buttons: 0 },
    { kind: "mouse", type: "mouseWheel", nx: 0.111, ny: 0.132, ndx: 0, ndy: 0.3 },
    { kind: "key", type: "rawKeyDown", key: "F13", code: "F13", keyCode: 124 },
    { kind: "key", type: "keyUp", key: "F13", code: "F13", keyCode: 124 }
  ]
});
await new Promise((r) => setTimeout(r, 800));
const probe = await evaluate("JSON.stringify(window.__rcpProbe)");

const expected = { x: Math.round(0.111 * viewport.width), y: Math.round(0.132 * viewport.height) };
const got = JSON.parse(probe ?? "{}");
console.log(JSON.stringify({
  viewport,
  expectedMove: expected,
  probe: got,
  moveOk: got.move && Math.abs(got.move.x - expected.x) <= 2 && Math.abs(got.move.y - expected.y) <= 2,
  wheelOk: got.wheel != null && got.wheel.dy > 0,
  keyOk: got.key?.key === "F13"
}, null, 2));

await evaluate("window.__rcpHandlers?.forEach(([t, f]) => window.removeEventListener(t, f, true)); delete window.__rcpHandlers; delete window.__rcpProbe; 'cleaned'");
ws.close();
