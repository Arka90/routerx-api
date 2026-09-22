import { up as initialSchema } from "./001-initial-schema";
import { up as multiRegion } from "./002-multi-region";
import { up as statusPages } from "./003-status-pages";
import { up as billing } from "./004-billing";

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
  { version: "002-multi-region", sql: multiRegion },
  { version: "003-status-pages", sql: statusPages },
  { version: "004-billing", sql: billing },
];
