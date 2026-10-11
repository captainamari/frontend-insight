import type { IncomingMessage, ServerResponse } from "node:http";
/** Isolated demo HTTP fixtures: synthetic evidence only, no external calls. */
export function requestFixture(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  if (!url.pathname.startsWith("/__diagnostic-fixture/")) return next();
  const kind = url.pathname.split("/").pop();
  res.setHeader("x-fixture-token", "FI_D3_SYNTHETIC");
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (kind === "redirect") {
    res.writeHead(302, { location: "/__diagnostic-fixture/failure" });
    res.end();
    return;
  }
  if (kind === "network") {
    req.socket.destroy();
    return;
  }
  if (kind === "binary") {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.from([1, 2, 3]));
    return;
  }
  if (kind === "stream") {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: FI_D3_SYNTHETIC\n\n");
    const timer = setInterval(() => res.write("data: tick\n\n"), 100);
    res.on("close", () => clearInterval(timer));
    return;
  }
  const body =
    kind === "large"
      ? "中\n😀".repeat(20000)
      : '{ "token": "FI_D3_SYNTHETIC", "message": "订单失败", "html": "<svg onload=alert(1)>", "nested": { "n": [1, 2] } }\n';
  const send = () => {
    res.statusCode = ["success", "business"].includes(kind ?? "") ? 200 : 503;
    res.end(body);
  };
  if (kind === "slow") {
    const timer = setTimeout(send, 500);
    res.on("close", () => clearTimeout(timer));
  } else send();
}
