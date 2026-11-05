export interface Migration {
  /** The `user_version` this migration upgrades FROM. */
  id: number;
  /** Short label, logged when the migration applies. */
  name: string;
  sql: string;
}
