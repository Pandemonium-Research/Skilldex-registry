import { createClient, type Client } from "@libsql/client/web";

let client: Client | null = null;

/**
 * The libSQL/Turso connection.
 *
 * Uses the `/web` entrypoint deliberately: it speaks HTTP rather than holding a socket, so
 * there is no connection pool to exhaust from serverless functions. This is the one place
 * where the move off Postgres is a straight win for this deployment.
 */
export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
      throw new Error("Missing TURSO_DATABASE_URL environment variable");
    }

    client = createClient({ url, authToken });
  }

  return client;
}

/** Tests replace the client with one pointed at a scratch file. */
export function __setDbForTesting(c: Client | null): void {
  client = c;
}
