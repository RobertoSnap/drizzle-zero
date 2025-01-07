import {
  createTableRelationsHelpers,
  getTableName,
  is,
  Many,
  One,
  Relations,
  Table,
} from "drizzle-orm";
import { getTableConfigForDatabase } from "./db";
import { createZeroTableSchema, type CreateZeroTableSchema } from "./tables";
import type {
  AtLeastOne,
  ColumnName,
  Columns,
  ColumnsConfig,
  FindPrimaryKeyFromTable,
  Flatten,
  TableName,
  ZeroColumns,
} from "./types";
import { typedEntries } from "./util";

type ZeroSchemaWithRelations<
  T extends Table<any>,
  C extends ColumnsConfig<T>,
  R extends Record<string, unknown> | never,
> = Readonly<
  CreateZeroTableSchema<T, C> &
    (keyof R extends never
      ? {}
      : [R] extends [never]
        ? {}
        : {
            readonly relationships: R;
          })
>;

type FindRelationsForTable<
  TSchema extends Record<string, unknown>,
  TableName extends string,
> = Extract<
  TSchema[{
    [P in keyof TSchema]: TSchema[P] extends Relations<TableName> ? P : never;
  }[keyof TSchema]],
  Relations<TableName>
>;

type TableColumnsConfig<TSchema extends Record<string, unknown>> = {
  readonly [K in keyof TSchema as TSchema[K] extends Table<any>
    ? TableName<TSchema[K]>
    : never]?: TSchema[K] extends Table<any>
    ? ColumnsConfig<TSchema[K]>
    : never;
};

type RelationsConfig<T extends Relations> = ReturnType<T["config"]>;

type ColumnIndexKeys<T extends Table> = {
  [K in keyof Columns<T>]: Columns<T>[K] extends {
    dataType: "string" | "number";
  }
    ? ColumnName<Columns<T>[K]>
    : never;
}[keyof Columns<T>];

type ReferencedZeroSchemas<
  TSchema extends Record<string, unknown>,
  TColumns extends TableColumnsConfig<TSchema>,
  TRelations extends Relations,
  TTableName extends keyof TSchema,
> = TRelations extends never
  ? never
  : {
      readonly [K in keyof RelationsConfig<TRelations> as {
        readonly [P in keyof TSchema]: TSchema[P] extends {
          _: {
            name: RelationsConfig<TRelations>[K]["referencedTableName"];
          };
        }
          ? TSchema[P] extends Table<any>
            ? TColumns[TableName<TSchema[P]>] extends object
              ? K
              : never
            : never
          : never;
      }[keyof TSchema] extends never
        ? never
        : K]: {
        readonly [P in keyof TSchema]: TSchema[P] extends {
          _: {
            name: RelationsConfig<TRelations>[K]["referencedTableName"];
          };
        }
          ? TSchema[P] extends Table<any>
            ? TColumns[TableName<TSchema[P]>] extends object
              ? {
                  readonly sourceField: AtLeastOne<
                    Readonly<
                      {
                        [P in keyof TSchema]: TSchema[P] extends {
                          _: {
                            name: TTableName;
                          };
                        }
                          ? TSchema[P] extends Table<any>
                            ? ColumnIndexKeys<TSchema[P]>
                            : never
                          : never;
                      }[keyof TSchema]
                    >
                  >;
                  readonly destField: AtLeastOne<
                    Readonly<
                      {
                        [ColumnName in keyof Columns<TSchema[P]>]: Columns<
                          TSchema[P]
                        >[ColumnName]["_"] extends {
                          name: string;
                        }
                          ? ColumnIndexKeys<TSchema[P]>
                          : never;
                      }[keyof Columns<TSchema[P]>]
                    >
                  >;
                  readonly destSchema: () => ZeroSchemaWithRelations<
                    TSchema[P],
                    TColumns[TableName<TSchema[P]>],
                    ReferencedZeroSchemas<
                      TSchema,
                      TColumns,
                      FindRelationsForTable<TSchema, TableName<TSchema[P]>>,
                      TableName<TSchema[P]>
                    >
                  >;
                }
              : never
            : never
          : never;
      }[keyof TSchema];
    };

