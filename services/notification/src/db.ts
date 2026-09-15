import mysql from "mysql2/promise";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export const pool = mysql.createPool({
  host: requireEnv("DB_HOST"),
  port: Number(process.env.DB_PORT ?? 3306),
  database: requireEnv("DB_NAME"),
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASSWORD"),
  ...(process.env.DB_SSL === "true" ? { ssl: {} } : {}),
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 10),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
  timezone: "Z",
});
