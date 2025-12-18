import { join } from "path";

import { DEFAULT_SQL_OPTIONS } from "../common/utils/constants";
import QueueConfiguration from "./QueueConfiguration";
import QueueServer from "./QueueServer";
import SqlQueueConfiguration from "./SqlQueueConfiguration";
import SqlQueueServer from "./SqlQueueServer";
import {
  DEFAULT_QUEUE_EXTENT_LOKI_DB_PATH,
  DEFAULT_QUEUE_LOKI_DB_PATH,
  DEFAULT_QUEUE_PERSISTENCE_ARRAY,
  DEFAULT_QUEUE_PERSISTENCE_PATH
} from "./utils/constants";
import Environment from "../common/Environment";

/**
 * Factory for creating Queue servers.
 * Creates SqlQueueServer if AZURITE_DB environment variable is set,
 * otherwise creates LokiJS-based QueueServer.
 */
export class QueueServerFactory {
  public async createServer(
    env: Environment,
    location: string
  ): Promise<QueueServer | SqlQueueServer> {
    const debugFilePath = await env.debug();

    // Set persistence path
    DEFAULT_QUEUE_PERSISTENCE_ARRAY[0].locationPath = join(
      location,
      DEFAULT_QUEUE_PERSISTENCE_PATH
    );

    // Check if we should use SQL-based storage
    const databaseConnectionString = process.env.AZURITE_DB;
    const isSQL = databaseConnectionString !== undefined;

    if (isSQL) {
      if (env.inMemoryPersistence()) {
        throw new Error(`The --inMemoryPersistence option is not supported when using SQL-based metadata storage.`);
      }
      if (env.extentMemoryLimit() !== undefined) {
        throw new Error(`The --extentMemoryLimit option is not supported when using SQL-based metadata storage.`);
      }

      const config = new SqlQueueConfiguration(
        env.queueHost(),
        env.queuePort(),
        env.queueKeepAliveTimeout(),
        databaseConnectionString!,
        DEFAULT_SQL_OPTIONS,
        DEFAULT_QUEUE_PERSISTENCE_ARRAY,
        !env.silent(),
        undefined,
        debugFilePath !== undefined,
        debugFilePath,
        env.loose(),
        env.skipApiVersionCheck(),
        env.cert(),
        env.key(),
        env.pwd(),
        env.oauth(),
        env.disableProductStyleUrl()
      );

      return new SqlQueueServer(config);
    } else {
      const config = new QueueConfiguration(
        env.queueHost(),
        env.queuePort(),
        env.queueKeepAliveTimeout(),
        join(location, DEFAULT_QUEUE_LOKI_DB_PATH),
        join(location, DEFAULT_QUEUE_EXTENT_LOKI_DB_PATH),
        DEFAULT_QUEUE_PERSISTENCE_ARRAY,
        !env.silent(),
        undefined,
        debugFilePath !== undefined,
        debugFilePath,
        env.loose(),
        env.skipApiVersionCheck(),
        env.cert(),
        env.key(),
        env.pwd(),
        env.oauth(),
        env.disableProductStyleUrl(),
        env.inMemoryPersistence()
      );

      return new QueueServer(config);
    }
  }
}