type CreateZeroSchema<
  TVersion extends number,
  TSchema extends Record<string, unknown>,
  TColumns extends TableColumnsConfig<TSchema>,
> = {
  readonly version: TVersion;
  readonly tables: {
    readonly [K in keyof TSchema as TSchema[K] extends Table<any>
      ? TColumns[TableName<TSchema[K]>] extends object
        ? TableName<TSchema[K]>
        : never
      : never]: TSchema[K] extends Table<any>
      ? ZeroSchemaWithRelations<
          TSchema[K],
          TColumns[TableName<TSchema[K]>],
          ReferencedZeroSchemas<
            TSchema,
            TColumns,
            FindRelationsForTable<TSchema, TableName<TSchema[K]>>,
            TableName<TSchema[K]>
          >
        >
      : never;
  };
};

const createZeroSchema = <
  const TVersion extends number,
  const TSchema extends Record<string, unknown>,
  const TColumns extends
    TableColumnsConfig<TSchema> = TableColumnsConfig<TSchema>,
>(
  schema: TSchema,
  schemaConfig: {
    readonly version: TVersion;
    readonly tables: TColumns;
  },
): Flatten<CreateZeroSchema<TVersion, TSchema, TColumns>> => {
  let relationships = {} as Record<
    keyof typeof schemaConfig.tables,
    Record<string, unknown>
  >;

  for (const tableOrRelations of Object.values(schema)) {
    if (is(tableOrRelations, Relations)) {
      const tableName = getTableName(tableOrRelations.table);
      const relationsConfig = getRelationsConfig(tableOrRelations);

      Object.values(relationsConfig).forEach((relation) => {
        let sourceFieldNames: string[] = [];
        let destFieldNames: string[] = [];

        if (is(relation, One)) {
          sourceFieldNames =
            relation?.config?.fields?.map((f) => f?.name) ?? [];
          destFieldNames =
            relation?.config?.references?.map((f) => f?.name) ?? [];
        }

        if (!sourceFieldNames.length || !destFieldNames.length) {
          if (relation.relationName) {
            const sourceAndDestFields = findNamedSourceAndDestFields(
              schema,
              relation,
            );

            sourceFieldNames = sourceAndDestFields.sourceFieldNames;
            destFieldNames = sourceAndDestFields.destFieldNames;
          } else {
            const sourceAndDestFields = findForeignKeySourceAndDestFields(
              schema,
              relation,
            );

            sourceFieldNames = sourceAndDestFields.sourceFieldNames;
            destFieldNames = sourceAndDestFields.destFieldNames;
          }
        }

        if (!sourceFieldNames.length || !destFieldNames.length) {
          throw new Error(
            `No relationship found for: ${relation.fieldName} (${is(relation, One) ? "One" : "Many"} from ${tableName} to ${relation.referencedTableName}). Did you forget to define foreign keys${relation.relationName ? ` for named relation "${relation.relationName}"` : ""}?`,
          );
        }

        relationships[tableName as keyof typeof relationships] = {
          ...(relationships?.[tableName as keyof typeof relationships] ?? {}),
          [relation.fieldName]: {
            sourceField: sourceFieldNames,
            destField: destFieldNames,
            destSchemaTableName: relation.referencedTableName,
          },
        } as unknown as (typeof relationships)[keyof typeof relationships];
      });
    }
  }

  let tablesWithoutDestSchema: Record<
    string,
    {
      tableName: string;
      columns: ZeroColumns<Table, ColumnsConfig<Table>>;
      primaryKey: FindPrimaryKeyFromTable<Table>;
      relationships?: Record<
        string,
        {
          sourceField: string;
          destField: string;
          destSchemaTableName: string;
        }
      >;
    }
  > = {};

  for (const tableOrRelations of Object.values(schema)) {
    if (is(tableOrRelations, Table)) {
      const table = tableOrRelations;

      const tableName = getTableName(table);

      const tableConfig = schemaConfig.tables[tableName as keyof TColumns];

      // skip tables that don't have a config
      if (!tableConfig) {
        continue;
      }

      const tableSchema = createZeroTableSchema(table, tableConfig);

      const relations = relationships[tableName as keyof typeof relationships];

      tablesWithoutDestSchema[
        tableName as keyof typeof tablesWithoutDestSchema
      ] = {
        ...tableSchema,
        ...(relations ? { relationships: relations } : {}),
      } as unknown as (typeof tablesWithoutDestSchema)[keyof typeof tablesWithoutDestSchema];
    }
  }

  let tables: Record<string, unknown> = {};

  for (const tableWithoutDestSchema of Object.values(tablesWithoutDestSchema)) {
    const tableName = tableWithoutDestSchema.tableName;

    const relationships = typedEntries(
      tableWithoutDestSchema.relationships ?? {},
    )
      // filter out relationships that don't have a corresponding table
      .filter(([_key, relationship]) =>
        Boolean(tablesWithoutDestSchema[relationship.destSchemaTableName]),
      )
      .reduce(
        (acc, [key, relationship]) => {
          acc[key] = {
            sourceField: relationship.sourceField,
            destField: relationship.destField,
            destSchema: () => tables[relationship.destSchemaTableName],
          };

          return acc;
        },
        {} as Record<string, unknown>,
      );

    tables[tableName as keyof typeof tables] = {
      tableName: tableWithoutDestSchema.tableName,
      columns: tableWithoutDestSchema.columns,
      primaryKey: tableWithoutDestSchema.primaryKey,
      ...(Object.keys(relationships).length ? { relationships } : {}),
    } as unknown as (typeof tables)[keyof typeof tables];
  }

  return {
    version: schemaConfig.version,
    tables,
  } as CreateZeroSchema<TVersion, TSchema, TColumns>;
};

