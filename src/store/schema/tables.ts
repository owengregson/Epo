/**
 * The table manifest: every column of every table, declared once.
 *
 * `ACCOUNT_COLUMNS` proved the idea on one table — four hand-maintained lists
 * (column list, VALUES list, `ON CONFLICT … SET`, bound parameters) collapsed
 * into one array that a test asserts against `PRAGMA table_info`. This
 * generalises it to all fourteen: the SQL row type, the SQLite⇄domain codec,
 * the upsert fragment, the `CREATE TABLE` for a NEW table, and the boot-time
 * shape assertion are all DERIVED from the same declaration, so they cannot
 * drift out of step with each other or with the database.
 *
 * This file is the ALGEBRA (columns, tables, codecs, generated SQL, the drift
 * check); the tables themselves are declared in `./manifest.ts`.
 *
 * What is deliberately NOT derived: the SQL of a migration that ALTERs an
 * existing table. That is where intent lives, it is append-only (ADR 0502),
 * and generating it would let an edit to a def silently rewrite shipped
 * history. `ddl()` is for new tables only, and a test pins the text of every
 * migration that used it.
 */

import type { SqliteDriver, SqlValue } from '../driver/driver';

export type SqlType = 'TEXT' | 'INTEGER' | 'REAL';

/** The SQLite⇄domain conversion for one column (the `sql-values.ts` rules, typed). */
export interface Codec<S extends SqlValue, D> {
  decode(v: S): D;
  encode(v: D): S;
}

/** One column, fully described. `S` is what SQLite stores, `D` what the domain reads. */
export interface ColumnDef<S extends SqlValue = SqlValue, D = unknown> {
  readonly type: SqlType;
  readonly notNull: boolean;
  /** 0 = not part of the primary key; 1..n = its position in one. */
  readonly pk: number;
  readonly autoincrement: boolean;
  /** The DEFAULT literal exactly as SQLite reports it (`'stub'`, `0`), or null. */
  readonly dflt: string | null;
  readonly codec: Codec<S, D>;
}

const ident = <S extends SqlValue>(): Codec<S, S> => ({
  decode: (v) => v,
  encode: (v) => v,
});

/** `T | null` column ⇄ `T | undefined` domain — SQLite has no `undefined`. */
const optional = <S extends SqlValue>(): Codec<S | null, S | undefined> => ({
  decode: (v) => (v === null ? undefined : v),
  encode: (v) => (v === undefined ? null : v),
});

/** `0`/`1`/`null` column ⇄ `boolean | undefined` domain. */
const boolish: Codec<number | null, boolean | undefined> = {
  decode: (v) => (v === null ? undefined : v !== 0),
  encode: (v) => (v === undefined ? null : v ? 1 : 0),
};

class Col<S extends SqlValue, D> implements ColumnDef<S, D> {
  constructor(
    readonly type: SqlType,
    readonly codec: Codec<S, D>,
    readonly notNull = true,
    readonly pk = 0,
    readonly autoincrement = false,
    readonly dflt: string | null = null,
  ) {}

  private with<S2 extends SqlValue, D2>(
    patch: Partial<ColumnDef<S2, D2>> & { codec: Codec<S2, D2> },
  ): Col<S2, D2> {
    return new Col(
      patch.type ?? this.type,
      patch.codec,
      patch.notNull ?? this.notNull,
      patch.pk ?? this.pk,
      patch.autoincrement ?? this.autoincrement,
      patch.dflt === undefined ? this.dflt : patch.dflt,
    );
  }

  /** Nullable, and `null` is what the domain sees. */
  nullable(): Col<S | null, D | null> {
    return this.with<S | null, D | null>({
      notNull: false,
      codec: {
        decode: (v) => (v === null ? null : this.codec.decode(v as S)),
        encode: (v) => (v === null ? null : this.codec.encode(v as D)),
      },
    });
  }

  /** Nullable, and the domain sees `undefined` for "not observed". */
  opt(): Col<S | null, D | undefined> {
    return this.with<S | null, D | undefined>({
      notNull: false,
      codec: {
        decode: (v) => (v === null ? undefined : this.codec.decode(v as S)),
        encode: (v) => (v === undefined ? null : this.codec.encode(v)),
      },
    });
  }

