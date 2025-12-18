#!/usr/bin/env node
import { access, ensureDir } from "fs-extra";
import { dirname } from "path";

// Load Environment before BlobServerFactory to make sure args works properly
import Environment from "./common/Environment";
// tslint:disable-next-line:ordered-imports
import { BlobServerFactory } from "./blob/BlobServerFactory";
import { QueueServerFactory } from "./queue/QueueServerFactory";
import { TableServerFactory } from "./table/TableServerFactory";

import * as Logger from "./common/Logger";
import SqlBlobServer from "./blob/SqlBlobServer";
import BlobServer from "./blob/BlobServer";
import QueueServer from "./queue/QueueServer";
import SqlQueueServer from "./queue/SqlQueueServer";
import TableServer from "./table/TableServer";
import SqlTableServer from "./table/SqlTableServer";
import { setExtentMemoryLimit } from "./common/ConfigurationBase";
import { AzuriteTelemetryClient } from "./common/Telemetry";

// tslint:disable:no-console

function shutdown(
  blobServer: BlobServer | SqlBlobServer,
  queueServer: QueueServer | SqlQueueServer,
  tableServer: TableServer | SqlTableServer
) {
  const blobBeforeCloseMessage = `Azurite Blob service is closing...`;
  const blobAfterCloseMessage = `Azurite Blob service successfully closed`;
  const queueBeforeCloseMessage = `Azurite Queue service is closing...`;
  const queueAfterCloseMessage = `Azurite Queue service successfully closed`;
  const tableBeforeCloseMessage = `Azurite Table service is closing...`;
  const tableAfterCloseMessage = `Azurite Table service successfully closed`;

  AzuriteTelemetryClient.TraceStopEvent();

  console.log(blobBeforeCloseMessage);
  blobServer.close().then(() => {
    console.log(blobAfterCloseMessage);
  });

  console.log(queueBeforeCloseMessage);
  queueServer.close().then(() => {
    console.log(queueAfterCloseMessage);
  });

  console.log(tableBeforeCloseMessage);
  tableServer.close().then(() => {
    console.log(tableAfterCloseMessage);
  });
}

/**
 * Entry for Azurite services.
 */
async function main() {

  // Initialize and validate environment values from command line parameters
  const env = new Environment();

  const location = await env.location();
  await ensureDir(location);
  await access(location);

  const debugFilePath = await env.debug();
  if (debugFilePath !== undefined) {
    await ensureDir(dirname(debugFilePath!));
    await access(dirname(debugFilePath!));
  }

  // Create servers using factories (auto-detects AZURITE_DB env var for SQL support)
  const blobServerFactory = new BlobServerFactory();
  const blobServer = await blobServerFactory.createServer(env);
  const blobConfig = blobServer.config;

  const queueServerFactory = new QueueServerFactory();
  const queueServer = await queueServerFactory.createServer(env, location);
  const queueConfig = queueServer.config;

  const tableServerFactory = new TableServerFactory();
  const tableServer = await tableServerFactory.createServer(env, location);
  const tableConfig = tableServer.config;

  // We use logger singleton as global debugger logger to track detailed outputs cross layers
  // Note that, debug log is different from access log which is only available in request handler layer to
  // track every request. Access log is not singleton, and initialized in specific RequestHandlerFactory implementations
  // Enable debug log by default before first release for debugging purpose
  Logger.configLogger(blobConfig.enableDebugLog, blobConfig.debugLogFilePath);

  setExtentMemoryLimit(env, true);

  // Start server
  console.log(
    `Azurite Blob service is starting at ${blobConfig.getHttpServerAddress()}`
  );
  await blobServer.start();
  console.log(
    `Azurite Blob service is successfully listening at ${blobServer.getHttpServerAddress()}`
  );

  // Start server
  console.log(
    `Azurite Queue service is starting at ${queueConfig.getHttpServerAddress()}`
  );
  await queueServer.start();
  console.log(
    `Azurite Queue service is successfully listening at ${queueServer.getHttpServerAddress()}`
  );

  // Start server
  console.log(
    `Azurite Table service is starting at ${tableConfig.getHttpServerAddress()}`
  );
  await tableServer.start();
  console.log(
    `Azurite Table service is successfully listening at ${tableServer.getHttpServerAddress()}`
  );

  AzuriteTelemetryClient.init(location, !env.disableTelemetry(), env);
  await AzuriteTelemetryClient.TraceStartEvent();

  // Handle close event
  process
    .once("message", (msg) => {
      if (msg === "shutdown") {
        shutdown(blobServer, queueServer, tableServer);
      }
    })
    .once("SIGINT", () => shutdown(blobServer, queueServer, tableServer))
    .once("SIGTERM", () => shutdown(blobServer, queueServer, tableServer));
}

main().catch((err) => {
  console.error(`Exit due to unhandled error: ${err.message}`);
  process.exit(1);
});
