import { Options as SequelizeOptions } from "sequelize";

import ConfigurationBase from "../common/ConfigurationBase";
import { StoreDestinationArray } from "../common/persistence/IExtentStore";
import { DEFAULT_SQL_OPTIONS } from "../common/utils/constants";
import {
  DEFAULT_ENABLE_ACCESS_LOG,
  DEFAULT_ENABLE_DEBUG_LOG,
  DEFAULT_QUEUE_LISTENING_PORT,
  DEFAULT_QUEUE_PERSISTENCE_ARRAY,
  DEFAULT_QUEUE_SERVER_HOST_NAME,
  DEFAULT_QUEUE_KEEP_ALIVE_TIMEOUT
} from "./utils/constants";

/**
 * Configuration for SQL-based Queue Server implementation.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlQueueConfiguration
 * @extends {ConfigurationBase}
 */
export default class SqlQueueConfiguration extends ConfigurationBase {
  public constructor(
    host: string = DEFAULT_QUEUE_SERVER_HOST_NAME,
    port: number = DEFAULT_QUEUE_LISTENING_PORT,
    keepAliveTimeout: number = DEFAULT_QUEUE_KEEP_ALIVE_TIMEOUT,
    public readonly sqlURL: string,
    public readonly sequelizeOptions: SequelizeOptions = DEFAULT_SQL_OPTIONS,
    public readonly persistenceArray: StoreDestinationArray = DEFAULT_QUEUE_PERSISTENCE_ARRAY,
    enableAccessLog: boolean = DEFAULT_ENABLE_ACCESS_LOG,
    accessLogWriteStream?: NodeJS.WritableStream,
    enableDebugLog: boolean = DEFAULT_ENABLE_DEBUG_LOG,
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