const findForeignKeySourceAndDestFields = (
  schema: Record<string, unknown>,
  relation: One | Many<any>,
) => {
  for (const tableOrRelations of Object.values(schema)) {
    if (is(tableOrRelations, Table)) {
      const tableName = getTableName(tableOrRelations);

      if (tableName === relation.referencedTableName) {
        const tableConfig = getTableConfigForDatabase(tableOrRelations);

        for (const foreignKey of tableConfig.foreignKeys) {
          const reference = foreignKey.reference();

          const foreignTableName = getTableName(reference.foreignTable);
          const sourceTableName = getTableName(relation.sourceTable);

          if (foreignTableName === sourceTableName) {
            return {
              sourceFieldNames: reference.foreignColumns.map((c) => c.name),
              destFieldNames: reference.columns.map((c) => c.name),
            };
          }
        }
      }
    }
  }

  return {
    sourceFieldNames: [],
    destFieldNames: [],
  };
};

const findNamedSourceAndDestFields = (
  schema: Record<string, unknown>,
  relation: One | Many<any>,
) => {
  for (const tableOrRelations of Object.values(schema)) {
    if (is(tableOrRelations, Relations)) {
      const relationsConfig = getRelationsConfig(tableOrRelations);

      for (const relationConfig of Object.values(relationsConfig)) {
        if (
          is(relationConfig, One) &&
          relationConfig.relationName === relation.relationName
        ) {
          return {
            destFieldNames:
              relationConfig.config?.fields?.map((f) => f.name) ?? [],
            sourceFieldNames:
              relationConfig.config?.references?.map((f) => f.name) ?? [],
          };
        }
      }
    }
  }

  return {
    sourceFieldNames: [],
    destFieldNames: [],
  };
};

const getRelationsConfig = (relations: Relations) => {
  return relations.config(
    createTableRelationsHelpers(relations.table),
  ) as Record<string, One | Many<any>>;
};

export { createZeroSchema, type CreateZeroSchema };
