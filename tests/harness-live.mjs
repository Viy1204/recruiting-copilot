/**
 * 本地联调 harness：不起 DSH，直接把 host 插件挂到一个裸 http 服务上，
 * 用来验证 screencast 推流 / MJPEG / 输入派发 / control 动作是否真的通。
 *
 *   node tests/harness-live.mjs [port]
 */
import http from "node:http";
import { apply } from "../lib/index.js";

const port = Number(process.argv[2] ?? 3081);
let handler = null;

const ctx = {
  inject(_deps, cb) {
    cb({
      webServer: {
        register(route) {
          handler = route.handler;
          return () => { handler = null; };
        }
      },
      effect(fn) { fn(); }
    });
  },
  effect(fn) { fn(); }
};

apply(ctx, {});

http.createServer((req, res) => {
  if (handler && (req.url ?? "").startsWith("/plugins/recruiting-view")) {
    Promise.resolve(handler(req, res)).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(port, "127.0.0.1", () => {
  console.log(`harness on http://127.0.0.1:${port}/plugins/recruiting-view/state.json`);
});
