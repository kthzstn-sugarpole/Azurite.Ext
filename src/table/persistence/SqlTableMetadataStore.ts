import {
  INTEGER,
  Model,
  Op,
  Options as SequelizeOptions,
  Sequelize,
  TEXT
} from "sequelize";

import {
  DEFAULT_SQLITE_OPTIONS,
  ensureDatabaseExists,
  isSqliteConnectionString,
  parseSqliteConnectionString,
  sanitizeConnectionUri
} from "../../common/utils/constants";
import NotImplementedError from "../errors/NotImplementedError";
import StorageErrorFactory from "../errors/StorageErrorFactory";
import * as Models from "../generated/artifacts/models";
import Context from "../generated/Context";
import { QUERY_RESULT_MAX_NUM } from "../utils/constants";
import ITableMetadataStore, {
  Entity,
  ServicePropertiesModel,
  Table,
  TableACL
} from "./ITableMetadataStore";

// tslint:disable: max-classes-per-file
class ServicesModel extends Model { }
class TablesModel extends Model { }
class EntitiesModel extends Model { }

/**
 * A SQL based Table metadata storage implementation based on Sequelize.
 * Supports MySQL, SQL Server, PostgreSQL, and SQLite.
 *
 * @export
 * @class SqlTableMetadataStore
 * @implements {ITableMetadataStore}
 */
export default class SqlTableMetadataStore implements ITableMetadataStore {
  private initialized: boolean = false;
  private closed: boolean = false;
  private readonly connectionURI: string;
  private readonly sequelize: Sequelize;

  // Transaction rollback support
  private transactionRollbackTheseEntities: Entity[] = [];
  private transactionDeleteTheseEntities: Entity[] = [];

