import {
  BIGINT,
  INTEGER,
  Model,
  Op,
  Options as SequelizeOptions,
  Sequelize
} from "sequelize";

import {
  DEFAULT_SQLITE_OPTIONS,
  ensureDatabaseExists,
  isSqliteConnectionString,
  parseSqliteConnectionString,
  sanitizeConnectionUri
} from "../../common/utils/constants";
import StorageErrorFactory from "../errors/StorageErrorFactory";
import Context from "../generated/Context";
import { QUEUE_STATUSCODE } from "../utils/constants";
import {
  IExtentChunk,
  IQueueMetadata,
  IQueueMetadataStore,
  MessageModel,
  MessageUpdateProperties,
  QueueACL,
  QueueModel,
  ServicePropertiesModel
} from "./IQueueMetadataStore";
import QueueReferredExtentsAsyncIterator from "./QueueReferredExtentsAsyncIterator";

// tslint:disable: max-classes-per-file
class ServicesModel extends Model { }
class QueuesModel extends Model { }
class MessagesModel extends Model { }

/**
 * A SQL based Queue metadata storage implementation based on Sequelize.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlQueueMetadataStore
 * @implements {IQueueMetadataStore}
 */
export default class SqlQueueMetadataStore implements IQueueMetadataStore {
  private initialized: boolean = false;
  private closed: boolean = false;
  private readonly connectionURI: string;
  private readonly sequelize: Sequelize;

  /**
   * Creates an instance of SqlQueueMetadataStore.
   *
   * @param {string} connectionURI For example, "postgres://user:pass@example.com:5432/dbname" or "sqlite:./azurite.db"
   * @param {SequelizeOptions} [sequelizeOptions]
   * @memberof SqlQueueMetadataStore
   */
  public constructor(
    connectionURI: string,
    sequelizeOptions?: SequelizeOptions
  ) {
    const sanitizedURI = sanitizeConnectionUri(connectionURI);
    this.connectionURI = sanitizedURI;
    // Handle SQLite connection string
    if (isSqliteConnectionString(sanitizedURI)) {
      const dbPath = parseSqliteConnectionString(sanitizedURI);
      this.sequelize = new Sequelize({
        ...DEFAULT_SQLITE_OPTIONS,
        ...sequelizeOptions,
        storage: dbPath
      });
    }
    // Enable encrypt connection for SQL Server
    else if (sanitizedURI.startsWith("mssql") && sequelizeOptions) {
      sequelizeOptions.dialectOptions = sequelizeOptions.dialectOptions || {};
      (sequelizeOptions.dialectOptions as any).options =
        (sequelizeOptions.dialectOptions as any).options || {};
      (sequelizeOptions.dialectOptions as any).options.encrypt = true;
      this.sequelize = new Sequelize(sanitizedURI, sequelizeOptions);
    } else {
      this.sequelize = new Sequelize(sanitizedURI, sequelizeOptions);
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public async init(): Promise<void> {
    await ensureDatabaseExists(this.connectionURI);
    await this.sequelize.authenticate();

    ServicesModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          primaryKey: true
        },
        cors: {
          type: "VARCHAR(4095)"
        },
        logging: {
          type: "VARCHAR(255)"
        },
        minuteMetrics: {
          type: "VARCHAR(255)"
        },
        hourMetrics: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "QueueServices",
        tableName: "QueueServices",
        timestamps: false
      }
    );

