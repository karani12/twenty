import { Injectable } from '@nestjs/common';

import { getForeignTableColumnName as convertToForeignTableColumnName } from 'src/engine/metadata-modules/remote-server/remote-table/foreign-table/utils/get-foreign-table-column-name.util';
import { DistantTables } from 'src/engine/metadata-modules/remote-server/remote-table/distant-table/types/distant-table';
import {
  RemoteTableStatus,
  DistantTableUpdate,
} from 'src/engine/metadata-modules/remote-server/remote-table/dtos/remote-table.dto';
import { RemoteTableEntity } from 'src/engine/metadata-modules/remote-server/remote-table/remote-table.entity';
import { fetchTableColumns } from 'src/engine/metadata-modules/remote-server/remote-table/utils/fetch-table-columns.util';
import { PostgresTableSchemaColumn } from 'src/engine/metadata-modules/remote-server/types/postgres-table-schema-column';
import {
  WorkspaceMigrationColumnAction,
  WorkspaceMigrationColumnCreate,
  WorkspaceMigrationColumnActionType,
  WorkspaceMigrationColumnDrop,
} from 'src/engine/metadata-modules/workspace-migration/workspace-migration.entity';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';

@Injectable()
export class RemoteTableSchemaUpdateService {
  constructor(
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
  ) {}

  public async getDistantTablesWithUpdates({
    remoteServerSchema,
    workspaceId,
    remoteTables,
    distantTables,
  }: {
    remoteServerSchema: string;
    workspaceId: string;
    remoteTables: RemoteTableEntity[];
    distantTables: DistantTables;
  }) {
    const schemaPendingUpdates =
      await this.getSchemaUpdatesBetweenForeignAndDistantTables({
        workspaceId,
        remoteTables,
        distantTables,
      });

    const remoteTablesDistantNames = new Set(
      remoteTables.map((remoteTable) => remoteTable.distantTableName),
    );

    const distantTablesWithUpdates = Object.keys(distantTables).map(
      (tableName) => ({
        name: tableName,
        schema: remoteServerSchema,
        status: remoteTablesDistantNames.has(tableName)
          ? RemoteTableStatus.SYNCED
          : RemoteTableStatus.NOT_SYNCED,
        schemaPendingUpdates: schemaPendingUpdates[tableName] || [],
      }),
    );

    const deletedTables = Object.entries(schemaPendingUpdates)
      .filter(([_tableName, updates]) =>
        updates.includes(DistantTableUpdate.TABLE_DELETED),
      )
      .map(([tableName, updates]) => ({
        name: tableName,
        schema: remoteServerSchema,
        status: RemoteTableStatus.SYNCED,
        schemaPendingUpdates: updates,
      }));

    return [...distantTablesWithUpdates, ...deletedTables];
  }

  public computeForeignTableColumnsUpdates = (
    foreignTableColumns: PostgresTableSchemaColumn[],
    distantTableColumns: PostgresTableSchemaColumn[],
  ): WorkspaceMigrationColumnAction[] => {
    const { columnsAdded, columnsDeleted } = this.compareForeignTableColumns(
      foreignTableColumns,
      distantTableColumns,
    );
    const columnsAddedUpdates: WorkspaceMigrationColumnCreate[] =
      columnsAdded.map((columnAdded) => ({
        action: WorkspaceMigrationColumnActionType.CREATE,
        columnName: columnAdded.name,
        columnType: columnAdded.type,
      }));

    const columnsDeletedUpdates: WorkspaceMigrationColumnDrop[] =
      columnsDeleted.map((columnDeleted) => ({
        action: WorkspaceMigrationColumnActionType.DROP,
        columnName: columnDeleted,
      }));

    return [...columnsAddedUpdates, ...columnsDeletedUpdates];
  };

  private async getSchemaUpdatesBetweenForeignAndDistantTables({
    workspaceId,
    remoteTables,
    distantTables,
  }: {
    workspaceId: string;
    remoteTables: RemoteTableEntity[];
    distantTables: DistantTables;
  }): Promise<{ [tablename: string]: DistantTableUpdate[] }> {
    const updates = {};

    for (const remoteTable of remoteTables) {
      const distantTable = distantTables[remoteTable.distantTableName];
      const tableName = remoteTable.distantTableName;

      if (!distantTable) {
        updates[tableName] = [DistantTableUpdate.TABLE_DELETED];
        continue;
      }

      const foreignTable = await fetchTableColumns(
        this.workspaceDataSourceService,
        workspaceId,
        remoteTable.localTableName,
      );

      const { columnsAdded, columnsDeleted } = this.compareForeignTableColumns(
        foreignTable,
        distantTable,
      );

      if (columnsAdded.length > 0) {
        updates[tableName] = [
          ...(updates[tableName] || []),
          DistantTableUpdate.COLUMNS_ADDED,
        ];
      }
      if (columnsDeleted.length > 0) {
        updates[tableName] = [
          ...(updates[tableName] || []),
          DistantTableUpdate.COLUMNS_DELETED,
        ];
      }
    }

    return updates;
  }

  private compareForeignTableColumns = (
    foreignTableColumns: PostgresTableSchemaColumn[],
    distantTableColumns: PostgresTableSchemaColumn[],
  ) => {
    const foreignTableColumnNames = new Set(
      foreignTableColumns.map((column) => column.columnName),
    );
    const distantTableColumnsWithConvertedName = distantTableColumns.map(
      (column) => {
        return {
          name: convertToForeignTableColumnName(column.columnName),
          type: column.dataType,
        };
      },
    );

    const columnsAdded = distantTableColumnsWithConvertedName.filter(
      (column) => !foreignTableColumnNames.has(column.name),
    );
    const columnsDeleted = Array.from(foreignTableColumnNames).filter(
      (columnName) =>
        !distantTableColumnsWithConvertedName
          .map((column) => column.name)
          .includes(columnName),
    );

    return {
      columnsAdded,
      columnsDeleted,
    };
  };
}
