import { join } from "path";

import { DEFAULT_SQL_OPTIONS } from "../common/utils/constants";
import TableConfiguration from "./TableConfiguration";
import TableServer from "./TableServer";
import SqlTableConfiguration from "./SqlTableConfiguration";
import SqlTableServer from "./SqlTableServer";
import { DEFAULT_TABLE_LOKI_DB_PATH } from "./utils/constants";
import Environment from "../common/Environment";

/**
 * Factory for creating Table servers.
 * Creates SqlTableServer if AZURITE_DB environment variable is set,
 * otherwise creates LokiJS-based TableServer.
 */
export class TableServerFactory {
  public async createServer(
    env: Environment,
    location: string
  ): Promise<TableServer | SqlTableServer> {
    const debugFilePath = await env.debug();

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

      const config = new SqlTableConfiguration(
        env.tableHost(),
        env.tablePort(),
        env.tableKeepAliveTimeout(),
        databaseConnectionString!,
        DEFAULT_SQL_OPTIONS,
        debugFilePath !== undefined,
        !env.silent(),
        undefined,
        debugFilePath,
        env.loose(),
        env.skipApiVersionCheck(),
        env.cert(),
        env.key(),
        env.pwd(),
        env.oauth(),
        env.disableProductStyleUrl()
      );

      return new SqlTableServer(config);
    } else {
      const config = new TableConfiguration(
        env.tableHost(),
        env.tablePort(),
        env.tableKeepAliveTimeout(),
        join(location, DEFAULT_TABLE_LOKI_DB_PATH),
        debugFilePath !== undefined,
        !env.silent(),
        undefined,
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

      return new TableServer(config);
    }
  }
}