  /**
   * Part of the primary key at `position`. A SINGLE-column key is declared
   * inline, which is why SQLite reports it as nullable — matching the twelve
   * tables already in the file.
   */
  key(position = 1): Col<S, D> {
    return this.with<S, D>({ pk: position, codec: this.codec });
  }

  /** `INTEGER PRIMARY KEY AUTOINCREMENT` — the ledgers' rowid alias. */
  autoId(): Col<S, D> {
    return this.with<S, D>({ pk: 1, notNull: false, autoincrement: true, codec: this.codec });
  }

  /** A DEFAULT clause, written exactly as it must appear in the DDL. */
  def(literal: string): Col<S, D> {
    return this.with<S, D>({ dflt: literal, codec: this.codec });
  }
}

/** Column constructors. `<T>` narrows the domain type without changing storage. */
export const col = {
  text: <T extends string = string>() => new Col<T, T>('TEXT', ident<T>()),
  int: <T extends number = number>() => new Col<T, T>('INTEGER', ident<T>()),
  real: () => new Col<number, number>('REAL', ident<number>()),
  /** Nullable INTEGER read as `boolean | undefined` (SQLite has no boolean). */
  bool: () => new Col<number | null, boolean | undefined>('INTEGER', boolish, false),
  /** Nullable TEXT read as `string | undefined`. */
  optText: <T extends string = string>() =>
    new Col<T | null, T | undefined>('TEXT', optional<T>(), false),
  /** Nullable INTEGER read as `number | undefined`. */
  optInt: () => new Col<number | null, number | undefined>('INTEGER', optional<number>(), false),
  /** Nullable REAL read as `number | undefined`. */
  optReal: () => new Col<number | null, number | undefined>('REAL', optional<number>(), false),
};

export interface TableDef<C extends Record<string, ColumnDef> = Record<string, ColumnDef>> {
  readonly name: string;
  readonly columns: C;
  /** Column names forming the primary key, in order (empty when there is none). */
  readonly primaryKey: readonly string[];
}

/** Declare a table. The primary key is read off the columns' `key()` positions. */
export const table = <C extends Record<string, ColumnDef>>(name: string, columns: C): TableDef<C> => {
  const primaryKey = Object.keys(columns)
    .filter((k) => columns[k].pk > 0)
    .sort((a, b) => columns[a].pk - columns[b].pk);
  // SQLite quirk, made explicit: a SINGLE-column key is declared inline
  // (`TEXT PRIMARY KEY`) and is therefore NULLABLE — `PRAGMA table_info`
  // reports `notnull = 0` for every such column in this file. A COMPOSITE key
  // is a table constraint over columns that carry their own NOT NULL. Folding
  // the rule in here means the declaration is the truth, so neither `ddl()`
  // nor the drift check has to special-case it.
  const only = primaryKey.length === 1 ? primaryKey[0] : null;
  const normalized =
    only === null
      ? columns
      : ({ ...columns, [only]: { ...columns[only], notNull: false } } as unknown as C);
  return { name, columns: normalized, primaryKey };
};

type SqlOf<C> = C extends ColumnDef<infer S, unknown> ? S : never;
type DomainOf<C> = C extends ColumnDef<SqlValue, infer D> ? D : never;

/** The row shape a `SELECT *` returns — derived, never hand-written. */
export type RowOf<T extends TableDef> = { [K in keyof T['columns']]: SqlOf<T['columns'][K]> };
/** The same row after the codecs run. */
export type ValuesOf<T extends TableDef> = { [K in keyof T['columns']]: DomainOf<T['columns'][K]> };

/** Run every column's `decode` over one raw row. */
export const decodeRow = <T extends TableDef>(t: T, row: RowOf<T>): ValuesOf<T> => {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(t.columns)) {
    out[name] = def.codec.decode((row as Record<string, SqlValue>)[name] as never);
  }
  return out as ValuesOf<T>;
};

/** Run every column's `encode`, producing the bindings for a write. */
export const encodeRow = <T extends TableDef>(
  t: T,
  values: ValuesOf<T>,
): Record<string, SqlValue> => {
  const out: Record<string, SqlValue> = {};
  for (const [name, def] of Object.entries(t.columns)) {
    out[name] = def.codec.encode((values as Record<string, unknown>)[name] as never);
  }
  return out;
};

