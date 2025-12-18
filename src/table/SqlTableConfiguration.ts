import { Options as SequelizeOptions } from "sequelize";

import ConfigurationBase from "../common/ConfigurationBase";
import { DEFAULT_SQL_OPTIONS } from "../common/utils/constants";
import {
  DEFAULT_ENABLE_ACCESS_LOG,
  DEFAULT_ENABLE_DEBUG_LOG,
  DEFAULT_TABLE_LISTENING_PORT,
  DEFAULT_TABLE_SERVER_HOST_NAME,
  DEFAULT_TABLE_KEEP_ALIVE_TIMEOUT
} from "./utils/constants";

/**
 * Configuration for SQL-based Table Server implementation.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlTableConfiguration
 * @extends {ConfigurationBase}
 */
export default class SqlTableConfiguration extends ConfigurationBase {
  public constructor(
    host: string = DEFAULT_TABLE_SERVER_HOST_NAME,
    port: number = DEFAULT_TABLE_LISTENING_PORT,
    keepAliveTimeout: number = DEFAULT_TABLE_KEEP_ALIVE_TIMEOUT,
    public readonly sqlURL: string,
    public readonly sequelizeOptions: SequelizeOptions = DEFAULT_SQL_OPTIONS,
    enableDebugLog: boolean = DEFAULT_ENABLE_DEBUG_LOG,
    enableAccessLog: boolean = DEFAULT_ENABLE_ACCESS_LOG,
    accessLogWriteStream?: NodeJS.WritableStream,
    debugLogFilePath?: string,
    loose: boolean = false,
    skipApiVersionCheck: boolean = false,
    cert: string = "",
    key: string = "",
    pwd: string = "",
    oauth?: string,
    disableProductStyleUrl: boolean = false
  ) {
    super(
      host,
      port,
      keepAliveTimeout,
      enableAccessLog,
      accessLogWriteStream,
      enableDebugLog,
      debugLogFilePath,
      loose,
      skipApiVersionCheck,
      cert,
      key,
      pwd,
      oauth,
      disableProductStyleUrl
    );
  }
}
