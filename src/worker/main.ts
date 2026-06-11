import { buildDeps } from "../deps.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { buildWorkerServer } from "./server.js";

const config = loadConfig();
const deps = buildDeps(config);
const app = buildWorkerServer(deps, {
  // In cloud_tasks mode the OIDC token is the real gate: require a Google-signed
  // token whose audience is this service's URL, issued for the invoker SA.
  ...(config.QUEUE_MODE === "cloud_tasks" && config.WORKER_URL
    ? {
        oidc: {
          audience: config.WORKER_URL,
          ...(config.TASKS_INVOKER_SA ? { allowedEmails: [config.TASKS_INVOKER_SA] } : {}),
        },
      }
    : {}),
  ...(config.TASK_SECRET ? { taskSecret: config.TASK_SECRET } : {}),
});

app.listen({ port: config.PORT, host: "0.0.0.0" }).then((addr) => {
  logger.info({ event: "worker_started", addr, storeMode: config.STORE_MODE });
});
