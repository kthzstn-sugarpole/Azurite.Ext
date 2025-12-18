import * as http from "http";
import * as https from "https";

import AccountDataStore from "../common/AccountDataStore";
import { CertOptions } from "../common/ConfigurationBase";
import IAccountDataStore from "../common/IAccountDataStore";
import IRequestListenerFactory from "../common/IRequestListenerFactory";
import logger from "../common/Logger";
import ServerBase, { ServerStatus } from "../common/ServerBase";
import ITableMetadataStore from "./persistence/ITableMetadataStore";
import SqlTableMetadataStore from "./persistence/SqlTableMetadataStore";
import SqlTableConfiguration from "./SqlTableConfiguration";
import TableRequestListenerFactory from "./TableRequestListenerFactory";

const BEFORE_CLOSE_MESSAGE = `Azurite Table service is closing...`;
const AFTER_CLOSE_MESSAGE = `Azurite Table service successfully closed`;

/**
 * SQL-based implementation of Azurite Table HTTP server.
 * This implementation provides a HTTP service based on express framework and SQL database.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlTableServer
 */
export default class SqlTableServer extends ServerBase {
  private readonly metadataStore: ITableMetadataStore;
  private readonly accountDataStore: IAccountDataStore;

  /**
   * Creates an instance of SqlTableServer.
   *
   * @param {SqlTableConfiguration} configuration
   * @memberof SqlTableServer
   */
  constructor(configuration: SqlTableConfiguration) {
    const host = configuration.host;
    const port = configuration.port;

    // Create HTTP or HTTPS server
    let httpServer;
    const certOption = configuration.hasCert();
    switch (certOption) {
      case CertOptions.PEM:
      case CertOptions.PFX:
        httpServer = https.createServer(configuration.getCert(certOption)!);
        break;
      default:
        httpServer = http.createServer();
    }

    // Create SQL-based metadata store
    const metadataStore: ITableMetadataStore = new SqlTableMetadataStore(
      configuration.sqlURL,
      configuration.sequelizeOptions
    );

    const accountDataStore: IAccountDataStore = new AccountDataStore(logger);

    // Create request listener factory
    const requestListenerFactory: IRequestListenerFactory = new TableRequestListenerFactory(
      metadataStore,
      accountDataStore,
      configuration.enableAccessLog,
      configuration.accessLogWriteStream,
      configuration.skipApiVersionCheck,
      configuration.getOAuthLevel(),
      configuration.disableProductStyleUrl
    );

    super(host, port, httpServer, requestListenerFactory, configuration);

    this.metadataStore = metadataStore;
    this.accountDataStore = accountDataStore;
  }

  /**
   * Clean up server persisted data.
   *
   * @returns {Promise<void>}
   * @memberof SqlTableServer
   */
  public async clean(): Promise<void> {
    if (this.getStatus() === ServerStatus.Closed) {
      if (this.metadataStore !== undefined) {
        await this.metadataStore.clean();
      }

      if (this.accountDataStore !== undefined) {
        await this.accountDataStore.clean();
      }
      return;
    }
    throw Error(`Cannot clean up table server in status ${this.getStatus()}.`);
  }

  protected async beforeStart(): Promise<void> {
    const msg = `Azurite Table service (SQL) is starting on ${this.host}:${this.port}`;
    logger.info(msg);

    if (this.accountDataStore !== undefined) {
      await this.accountDataStore.init();
    }

    if (this.metadataStore !== undefined) {
      await this.metadataStore.init();
    }
  }

  protected async afterStart(): Promise<void> {
    const msg = `Azurite Table service (SQL) successfully listens on ${this.getHttpServerAddress()}`;
    logger.info(msg);
  }

  protected async beforeClose(): Promise<void> {
    logger.info(BEFORE_CLOSE_MESSAGE);
  }

  protected async afterClose(): Promise<void> {
    if (this.metadataStore !== undefined) {
      await this.metadataStore.close();
    }

    if (this.accountDataStore !== undefined) {
      await this.accountDataStore.close();
    }

    logger.info(AFTER_CLOSE_MESSAGE);
  }
}
