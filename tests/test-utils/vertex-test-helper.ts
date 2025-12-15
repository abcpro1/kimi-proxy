import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, afterEach, beforeEach } from "vitest";
import dotenv from "dotenv";
import type { AppConfig } from "../../src/config.js";
import { createServer, type FastifyInstance } from "../../src/server.js";

// Load .env file
dotenv.config();

export const hasVertexCreds =
  process.env.VERTEX_PROJECT_ID &&
  process.env.VERTEX_LOCATION &&
  process.env.GOOGLE_APPLICATION_CREDENTIALS;

export const describeWithVertex = hasVertexCreds ? describe : describe.skip;

export interface VertexTestContext {
  server: FastifyInstance;
  baseURL: string;
  tmpRoot: string;
}

export function setupVertexTestServer(
  models: AppConfig["models"]["definitions"],
) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ulx-integ-vertex-"));
  const dbPath = path.join(tmpRoot, "logs.db");
  const blobRoot = path.join(tmpRoot, "blobs");

  let server: FastifyInstance | undefined;

  beforeEach(() => {
    fs.mkdirSync(blobRoot, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const getClient = async () => {
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
    let credentials;
    let credentialsPath;

    if (rawCreds.trim().startsWith("{")) {
      try {
        credentials = JSON.parse(rawCreds);
      } catch (e) {
        console.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS JSON", e);
        throw e;
      }
    } else {
      credentialsPath = rawCreds;
    }

    const config: AppConfig = {
      server: { host: "127.0.0.1", port: 0 },
      logging: { dbPath, blobRoot },
      streaming: { delay: 0, chunkSize: 10 },
      livestore: { batchSize: 50 },
      providers: {
        vertex: {
          projectId: process.env.VERTEX_PROJECT_ID!,
          location: process.env.VERTEX_LOCATION!,
          credentials,
          credentialsPath,
        },
      },
      models: {
        definitions: models,
        defaultStrategy: "first",
      },
    };

    server = await createServer(config);
    await server.ready();
    await server.listen({ port: 0 });
    const address = server.server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}/v1`;

    return { server, baseURL, tmpRoot };
  };

  return { getClient };
}
