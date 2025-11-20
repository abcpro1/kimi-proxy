import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";

async function bootstrap() {
  try {
    const config = loadConfig();
    const server = await createServer(config);
    await server.listen({ port: config.server.port, host: config.server.host });
    logger.info(
      `LLM proxy listening on ${config.server.host}:${config.server.port}`,
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to bootstrap server");
    process.exit(1);
  }
}

bootstrap();