// --- Generated SQL -------------------------------------------------------------

/**
 * `CREATE TABLE` for a NEW table. Once a migration ships this text it is
 * FROZEN — see the module docstring and the pinning test.
 */
export const ddl = (t: TableDef): string => {
  const inline = t.primaryKey.length === 1;
  const lines = Object.entries(t.columns).map(([name, c]) => {
    const parts = [name, c.type];
    if (inline && c.pk === 1) {
      parts.push('PRIMARY KEY');
      if (c.autoincrement) parts.push('AUTOINCREMENT');
    }
    if (c.notNull) parts.push('NOT NULL');
    if (c.dflt !== null) parts.push(`DEFAULT ${c.dflt}`);
    return `  ${parts.join(' ')}`;
  });
  if (!inline && t.primaryKey.length > 0) {
    lines.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
  }
  return `CREATE TABLE ${t.name} (\n${lines.join(',\n')}\n);`;
};

export interface UpsertSpec {
  /** Columns written, in binding order. Defaults to every column of the table. */
  readonly columns?: readonly string[];
  /** The conflict target — normally the primary key. */
  readonly conflict: readonly string[];
  /** Column → the SET right-hand side, overriding the default `excluded.<col>`. */
  readonly expr?: Readonly<Record<string, string>>;
  /** Extra SET clauses appended verbatim. Policy, not a column mapping. */
  readonly tail?: readonly string[];
}

/**
 * `INSERT … ON CONFLICT … DO UPDATE SET`, generated from the manifest so the
 * four lists that must agree are one list. Bindings are `@column`.
 */
export const upsertSql = (t: TableDef, spec: UpsertSpec): string => {
  const names = spec.columns ?? Object.keys(t.columns);
  const unknown = names.filter((n) => !(n in t.columns));
  if (unknown.length > 0) {
    throw new Error(`store: upsertSql(${t.name}) names columns not in the manifest: ${unknown}`);
  }
  const sets = names
    .filter((n) => !spec.conflict.includes(n))
    .map((n) => `${n} = ${spec.expr?.[n] ?? `excluded.${n}`}`)
    .concat(spec.tail ?? []);
  return (
    `INSERT INTO ${t.name} (${names.join(', ')})\n` +
    `VALUES (${names.map((n) => `@${n}`).join(', ')})\n` +
    `ON CONFLICT(${spec.conflict.join(', ')}) DO UPDATE SET\n  ${sets.join(',\n  ')}`
  );
};

// --- The boot-time shape assertion ---------------------------------------------

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** One way a live table disagrees with its declaration. */
export interface SchemaDrift {
  table: string;
  column: string;
  field: 'presence' | 'type' | 'notnull' | 'default' | 'pk';
  expected: string;
  got: string;
}

/** Compare one table against `PRAGMA table_info`. Returns every disagreement. */
export const driftOf = (db: SqliteDriver, t: TableDef): SchemaDrift[] => {
  // A table name cannot be a bound parameter; these are internal literals.
  const live = db.prepare(`PRAGMA table_info(${t.name})`).all<TableInfoRow>();
  const drift: SchemaDrift[] = [];
  const seen = new Set(live.map((c) => c.name));
  for (const name of Object.keys(t.columns)) {
    if (!seen.has(name)) {
      drift.push({ table: t.name, column: name, field: 'presence', expected: 'present', got: 'absent' });
    }
  }
  for (const c of live) {
    const def = t.columns[c.name];
    if (def === undefined) {
      drift.push({ table: t.name, column: c.name, field: 'presence', expected: 'absent', got: 'present' });
      continue;
    }
    const check = (field: SchemaDrift['field'], expected: string, got: string): void => {
      if (expected !== got) drift.push({ table: t.name, column: c.name, field, expected, got });
    };
    check('type', def.type, c.type.toUpperCase());
    check('notnull', String(def.notNull ? 1 : 0), String(c.notnull));
    check('default', String(def.dflt), String(c.dflt_value));
    check('pk', String(def.pk), String(c.pk));
  }
  return drift;
};
