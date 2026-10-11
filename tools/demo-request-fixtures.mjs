import { createServer } from "node:http";
import { requestFixture } from "../apps/demo-app/src/request-fixture.ts";
// Only the isolated m5 demo stack runs this service. No request/body logging.
createServer((req, res) =>
  requestFixture(req, res, () => {
    res.writeHead(404);
    res.end();
  }),
).listen(4181, "0.0.0.0");
