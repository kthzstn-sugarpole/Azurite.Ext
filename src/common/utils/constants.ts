export const AZURITE_ACCOUNTS_ENV = "AZURITE_ACCOUNTS"; // Customize account name and keys by env
export const DEFAULT_ACCOUNTS_REFRESH_INTERVAL = 60 * 1000; // 60s
export const DEFAULT_FD_CACHE_NUMBER = 100;
export const FD_CACHE_NUMBER_MIN = 1;
export const FD_CACHE_NUMBER_MAX = 100;
export const DEFAULT_MAX_EXTENT_SIZE = 64 * 1024 * 1024; // 64 MB
export const DEFAULT_READ_CONCURRENCY = 100;
export const DEFAULT_EXTENT_GC_PROTECT_TIME_IN_MS = 10 * 60 * 1000; // 10mins
export const DEFAULT_SQL_CHARSET = "utf8mb4";
// IP regex.
// This is to distinguish IP style hostname from others
// When host matches it, we assume user is accessing emulator by IP address.
// Otherwise, try to extract string before first dot, as account name.
export const IP_REGEX = new RegExp("^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$");
// No Account Host Names.
// This is to distinguish hostnames that will not contain the account name
// When host matches it, we assume user is accessing emulator by the host name.
// Otherwise, try to extract string before first dot, as account name.
export const NO_ACCOUNT_HOST_NAMES = new Set().add("host.docker.internal");

// Use utf8mb4_bin instead of utf8mb4_general_ci to honor case-sensitive
// https://dev.mysql.com/doc/refman/8.0/en/case-sensitivity.html
export const DEFAULT_SQL_COLLATE = "utf8mb4_bin";
export const DEFAULT_SQL_OPTIONS = {
  logging: false,
  pool: {
    max: 20,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  charset: DEFAULT_SQL_CHARSET,
  collate: DEFAULT_SQL_COLLATE,
  dialectOptions: {
    timezone: "+00:00"
  }
};

// SQLite specific options
export const DEFAULT_SQLITE_OPTIONS = {
  dialect: "sqlite" as const,
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
};

// Environment variable for database connection
export const AZURITE_DB_ENV = "AZURITE_DB";

// Check if connection string is SQLite
export function isSqliteConnectionString(connectionUri: string): boolean {
  return connectionUri.startsWith("sqlite:");
}

// Parse SQLite connection string to get file path
export function parseSqliteConnectionString(connectionUri: string): string {
  // Format: sqlite:./path/to/db.sqlite or sqlite:///absolute/path/db.sqlite
  return connectionUri.replace(/^sqlite:\/?/, "");
}

/**
 * Sanitize connection URI by removing JDBC-style query parameters
 * that are not supported by mysql2/tedious drivers.
 * 
 * Example input:  mysql://user:pass@host:3306/db?useSSL=false&allowPublicKeyRetrieval=true
 * Example output: mysql://user:pass@host:3306/db
 */
export function sanitizeConnectionUri(connectionUri: string): string {
  // Skip for SQLite
  if (isSqliteConnectionString(connectionUri)) {
    return connectionUri;
  }

  // Remove query parameters (everything after ?)
  const queryIndex = connectionUri.indexOf("?");
  if (queryIndex !== -1) {
    const sanitized = connectionUri.substring(0, queryIndex);
    console.log(`Sanitized connection URI: removed query parameters`);
    return sanitized;
  }

  return connectionUri;
}

/**
 * Parse database connection URI and extract components
 * Supports: mysql://user:pass@host:port/database, mssql://user:pass@host:port/database
 */
export function parseConnectionUri(connectionUri: string): {
  dialect: string;
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
} | null {
  try {
    // Replace mysql:// or mssql:// with http:// for URL parsing
    const dialect = connectionUri.split("://")[0];
    const urlString = connectionUri.replace(/^(\w+):\/\//, "http://");
    const url = new URL(urlString);

    const database = url.pathname.replace(/^\//, "");
    if (!database) return null;

    return {
      dialect,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: parseInt(url.port, 10) || (dialect === "mysql" ? 3306 : 1433),
      database
    };
  } catch {
    return null;
  }
}

/**
 * Ensure database exists (MySQL/SQL Server only)
 */
export async function ensureDatabaseExists(connectionUri: string): Promise<void> {
  if (isSqliteConnectionString(connectionUri)) return;

  const parsed = parseConnectionUri(connectionUri);
  if (!parsed) {
    console.log(`Note: Could not parse connection URI for auto-create database`);
    return;
  }

  const { dialect, username, password, host, port, database } = parsed;
  console.log(`Checking database '${database}' exists on ${dialect}://${host}:${port}...`);

  if (dialect === "mysql") {
    try {
      const mysql = require("mysql2/promise");
      const conn = await mysql.createConnection({
        host,
        port,
        user: username,
        password,
        connectTimeout: 10000
      });
      await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      console.log(`Database '${database}' created or already exists (MySQL)`);
      await conn.end();
    } catch (e: any) {
      console.error(`Failed to auto-create database '${database}': ${e.message}`);
      // Don't throw - let the main connection attempt handle the error
    }
  } else if (dialect === "mssql") {
    try {
      const tedious = require("tedious");
      await new Promise<void>((resolve, reject) => {
        const c = new tedious.Connection({
          server: host,
          authentication: { type: "default", options: { userName: username, password } },
          options: { port, database: "master", encrypt: true, trustServerCertificate: true, connectTimeout: 10000 }
        });
        c.on("connect", (err: Error) => {
          if (err) { reject(err); return; }
          const r = new tedious.Request(
            `IF NOT EXISTS (SELECT name FROM sys.databases WHERE name='${database}') CREATE DATABASE [${database}]`,
            (error: Error) => { c.close(); error ? reject(error) : resolve(); }
          );
          c.execSql(r);
        });
        c.connect();
      });
      console.log(`Database '${database}' created or already exists (SQL Server)`);
    } catch (e: any) {
      console.error(`Failed to auto-create database '${database}': ${e.message}`);
    }
  }
}

export const BEARER_TOKEN_PREFIX = "Bearer";
export const HTTPS = "https";

// Validate issuer
// Only check prefix and bypass AAD tenant ID match
// BlackForest: https://sts.microsoftonline.de/
// Fairfax: https://sts.windows.net/
// Mooncake: https://sts.chinacloudapi.cn/
// Production: https://sts.windows.net/
// Test: https://sts.windows-ppe.net/
export const VALID_ISSUE_PREFIXES = [
  "https://sts.windows.net/",
  "https://sts.microsoftonline.de/",
  "https://sts.chinacloudapi.cn/",
  "https://sts.windows-ppe.net"
];

export const EMULATOR_ACCOUNT_NAME = "devstoreaccount1";
export const EMULATOR_ACCOUNT_KEY = Buffer.from(
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  "base64"
);

export const VALID_CSHARP_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