  /**
   * Creates an instance of SqlTableMetadataStore.
   *
   * @param {string} connectionURI For example, "postgres://user:pass@example.com:5432/dbname" or "sqlite:./azurite.db"
   * @param {SequelizeOptions} [sequelizeOptions]
   * @memberof SqlTableMetadataStore
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

  public init(): void {
    this.initAsync();
  }

  public close(): void {
    this.closeAsync();
  }

  private async initAsync(): Promise<void> {
    await ensureDatabaseExists(this.connectionURI);
    await this.sequelize.authenticate();

    ServicesModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          primaryKey: true
        },
        cors: {
          type: TEXT
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
        modelName: "TableServices",
        tableName: "TableServices",
        timestamps: false
      }
    );

    TablesModel.init(
      {
        tableId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        account: {
          type: "VARCHAR(32)",
          allowNull: false
        },
        table: {
          type: "VARCHAR(63)",
          allowNull: false
        },
        tableAcl: {
          type: TEXT
        },
        odatametadata: {
          type: "VARCHAR(255)"
        },
        odatatype: {
          type: "VARCHAR(255)"
        },
        odataid: {
          type: "VARCHAR(255)"
        },
        odataeditLink: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Tables",
        tableName: "Tables",
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: ["account", "table"]
          }
        ]
      }
    );

    EntitiesModel.init(
      {
        entityId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        account: {
          type: "VARCHAR(32)",
          allowNull: false
        },
        tableName: {
          type: "VARCHAR(63)",
          allowNull: false
        },
        PartitionKey: {
          // Azure limit is 1KB, but MySQL index limit requires shorter keys
          type: "VARCHAR(512)",
          allowNull: false
        },
        RowKey: {
          // Azure limit is 1KB, but MySQL index limit requires shorter keys
          type: "VARCHAR(512)",
          allowNull: false
        },
        eTag: {
          type: "VARCHAR(127)",
          allowNull: false
        },
        lastModifiedTime: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        properties: {
          type: TEXT
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "TableEntities",
        tableName: "TableEntities",
        timestamps: false,
        indexes: [
          {
            unique: true,
            fields: [
              "account",
              "tableName",
              { name: "PartitionKey", length: 191 },
              { name: "RowKey", length: 191 }
            ]
          },
          {
            fields: ["account", "tableName"]
          }
        ]
      }
    );

    await this.sequelize.sync({ alter: false });
    this.initialized = true;
  }

  private async closeAsync(): Promise<void> {
    await this.sequelize.close();
    this.closed = true;
  }

  public async clean(): Promise<void> {
    // TODO: Implement cleanup in database
  }

  public async createTable(context: Context, tableModel: Table): Promise<void> {
    const existingTable = await TablesModel.findOne({
      where: {
        account: tableModel.account,
        table: { [Op.like]: tableModel.table }
      }
    });

    if (existingTable) {
      throw StorageErrorFactory.getTableAlreadyExists(context);
    }

    await TablesModel.create({
      account: tableModel.account,
      table: tableModel.table,
      tableAcl: this.serializeModelValue(tableModel.tableAcl),
      odatametadata: tableModel.odatametadata,
      odatatype: tableModel.odatatype,
      odataid: tableModel.odataid,
      odataeditLink: tableModel.odataeditLink
    });
  }

  public async deleteTable(
    context: Context,
    table: string,
    account: string
  ): Promise<void> {
    const existingTable = await TablesModel.findOne({
      where: {
        account: account,
        table: { [Op.like]: table }
      }
    });

    if (!existingTable) {
      throw StorageErrorFactory.ResourceNotFound(context);
    }

    const tableName = this.getModelValue<string>(existingTable, "table", true);

    await TablesModel.destroy({
      where: { account: account, table: tableName }
    });

    await EntitiesModel.destroy({
      where: { account: account, tableName: tableName }
    });
  }

  public async setTableACL(
    account: string,
    table: string,
    context: Context,
    tableACL?: TableACL
  ): Promise<void> {
    const existingTable = await TablesModel.findOne({
      where: {
        account: account,
        table: { [Op.like]: table }
      }
    });

    if (!existingTable) {
      throw StorageErrorFactory.getTableNotFound(context);
    }

    await TablesModel.update(
      { tableAcl: this.serializeModelValue(tableACL) },
      { where: { account: account, table: this.getModelValue<string>(existingTable, "table", true) } }
    );
  }

  public async getTable(
    account: string,
    table: string,
    context: Context
  ): Promise<Table> {
    const findResult = await TablesModel.findOne({
      where: {
        account: account,
        table: { [Op.like]: table }
      }
    });

    if (!findResult) {
      throw StorageErrorFactory.getTableNotFound(context);
    }

    return this.convertDbModelToTableModel(findResult);
  }

  public async queryTable(
    context: Context,
    account: string,
    queryOptions: Models.QueryOptions,
    nextTable?: string
  ): Promise<[Table[], string | undefined]> {
    const whereQuery: any = { account: account };

    if (nextTable) {
      whereQuery.table = { [Op.gte]: nextTable };
    }

    const top = queryOptions.top || 1000;

    const tables = await TablesModel.findAll({
      where: whereQuery,
      order: [["table", "ASC"]],
      limit: top + 1
    });

    let nextTableName: string | undefined;
    if (tables.length > top) {
      const tail = tables.pop();
      nextTableName = this.getModelValue<string>(tail!, "table", true);
    }

    return [tables.map((t) => this.convertDbModelToTableModel(t)), nextTableName];
  }

  public async insertTableEntity(
    context: Context,
    table: string,
    account: string,
    entity: Entity,
    batchId?: string
  ): Promise<Entity> {
    await this.ensureTableExists(context, account, table);

    const existingEntity = await EntitiesModel.findOne({
      where: {
        account: account,
        tableName: table,
        PartitionKey: entity.PartitionKey,
        RowKey: entity.RowKey
      }
    });

    if (existingEntity) {
      throw StorageErrorFactory.getEntityAlreadyExist(context);
    }

    entity.properties.Timestamp = entity.lastModifiedTime;
    entity.properties["Timestamp@odata.type"] = "Edm.DateTime";

    await EntitiesModel.create({
      account: account,
      tableName: table,
      PartitionKey: entity.PartitionKey,
      RowKey: entity.RowKey,
      eTag: entity.eTag,
      lastModifiedTime: entity.lastModifiedTime,
      properties: this.serializeModelValue(entity.properties)
    });

    if (batchId !== "" && batchId !== undefined) {
      this.transactionDeleteTheseEntities.push(entity);
    }

    return entity;
  }

  public async insertOrUpdateTableEntity(
    context: Context,
    table: string,
    account: string,
    entity: Entity,
    ifMatch?: string,
    batchId?: string
  ): Promise<Entity> {
    const existingEntity = await this.queryTableEntitiesWithPartitionAndRowKey(
      context,
      table,
      account,
      entity.PartitionKey,
      entity.RowKey,
      batchId
    );

    if (existingEntity) {
      return this.updateTableEntity(context, table, account, entity, ifMatch, batchId);
    } else {
      return this.insertTableEntity(context, table, account, entity, batchId);
    }
  }

  public async insertOrMergeTableEntity(
    context: Context,
    table: string,
    account: string,
    entity: Entity,
    ifMatch?: string,
    batchId?: string
  ): Promise<Entity> {
    const existingEntity = await this.queryTableEntitiesWithPartitionAndRowKey(
      context,
      table,
      account,
      entity.PartitionKey,
      entity.RowKey,
      batchId
    );

    if (existingEntity) {
      return this.mergeTableEntity(context, table, account, entity, ifMatch, batchId);
    } else {
      return this.insertTableEntity(context, table, account, entity, batchId);
    }
  }

  public async deleteTableEntity(
    context: Context,
    table: string,
    account: string,
    partitionKey: string,
    rowKey: string,
    etag: string,
    batchId: string
  ): Promise<void> {
    await this.ensureTableExists(context, account, table);

    const existingEntity = await EntitiesModel.findOne({
      where: {
        account: account,
        tableName: table,
        PartitionKey: partitionKey,
        RowKey: rowKey
      }
    });

    if (!existingEntity) {
      throw StorageErrorFactory.getEntityNotFound(context);
    }

    const currentEtag = this.getModelValue<string>(existingEntity, "eTag", true);
    if (etag !== "*" && currentEtag !== etag) {
      throw StorageErrorFactory.getPreconditionFailed(context);
    }

    if (batchId !== "" && batchId !== undefined) {
      this.transactionRollbackTheseEntities.push(
        this.convertDbModelToEntityModel(existingEntity)
      );
    }

    await EntitiesModel.destroy({
      where: {
        account: account,
        tableName: table,
        PartitionKey: partitionKey,
        RowKey: rowKey
      }
    });
  }

  public async queryTableEntities(
    context: Context,
    account: string,
    table: string,
    queryOptions: Models.QueryOptions,
    nextPartitionKey?: string,
    nextRowKey?: string
  ): Promise<[Entity[], string | undefined, string | undefined]> {
    await this.ensureTableExists(context, account, table);

    const whereQuery: any = {
      account: account,
      tableName: table
    };

    // Handle continuation tokens
    if (nextPartitionKey !== undefined && nextRowKey !== undefined) {
      whereQuery[Op.or] = [
        { PartitionKey: { [Op.gt]: nextPartitionKey } },
        {
          PartitionKey: nextPartitionKey,
          RowKey: { [Op.gte]: nextRowKey }
        }
      ];
    } else if (nextPartitionKey !== undefined) {
      whereQuery.PartitionKey = { [Op.gte]: nextPartitionKey };
    }

    const maxResults = queryOptions.top || QUERY_RESULT_MAX_NUM;

    const entities = await EntitiesModel.findAll({
      where: whereQuery,
      order: [
        ["PartitionKey", "ASC"],
        ["RowKey", "ASC"]
      ],
      limit: maxResults + 1
    });

    let nextPK: string | undefined;
    let nextRK: string | undefined;

    if (entities.length > maxResults) {
      const nextEntity = entities[maxResults];
      nextPK = this.getModelValue<string>(nextEntity, "PartitionKey", true);
      nextRK = this.getModelValue<string>(nextEntity, "RowKey", true);
      entities.pop();
    }

    const result = entities.map((e) => this.convertDbModelToEntityModel(e));

    // Apply filter in memory if provided (simplified - full OData support would need SqlTableStoreQueryGenerator)
    if (queryOptions.filter) {
      // TODO: Implement proper OData filter parsing
    }

    return [result, nextPK, nextRK];
  }

  public async queryTableEntitiesWithPartitionAndRowKey(
    context: Context,
    table: string,
    account: string,
    partitionKey: string,
    rowKey: string,
    batchId?: string
  ): Promise<Entity | undefined> {
    const findResult = await EntitiesModel.findOne({
      where: {
        account: account,
        tableName: table,
        PartitionKey: partitionKey,
        RowKey: rowKey
      }
    });

    if (!findResult) {
      return undefined;
    }

    return this.convertDbModelToEntityModel(findResult);
  }

  public async getTableAccessPolicy(
    context: Context,
    table: string,
    options: Models.TableGetAccessPolicyOptionalParams
  ): Promise<Models.TableGetAccessPolicyResponse> {
    throw new NotImplementedError(context);
  }

  public async setTableAccessPolicy(
    context: Context,
    table: string,
    options: Models.TableSetAccessPolicyOptionalParams
  ): Promise<Models.TableSetAccessPolicyResponse> {
    throw new NotImplementedError(context);
  }

  public async getServiceProperties(
    context: Context,
    account: string
  ): Promise<ServicePropertiesModel | undefined> {
    const findResult = await ServicesModel.findByPk(account);
    if (!findResult) {
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

  public async setServiceProperties(
    context: Context,
    serviceProperties: ServicePropertiesModel
  ): Promise<ServicePropertiesModel> {
    await ServicesModel.upsert({
      accountName: serviceProperties.accountName,
      cors: this.serializeModelValue(serviceProperties.cors),
      logging: this.serializeModelValue(serviceProperties.logging),
      minuteMetrics: this.serializeModelValue(serviceProperties.minuteMetrics),
      hourMetrics: this.serializeModelValue(serviceProperties.hourMetrics)
    });

    return serviceProperties;
  }

  public async beginBatchTransaction(batchId: string): Promise<void> {
    if (
      this.transactionRollbackTheseEntities.length > 0 ||
      this.transactionDeleteTheseEntities.length > 0
    ) {
      throw new Error("Transaction Overlap!");
    }
  }

  public async endBatchTransaction(
    account: string,
    table: string,
    batchId: string,
    context: Context,
    succeeded: boolean
  ): Promise<void> {
    if (!succeeded) {
      // Rollback: restore deleted entities
      for (const entity of this.transactionRollbackTheseEntities) {
        await EntitiesModel.create({
          account: account,
          tableName: table,
          PartitionKey: entity.PartitionKey,
          RowKey: entity.RowKey,
          eTag: entity.eTag,
          lastModifiedTime: entity.lastModifiedTime,
          properties: this.serializeModelValue(entity.properties)
        });
      }

      // Rollback: remove inserted entities
      for (const entity of this.transactionDeleteTheseEntities) {
        await EntitiesModel.destroy({
          where: {
            account: account,
            tableName: table,
            PartitionKey: entity.PartitionKey,
            RowKey: entity.RowKey
          }
        });
      }
    }

    this.transactionRollbackTheseEntities = [];
    this.transactionDeleteTheseEntities = [];
  }

  // Private helper methods
  private async updateTableEntity(
    context: Context,
    table: string,
    account: string,
    entity: Entity,
    ifMatch?: string,
    batchId?: string
  ): Promise<Entity> {
    await this.ensureTableExists(context, account, table);

    const existingEntity = await EntitiesModel.findOne({
      where: {
        account: account,
        tableName: table,
        PartitionKey: entity.PartitionKey,
        RowKey: entity.RowKey
      }
    });

    if (!existingEntity) {
      throw StorageErrorFactory.getEntityNotFound(context);
    }

    if (ifMatch !== undefined && ifMatch !== "*") {
      const currentEtag = this.getModelValue<string>(existingEntity, "eTag", true);
      if (currentEtag !== ifMatch) {
        throw StorageErrorFactory.getPreconditionFailed(context);
      }
    }

    if (batchId !== "" && batchId !== undefined) {
      this.transactionRollbackTheseEntities.push(
        this.convertDbModelToEntityModel(existingEntity)
      );
    }

    entity.properties.Timestamp = entity.lastModifiedTime;
    entity.properties["Timestamp@odata.type"] = "Edm.DateTime";

    await EntitiesModel.update(
      {
        eTag: entity.eTag,
        lastModifiedTime: entity.lastModifiedTime,
        properties: this.serializeModelValue(entity.properties)
      },
      {
        where: {
          account: account,
          tableName: table,
          PartitionKey: entity.PartitionKey,
          RowKey: entity.RowKey
        }
      }
    );

    return entity;
  }

  private async mergeTableEntity(
    context: Context,
    table: string,
    account: string,
    entity: Entity,
    ifMatch?: string,
    batchId?: string
  ): Promise<Entity> {
    await this.ensureTableExists(context, account, table);

    const existingEntity = await EntitiesModel.findOne({
      where: {
        account: account,
        tableName: table,
        PartitionKey: entity.PartitionKey,
        RowKey: entity.RowKey
      }
    });

    if (!existingEntity) {
      throw StorageErrorFactory.getEntityNotFound(context);
    }

    if (ifMatch !== undefined && ifMatch !== "*") {
      const currentEtag = this.getModelValue<string>(existingEntity, "eTag", true);
      if (currentEtag !== ifMatch) {
        throw StorageErrorFactory.getPreconditionFailed(context);
      }
    }

    if (batchId !== "" && batchId !== undefined) {
      this.transactionRollbackTheseEntities.push(
        this.convertDbModelToEntityModel(existingEntity)
      );
    }

    // Merge properties
    const existingProps = this.deserializeModelValue(existingEntity, "properties") || {};
    const mergedProps = { ...existingProps, ...entity.properties };
    mergedProps.Timestamp = entity.lastModifiedTime;
    mergedProps["Timestamp@odata.type"] = "Edm.DateTime";

    await EntitiesModel.update(
      {
        eTag: entity.eTag,
        lastModifiedTime: entity.lastModifiedTime,
        properties: this.serializeModelValue(mergedProps)
      },
      {
        where: {
          account: account,
          tableName: table,
          PartitionKey: entity.PartitionKey,
          RowKey: entity.RowKey
        }
      }
    );

    return { ...entity, properties: mergedProps };
  }

  private async ensureTableExists(
    context: Context,
    account: string,
    table: string
  ): Promise<void> {
    const existingTable = await TablesModel.findOne({
      where: {
        account: account,
        table: { [Op.like]: table }
      }
    });

    if (!existingTable) {
      throw StorageErrorFactory.getTableNotFound(context);
    }
  }

  private convertDbModelToTableModel(model: Model): Table {
    return {
      account: this.getModelValue<string>(model, "account", true),
      table: this.getModelValue<string>(model, "table", true),
      tableAcl: this.deserializeModelValue(model, "tableAcl"),
      odatametadata: this.getModelValue<string>(model, "odatametadata"),
      odatatype: this.getModelValue<string>(model, "odatatype"),
      odataid: this.getModelValue<string>(model, "odataid"),
      odataeditLink: this.getModelValue<string>(model, "odataeditLink")
    };
  }

  private convertDbModelToEntityModel(model: Model): Entity {
    return {
      PartitionKey: this.getModelValue<string>(model, "PartitionKey", true),
      RowKey: this.getModelValue<string>(model, "RowKey", true),
      eTag: this.getModelValue<string>(model, "eTag", true),
      lastModifiedTime: this.getModelValue<string>(model, "lastModifiedTime", true),
      properties: this.deserializeModelValue(model, "properties") || {}
    };
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
        `SqlTableMetadataStore:getModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }
    return value;
  }
}
