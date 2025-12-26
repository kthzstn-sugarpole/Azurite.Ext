import * as http from "http";
import * as https from "https";

import AccountDataStore from "../common/AccountDataStore";
import { CertOptions } from "../common/ConfigurationBase";
import IAccountDataStore from "../common/IAccountDataStore";
import IGCManager from "../common/IGCManager";
import IRequestListenerFactory from "../common/IRequestListenerFactory";
import logger from "../common/Logger";
import FSExtentStore from "../common/persistence/FSExtentStore";
import IExtentMetadataStore from "../common/persistence/IExtentMetadataStore";
import IExtentStore from "../common/persistence/IExtentStore";
import SqlExtentMetadataStore from "../common/persistence/SqlExtentMetadataStore";
import ServerBase, { ServerStatus } from "../common/ServerBase";
import QueueGCManager from "./gc/QueueGCManager";
import IQueueMetadataStore from "./persistence/IQueueMetadataStore";
import SqlQueueMetadataStore from "./persistence/SqlQueueMetadataStore";
import SqlQueueConfiguration from "./SqlQueueConfiguration";
import QueueRequestListenerFactory from "./QueueRequestListenerFactory";

const BEFORE_CLOSE_MESSAGE = `Azurite Queue service is closing...`;
const BEFORE_CLOSE_MESSAGE_GC_ERROR = `Azurite Queue service is closing... Critical error happens during GC.`;
const AFTER_CLOSE_MESSAGE = `Azurite Queue service successfully closed`;

/**
 * SQL-based implementation of Azurite Queue HTTP server.
 * This implementation provides a HTTP service based on express framework and SQL database.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlQueueServer
 */
export default class SqlQueueServer extends ServerBase {
  private readonly metadataStore: IQueueMetadataStore;
  private readonly extentMetadataStore: IExtentMetadataStore;
  private readonly extentStore: IExtentStore;
  private readonly accountDataStore: IAccountDataStore;
  private readonly gcManager: IGCManager;

  /**
   * Creates an instance of SqlQueueServer.
   *
   * @param {SqlQueueConfiguration} configuration
   * @memberof SqlQueueServer
   */
  constructor(configuration: SqlQueueConfiguration) {
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

    if (configuration.keepAliveTimeout > 0) {
      httpServer.keepAliveTimeout = configuration.keepAliveTimeout * 1000;
    }

    // Create SQL-based metadata stores
    const metadataStore: IQueueMetadataStore = new SqlQueueMetadataStore(
      configuration.sqlURL,
      configuration.sequelizeOptions
    );

    const extentMetadataStore = new SqlExtentMetadataStore(
      configuration.sqlURL,
      configuration.sequelizeOptions
    );

    const extentStore: IExtentStore = new FSExtentStore(
      extentMetadataStore,
      configuration.persistenceArray,
      logger
    );

    const accountDataStore: IAccountDataStore = new AccountDataStore(logger);

    // Create request listener factory
    const requestListenerFactory: IRequestListenerFactory = new QueueRequestListenerFactory(
      metadataStore,
      extentStore,
      accountDataStore,
      configuration.enableAccessLog,
      configuration.accessLogWriteStream,
      configuration.skipApiVersionCheck,
      configuration.getOAuthLevel(),
      configuration.disableProductStyleUrl
    );

    super(host, port, httpServer, requestListenerFactory, configuration);

    const gcManager = new QueueGCManager(
      metadataStore,
      extentMetadataStore,
      extentStore,
      () => {
        // tslint:disable-next-line:no-console
        console.log(BEFORE_CLOSE_MESSAGE_GC_ERROR);
        logger.info(BEFORE_CLOSE_MESSAGE_GC_ERROR);
        this.close().then(() => {
          // tslint:disable-next-line:no-console
          console.log(AFTER_CLOSE_MESSAGE);
          logger.info(AFTER_CLOSE_MESSAGE);
        });
      },
      logger
    );

    this.metadataStore = metadataStore;
    this.extentMetadataStore = extentMetadataStore;
    this.extentStore = extentStore;
    this.accountDataStore = accountDataStore;
    this.gcManager = gcManager;
  }

  /**
   * Clean up server persisted data.
   *
   * @returns {Promise<void>}
   * @memberof SqlQueueServer
   */
  public async clean(): Promise<void> {
    if (this.getStatus() === ServerStatus.Closed) {
      if (this.extentStore !== undefined) {
        await this.extentStore.clean();
      }

      if (this.extentMetadataStore !== undefined) {
        await this.extentMetadataStore.clean();
      }

      if (this.metadataStore !== undefined) {
        await this.metadataStore.clean();
      }

      if (this.accountDataStore !== undefined) {
        await this.accountDataStore.clean();
      }
      return;
    }
    throw Error(`Cannot clean up queue server in status ${this.getStatus()}.`);
  }

  protected async beforeStart(): Promise<void> {
    const msg = `Azurite Queue service (SQL) is starting on ${this.host}:${this.port}`;
    logger.info(msg);

    if (this.accountDataStore !== undefined) {
      await this.accountDataStore.init();
    }

    if (this.metadataStore !== undefined) {
      await this.metadataStore.init();
    }

    if (this.extentMetadataStore !== undefined) {
      await this.extentMetadataStore.init();
    }

    if (this.extentStore !== undefined) {
      await this.extentStore.init();
    }

    // DISABLED: Queue GC is disabled to prevent cross-service extent deletion.
    // All services share the same Extents table, so Blob GC (24h interval) handles all cleanup.
    // See: https://github.com/Azure/Azurite/issues/XXXX
    // if (this.gcManager !== undefined) {
    //   await this.gcManager.start();
    // }
  }

  protected async afterStart(): Promise<void> {
    const msg = `Azurite Queue service (SQL) successfully listens on ${this.getHttpServerAddress()}`;
    logger.info(msg);
  }

  protected async beforeClose(): Promise<void> {
    logger.info(BEFORE_CLOSE_MESSAGE);
  }

  protected async afterClose(): Promise<void> {
    if (this.gcManager !== undefined) {
      await this.gcManager.close();
    }

    if (this.extentStore !== undefined) {
      await this.extentStore.close();
    }

    if (this.extentMetadataStore !== undefined) {
      await this.extentMetadataStore.close();
    }

    if (this.metadataStore !== undefined) {
      await this.metadataStore.close();
    }

    if (this.accountDataStore !== undefined) {
      await this.accountDataStore.close();
    }

    logger.info(AFTER_CLOSE_MESSAGE);
  }
}
