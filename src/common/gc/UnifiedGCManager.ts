import { EventEmitter } from "events";

import IGCExtentProvider from "../IGCExtentProvider";
import IGCManager from "../IGCManager";
import IExtentStore from "../persistence/IExtentStore";
import ILogger from "../ILogger";

enum Status {
  Initializing,
  Running,
  Closing,
  Closed
}

const DEFAULT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Unified GC Manager that checks references from ALL services (Blob, Queue, Table)
 * before deleting any extent. This prevents cross-service extent deletion issues
 * where one service's GC might delete another service's extents.
 *
 * @export
 * @class UnifiedGCManager
 * @implements {IGCManager}
 */
export default class UnifiedGCManager implements IGCManager {
  private _status: Status = Status.Closed;
  private emitter: EventEmitter = new EventEmitter();

  /**
   * Creates an instance of UnifiedGCManager.
   *
   * @param {IGCExtentProvider[]} referredExtentsProviders All services' extent providers (Blob, Queue, Table)
   * @param {IGCExtentProvider} allExtentsProvider Provider for all extents in the system
   * @param {IExtentStore} extentStore The extent store to delete from
   * @param {(err: Error) => void} errorHandler Error handler callback
   * @param {ILogger} logger Logger instance
   * @param {number} gcIntervalInMS GC interval in milliseconds (default: 24 hours)
   */
  constructor(
    private readonly referredExtentsProviders: IGCExtentProvider[],
    private readonly allExtentsProvider: IGCExtentProvider,
    private readonly extentStore: IExtentStore,
    private readonly errorHandler: (err: Error) => void,
    private readonly logger: ILogger,
    public readonly gcIntervalInMS: number = DEFAULT_GC_INTERVAL_MS
  ) {
    this.emitter.once("error", this.errorHandler);

    // Minimum 1 minute GC interval
    if (gcIntervalInMS <= 0) {
      this.gcIntervalInMS = 60 * 1000;
    }
  }

  public get status(): Status {
    return this._status;
  }

  public async start(): Promise<void> {
    if (this._status === Status.Running) {
      this.logger.info(
        `UnifiedGCManager:start() Already running.`
      );
      return;
    }

    if (this._status !== Status.Closed) {
      const error = new Error(
        `UnifiedGCManager:start() Cannot start, current status: ${Status[this._status]}`
      );
      this.logger.error(error.message);
      throw error;
    }

    this.logger.info(
      `UnifiedGCManager:start() Starting UnifiedGCManager. Set status to Initializing.`
    );
    this._status = Status.Initializing;

    // Initialize all referred extent providers
    for (const provider of this.referredExtentsProviders) {
      if (!provider.isInitialized()) {
        this.logger.info(
          `UnifiedGCManager:start() Initializing extent provider.`
        );
        await provider.init();
      }
    }

    if (!this.allExtentsProvider.isInitialized()) {
      await this.allExtentsProvider.init();
    }

    if (!this.extentStore.isInitialized()) {
      await this.extentStore.init();
    }

    this.logger.info(
      `UnifiedGCManager:start() Trigger mark and sweep loop. Set status to Running.`
    );
    this._status = Status.Running;

    this.markSweepLoop()
      .then(() => {
        this.logger.info(
          `UnifiedGCManager:start() Mark and sweep loop closed.`
        );
        this.emitter.emit("closed");
      })
      .catch(err => {
        this.logger.info(
          `UnifiedGCManager:start() Mark and sweep loop error: ${err.name} ${err.message}`
        );
        this._status = Status.Closed;
        this.emitter.emit("error", err);
      });

    this.logger.info(
      `UnifiedGCManager:start() Successfully started.`
    );
  }

