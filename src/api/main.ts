import { buildDeps } from "../deps.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { buildApiServer } from "./server.js";

const config = loadConfig();
if (config.apiKeys.length === 0 && config.NODE_ENV === "production") {
  throw new Error("refusing to start in production with no API_KEYS configured");
}

const deps = buildDeps(config);
const app = buildApiServer({
  stores: deps.stores,
  enqueuer: deps.enqueuer,
  apiKeys: config.apiKeys,
  limits: {
    maxProductsDefault: config.MAX_PRODUCTS_DEFAULT,
    maxProductsHard: config.MAX_PRODUCTS_HARD,
    maxReviewPagesDefault: config.MAX_REVIEW_PAGES_DEFAULT,
  },
});

app.listen({ port: config.PORT, host: "0.0.0.0" }).then((addr) => {
  logger.info({ event: "api_started", addr, queueMode: config.QUEUE_MODE, storeMode: config.STORE_MODE });
});
