import { buildDeps } from "../deps.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { buildWorkerServer } from "./server.js";

const config = loadConfig();
const deps = buildDeps(config);
const app = buildWorkerServer(deps, {
  ...(config.TASK_SECRET ? { taskSecret: config.TASK_SECRET } : {}),
});

app.listen({ port: config.PORT, host: "0.0.0.0" }).then((addr) => {
  logger.info({ event: "worker_started", addr, storeMode: config.STORE_MODE });
});