  public async close(): Promise<void> {
    if (this._status === Status.Closed) {
      this.logger.info(
        `UnifiedGCManager:close() Already closed.`
      );
      return;
    }

    if (this._status !== Status.Running) {
      const error = new Error(
        `UnifiedGCManager:close() Cannot close, current status: ${Status[this._status]}`
      );
      this.logger.error(error.message);
      throw error;
    }

    this.logger.info(
      `UnifiedGCManager:close() Closing. Set status to Closing.`
    );
    this._status = Status.Closing;

    this.emitter.emit("abort");

    return new Promise<void>(resolve => {
      this.emitter.once("closed", () => {
        this.logger.info(
          `UnifiedGCManager:close() Successfully closed. Set status to Closed.`
        );
        this._status = Status.Closed;
        resolve();
      });
    });
  }

  private async markSweepLoop(): Promise<void> {
    while (this._status === Status.Running) {
      this.logger.info(
        `UnifiedGCManager:markSweepLoop() Start next mark and sweep.`
      );
      const start = Date.now();
      await this.markSweep();
      const period = Date.now() - start;
      this.logger.info(
        `UnifiedGCManager:markSweepLoop() Mark and sweep finished, took ${period}ms.`
      );

      if (this._status === Status.Running) {
        this.logger.info(
          `UnifiedGCManager:markSweepLoop() Sleep for ${this.gcIntervalInMS}ms.`
        );
        await this.sleep(this.gcIntervalInMS);
      }
    }
  }

  /**
   * Mark-sweep GC algorithm that checks references from ALL services.
   * Only deletes extents that are NOT referenced by ANY service.
   */
  private async markSweep(): Promise<void> {
    // Step 1: Get all extents
    this.logger.info(`UnifiedGCManager:markSweep() Get all extents.`);
    const allExtents = await this.getAllExtents();
    this.logger.info(
      `UnifiedGCManager:markSweep() Got ${allExtents.size} total extents.`
    );

    if (this._status !== Status.Running) {
      return;
    }

    // Step 2: Remove extents that are referenced by ANY service
    this.logger.info(`UnifiedGCManager:markSweep() Check references from all ${this.referredExtentsProviders.length} services.`);

    for (let i = 0; i < this.referredExtentsProviders.length; i++) {
      const provider = this.referredExtentsProviders[i];
      const iter = provider.iteratorExtents();
      let referenceCount = 0;

      for (
        let res = await iter.next();
        (res.done === false || res.value.length > 0) &&
        this._status === Status.Running;
        res = await iter.next()
      ) {
        const chunks = res.value;
        for (const chunk of chunks) {
          if (allExtents.delete(chunk)) {
            referenceCount++;
          }
        }
      }

      this.logger.info(
        `UnifiedGCManager:markSweep() Service ${i + 1} has ${referenceCount} extent references.`
      );
    }

    this.logger.info(
      `UnifiedGCManager:markSweep() Unreferenced extents count: ${allExtents.size}`
    );

    // Step 3: Delete only extents not referenced by ANY service
    if (allExtents.size > 0) {
      this.logger.info(
        `UnifiedGCManager:markSweep() Deleting ${allExtents.size} unreferenced extents.`
      );
      const deletedCount = await this.extentStore.deleteExtents(allExtents);
      this.logger.info(
        `UnifiedGCManager:markSweep() Deleted ${deletedCount} extents (after excluding active write extents).`
      );
    }
  }

  private async getAllExtents(): Promise<Set<string>> {
    const ids: Set<string> = new Set<string>();

    const iter = this.allExtentsProvider.iteratorExtents();
    for (
      let res = await iter.next();
      (res.done === false || res.value.length > 0) &&
      this._status === Status.Running;
      res = await iter.next()
    ) {
      for (const chunk of res.value) {
        ids.add(chunk);
      }
    }

    return ids;
  }

  private async sleep(timeInMS: number): Promise<void> {
    if (timeInMS === 0) {
      return;
    }

    return new Promise<void>(resolve => {
      let timer: NodeJS.Timeout;
      const abortListener = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.emitter.removeListener("abort", abortListener);
        resolve();
      };

      timer = (setTimeout(() => {
        this.emitter.removeListener("abort", abortListener);
        resolve();
      }, timeInMS) as any) as NodeJS.Timeout;
      timer.unref();
      this.emitter.on("abort", abortListener);
    });
  }
}
