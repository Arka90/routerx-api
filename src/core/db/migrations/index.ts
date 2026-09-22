import { up as initialSchema } from "./001-initial-schema";

export interface Migration {
  version: string;
  sql: string;
}

/**
 * Applied in array order, exactly once each, recorded in schema_migrations.
 * Never edit a migration that has shipped — add a new one.
 */
export const migrations: Migration[] = [
  { version: "001-initial-schema", sql: initialSchema },
];