    QueuesModel.init(
      {
        queueId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        accountName: {
          type: "VARCHAR(32)",
          allowNull: false
        },
        name: {
          type: "VARCHAR(63)",
          allowNull: false
        },
        metadata: {
          type: "VARCHAR(4095)"
        },
        queueAcl: {
          type: "VARCHAR(1023)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Queues",
        tableName: "Queues",
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: ["accountName", "name"]
          }
        ]
      }
    );

    MessagesModel.init(
      {
        messageDbId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        accountName: {
          type: "VARCHAR(32)",
          allowNull: false
        },
        queueName: {
          type: "VARCHAR(63)",
          allowNull: false
        },
        messageId: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        popReceipt: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        timeNextVisible: {
          type: BIGINT,
          allowNull: false
        },
        insertionTime: {
          type: BIGINT,
          allowNull: false
        },
        expirationTime: {
          type: BIGINT,
          allowNull: false
        },
        dequeueCount: {
          type: INTEGER.UNSIGNED,
          allowNull: false,
          defaultValue: 0
        },
        persistency: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "QueueMessages",
        tableName: "QueueMessages",
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: ["accountName", "queueName", "messageId"]
          },
          {
            fields: ["accountName", "queueName", "timeNextVisible"]
          }
        ]
      }
    );

    await this.sequelize.sync({ alter: false });
    this.initialized = true;
  }

  public async close(): Promise<void> {
    await this.sequelize.close();
    this.closed = true;
  }

  public async clean(): Promise<void> {
    // TODO: Implement cleanup in database
  }

  public async updateServiceProperties(
    updateProperties: ServicePropertiesModel
  ): Promise<void> {
    await ServicesModel.upsert({
      accountName: updateProperties.accountName,
      cors: this.serializeModelValue(updateProperties.cors),
      logging: this.serializeModelValue(updateProperties.logging),
      minuteMetrics: this.serializeModelValue(updateProperties.minuteMetrics),
      hourMetrics: this.serializeModelValue(updateProperties.hourMetrics)
    });
  }

  public async getServiceProperties(
    account: string
  ): Promise<ServicePropertiesModel | undefined> {
    const findResult = await ServicesModel.findByPk(account);
    if (findResult === null) {
      return undefined;
    }

    return {
      accountName: account,
      cors: this.deserializeModelValue(findResult, "cors"),
      logging: this.deserializeModelValue(findResult, "logging"),
      minuteMetrics: this.deserializeModelValue(findResult, "minuteMetrics"),
      hourMetrics: this.deserializeModelValue(findResult, "hourMetrics")
    };
  }

  public async listQueues(
    account: string,
    prefix: string = "",
    maxResults: number = 5000,
    marker: number = 0
  ): Promise<[QueueModel[], number | undefined]> {
    const whereQuery: any = { accountName: account };

    if (prefix.length > 0) {
      whereQuery.name = {
        [Op.like]: `${prefix}%`
      };
    }

    if (marker > 0) {
      whereQuery.queueId = {
        [Op.gt]: marker
      };
    }

    const findResult = await QueuesModel.findAll({
      limit: maxResults + 1,
      where: whereQuery as any,
      order: [["name", "ASC"]]
    });

    const queues: QueueModel[] = findResult
      .slice(0, maxResults)
      .map((model) => this.convertDbModelToQueueModel(model));

    if (findResult.length <= maxResults) {
      return [queues, undefined];
    } else {
      const lastItem = findResult[findResult.length - 2];
      const nextMarker = this.getModelValue<number>(lastItem, "queueId", true);
      return [queues, nextMarker];
    }
  }

  public async getQueue(
    account: string,
    queue: string,
    context?: Context
  ): Promise<QueueModel> {
    const findResult = await QueuesModel.findOne({
      where: { accountName: account, name: queue }
    });

    if (!findResult) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getQueueNotFound(requestId);
    }

    return this.convertDbModelToQueueModel(findResult);
  }

  public async createQueue(
    queue: QueueModel,
    context?: Context
  ): Promise<QUEUE_STATUSCODE> {
    const existingQueue = await QueuesModel.findOne({
      where: { accountName: queue.accountName, name: queue.name }
    });

    if (existingQueue) {
      // Check if metadata matches
      const existingMetadata = this.deserializeModelValue(existingQueue, "metadata");
      const newMetadata = queue.metadata;

      if (this.metadataEquals(existingMetadata, newMetadata)) {
        return 204;
      } else {
        throw StorageErrorFactory.getQueueAlreadyExists(
          context ? context.contextID : undefined
        );
      }
    }

    await QueuesModel.create({
      accountName: queue.accountName,
      name: queue.name,
      metadata: this.serializeModelValue(queue.metadata),
      queueAcl: this.serializeModelValue(queue.queueAcl)
    });

    return 201;
  }

  public async deleteQueue(
    account: string,
    queue: string,
    context?: Context
  ): Promise<void> {
    const findResult = await QueuesModel.findOne({
      where: { accountName: account, name: queue }
    });

    if (!findResult) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getQueueNotFound(requestId);
    }

    await QueuesModel.destroy({
      where: { accountName: account, name: queue }
    });

    await MessagesModel.destroy({
      where: { accountName: account, queueName: queue }
    });
  }

  public async setQueueACL(
    account: string,
    queue: string,
    queueACL?: QueueACL,
    context?: Context
  ): Promise<void> {
    const [affectedCount] = await QueuesModel.update(
      { queueAcl: this.serializeModelValue(queueACL) },
      { where: { accountName: account, name: queue } }
    );

    if (affectedCount === 0) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getQueueNotFound(requestId);
    }
  }

  public async setQueueMetadata(
    account: string,
    queue: string,
    metadata?: IQueueMetadata,
    context?: Context
  ): Promise<void> {
    const [affectedCount] = await QueuesModel.update(
      { metadata: this.serializeModelValue(metadata) },
      { where: { accountName: account, name: queue } }
    );

    if (affectedCount === 0) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getQueueNotFound(requestId);
    }
  }

  public async getMessagesCount(
    account: string,
    queue: string,
    context?: Context
  ): Promise<number> {
    // Verify queue exists
    await this.getQueue(account, queue, context);

    const count = await MessagesModel.count({
      where: { accountName: account, queueName: queue }
    });

    return count;
  }

  public async insertMessage(
    message: MessageModel,
    context?: Context
  ): Promise<void> {
    // Verify queue exists
    await this.getQueue(message.accountName, message.queueName, context);

    await MessagesModel.create({
      accountName: message.accountName,
      queueName: message.queueName,
      messageId: message.messageId,
      popReceipt: message.popReceipt,
      timeNextVisible: message.timeNextVisible.getTime(),
      insertionTime: message.insertionTime.getTime(),
      expirationTime: message.expirationTime.getTime(),
      dequeueCount: message.dequeueCount,
      persistency: this.serializeModelValue(message.persistency)
    });
  }

  public async peekMessages(
    account: string,
    queue: string,
    numOfMessages: number = 1,
    queryDate?: Date,
    context?: Context
  ): Promise<MessageModel[]> {
    await this.getQueue(account, queue, context);
    await this.clearExpiredMessages(account, queue);

    const queryTime = queryDate ? queryDate.getTime() : Date.now();

    const messages = await MessagesModel.findAll({
      where: {
        accountName: account,
        queueName: queue,
        timeNextVisible: { [Op.lte]: queryTime }
      },
      order: [
        ["timeNextVisible", "ASC"],
        ["messageDbId", "ASC"]
      ],
      limit: numOfMessages
    });

    return messages.map((m) => this.convertDbModelToMessageModel(m));
  }

  public async getMessages(
    account: string,
    queue: string,
    timeNextVisible: Date,
    popReceipt: string,
    numOfMessages: number = 1,
    queryDate?: Date,
    context?: Context
  ): Promise<MessageModel[]> {
    await this.getQueue(account, queue, context);
    await this.clearExpiredMessages(account, queue);

    const queryTime = queryDate ? queryDate.getTime() : Date.now();

    const messages = await MessagesModel.findAll({
      where: {
        accountName: account,
        queueName: queue,
        timeNextVisible: { [Op.lte]: queryTime }
      },
      order: [
        ["timeNextVisible", "ASC"],
        ["messageDbId", "ASC"]
      ],
      limit: numOfMessages
    });

    const visibleTimeMs = timeNextVisible.getTime();
    const result: MessageModel[] = [];

    for (const msg of messages) {
      await MessagesModel.update(
        {
          timeNextVisible: visibleTimeMs,
          popReceipt: popReceipt,
          dequeueCount: this.getModelValue<number>(msg, "dequeueCount", true) + 1
        },
        { where: { messageDbId: this.getModelValue<number>(msg, "messageDbId", true) } }
      );

      result.push({
        ...this.convertDbModelToMessageModel(msg),
        timeNextVisible: timeNextVisible,
        popReceipt: popReceipt,
        dequeueCount: this.getModelValue<number>(msg, "dequeueCount", true) + 1
      });
    }

    return result;
  }

  public async deleteMessage(
    account: string,
    queue: string,
    messageId: string,
    validatingPopReceipt: string,
    context?: Context
  ): Promise<void> {
    await this.getQueue(account, queue, context);
    await this.clearExpiredMessages(account, queue);

    const message = await MessagesModel.findOne({
      where: { accountName: account, queueName: queue, messageId: messageId }
    });

    if (!message) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getMessageNotFound(requestId);
    }

    if (this.getModelValue<string>(message, "popReceipt") !== validatingPopReceipt) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getPopReceiptMismatch(requestId);
    }

    await MessagesModel.destroy({
      where: { accountName: account, queueName: queue, messageId: messageId }
    });
  }

  public async updateMessage(
    message: MessageUpdateProperties,
    validatingPopReceipt: string,
    context?: Context
  ): Promise<void> {
    await this.getQueue(message.accountName, message.queueName, context);
    await this.clearExpiredMessages(message.accountName, message.queueName);

    const existingMessage = await MessagesModel.findOne({
      where: {
        accountName: message.accountName,
        queueName: message.queueName,
        messageId: message.messageId
      }
    });

    if (!existingMessage) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getMessageNotFound(requestId);
    }

    if (this.getModelValue<string>(existingMessage, "popReceipt") !== validatingPopReceipt) {
      const requestId = context ? context.contextID : undefined;
      throw StorageErrorFactory.getPopReceiptMismatch(requestId);
    }

    const updateData: any = {
      popReceipt: message.popReceipt,
      timeNextVisible: message.timeNextVisible.getTime()
    };

    if (message.persistency !== undefined) {
      updateData.persistency = this.serializeModelValue(message.persistency);
    }

    await MessagesModel.update(updateData, {
      where: {
        accountName: message.accountName,
        queueName: message.queueName,
        messageId: message.messageId
      }
    });
  }

  public async clearMessages(
    account: string,
    queue: string,
    context?: Context
  ): Promise<void> {
    await this.getQueue(account, queue, context);

    await MessagesModel.destroy({
      where: { accountName: account, queueName: queue }
    });
  }

  public async listMessages(
    maxResults: number = 5000,
    marker?: number | undefined
  ): Promise<[MessageModel[], number | undefined]> {
    const whereQuery: any = {};
    if (marker !== undefined) {
      whereQuery.messageDbId = { [Op.gt]: marker };
    }

    const messages = await MessagesModel.findAll({
      where: whereQuery,
      order: [["messageDbId", "ASC"]],
      limit: maxResults
    });

    if (messages.length < maxResults) {
      return [messages.map((m) => this.convertDbModelToMessageModel(m)), undefined];
    }

    const lastItem = messages[messages.length - 1];
    const nextMarker = this.getModelValue<number>(lastItem, "messageDbId", true);
    return [messages.map((m) => this.convertDbModelToMessageModel(m)), nextMarker];
  }

  public iteratorExtents(): AsyncIterator<string[]> {
    return new QueueReferredExtentsAsyncIterator(this);
  }

  // Helper methods
  private async clearExpiredMessages(account: string, queue: string): Promise<void> {
    const now = Date.now();
    await MessagesModel.destroy({
      where: {
        accountName: account,
        queueName: queue,
        expirationTime: { [Op.lt]: now }
      }
    });
  }

  private convertDbModelToQueueModel(model: Model): QueueModel {
    return {
      accountName: this.getModelValue<string>(model, "accountName", true),
      name: this.getModelValue<string>(model, "name", true),
      metadata: this.deserializeModelValue(model, "metadata"),
      queueAcl: this.deserializeModelValue(model, "queueAcl")
    };
  }

  private convertDbModelToMessageModel(model: Model): MessageModel {
    return {
      accountName: this.getModelValue<string>(model, "accountName", true),
      queueName: this.getModelValue<string>(model, "queueName", true),
      messageId: this.getModelValue<string>(model, "messageId", true),
      popReceipt: this.getModelValue<string>(model, "popReceipt", true),
      timeNextVisible: new Date(this.getModelValue<number>(model, "timeNextVisible", true)),
      insertionTime: new Date(this.getModelValue<number>(model, "insertionTime", true)),
      expirationTime: new Date(this.getModelValue<number>(model, "expirationTime", true)),
      dequeueCount: this.getModelValue<number>(model, "dequeueCount", true),
      persistency: this.deserializeModelValue(model, "persistency") as IExtentChunk
    };
  }

  private metadataEquals(meta1: any, meta2: any): boolean {
    if (meta1 === undefined && meta2 === undefined) return true;
    if (meta1 === undefined || meta2 === undefined) return false;

    const keys1 = Object.keys(meta1);
    const keys2 = Object.keys(meta2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
      if (meta1[key] !== meta2[key]) return false;
    }

    return true;
  }

  private serializeModelValue(value: any): string | null {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
  }

  private deserializeModelValue(model: Model, key: string): any {
    const value = model.get(key) as string | null;
    if (value === null || value === undefined) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private getModelValue<T>(model: Model, key: string): T | undefined;
  private getModelValue<T>(model: Model, key: string, isRequired: true): T;
  private getModelValue<T>(
    model: Model,
    key: string,
    isRequired?: boolean
  ): T | undefined {
    const value = model.get(key) as T | undefined;
    if (value === undefined && isRequired === true) {
      throw new Error(
        `SqlQueueMetadataStore:getModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }
    return value;
  }
}
