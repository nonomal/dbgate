import _ from 'lodash';
import { GridConfig, GridCache, GridConfigColumns, createGridCache, GroupFunc, createGridConfig } from './GridConfig';
import {
  ForeignKeyInfo,
  TableInfo,
  ColumnInfo,
  EngineDriver,
  NamedObjectInfo,
  DatabaseInfo,
  CollectionInfo,
  SqlDialect,
  ViewInfo,
} from 'dbgate-types';
import { parseFilter, getFilterType } from 'dbgate-filterparser';
import { filterName } from 'dbgate-tools';
import { ChangeSetFieldDefinition, ChangeSetRowDefinition } from './ChangeSet';
import { Expression, Select, treeToSql, dumpSqlSelect, Condition } from 'dbgate-sqltree';
import { isTypeLogical } from 'dbgate-tools';

export interface DisplayColumn {
  schemaName: string;
  pureName: string;
  columnName: string;
  headerText: string;
  uniqueName: string;
  uniquePath: string[];
  notNull: boolean;
  autoIncrement?: boolean;
  isPrimaryKey?: boolean;
  foreignKey?: ForeignKeyInfo;
  isForeignKeyUnique?: boolean;
  isExpandable?: boolean;
  isChecked?: boolean;
  hintColumnNames?: string[];
  dataType?: string;
  filterType?: boolean;
  isStructured?: boolean;
}

export interface DisplayedColumnEx extends DisplayColumn {
  sourceAlias: string;
}

export interface DisplayedColumnInfo {
  [uniqueName: string]: DisplayedColumnEx;
}

// export type ReferenceActionResult = 'noAction' | 'loadRequired' | 'refAdded';

// export function combineReferenceActions(a: ReferenceActionResult, b: ReferenceActionResult): ReferenceActionResult {
//   if (a == 'loadRequired' || b == 'loadRequired') return 'loadRequired';
//   if (a == 'refAdded' || b == 'refAdded') return 'refAdded';
//   return 'noAction';
// }

export type ChangeCacheFunc = (changeFunc: (cache: GridCache) => GridCache) => void;
export type ChangeConfigFunc = (changeFunc: (config: GridConfig) => GridConfig) => void;

export abstract class GridDisplay {
  constructor(
    public config: GridConfig,
    protected setConfig: ChangeConfigFunc,
    public cache: GridCache,
    protected setCache: ChangeCacheFunc,
    public driver?: EngineDriver,
    public dbinfo: DatabaseInfo = null,
    public serverVersion = null
  ) {
    this.dialect = (driver?.dialectByVersion && driver?.dialectByVersion(serverVersion)) || driver?.dialect;
  }
  dialect: SqlDialect;
  columns: DisplayColumn[];
  baseTable?: TableInfo;
  baseView?: ViewInfo;
  baseCollection?: CollectionInfo;
  get baseTableOrSimilar(): NamedObjectInfo {
    return this.baseTable || this.baseCollection || this.baseView;
  }
  get baseTableOrCollection(): NamedObjectInfo {
    return this.baseTable || this.baseCollection;
  }
  get baseTableOrView(): TableInfo | ViewInfo {
    return this.baseTable || this.baseView;
  }
  changeSetKeyFields: string[] = null;
  sortable = false;
  groupable = false;
  filterable = false;
  editable = false;
  isLoadedCorrectly = true;
  supportsReload = false;
  isDynamicStructure = false;
  filterTypeOverride = null;

  setColumnVisibility(uniquePath: string[], isVisible: boolean) {
    const uniqueName = uniquePath.join('.');
    if (uniquePath.length == 1) {
      this.includeInColumnSet('hiddenColumns', uniqueName, !isVisible);
    } else {
      this.includeInColumnSet('addedColumns', uniqueName, isVisible);
      if (!this.isDynamicStructure) this.reload();
    }
  }

  addDynamicColumn(name: string) {
    this.includeInColumnSet('addedColumns', name, true);
  }

  focusColumns(uniqueNames: string[]) {
    this.setConfig(cfg => ({
      ...cfg,
      focusedColumns: uniqueNames,
    }));
  }

  get hasReferences() {
    return false;
  }

  get focusedColumns() {
    return this.config.focusedColumns;
  }

  get engine() {
    return this.driver?.engine;
  }

  get allColumns() {
    return this.getColumns(null).filter(col => col.isChecked || col.uniquePath.length == 1);
  }

  findColumn(uniqueName: string) {
    return this.getColumns(null).find(x => x.uniqueName == uniqueName);
  }

  getFkTarget(column: DisplayColumn): TableInfo {
    return null;
  }

  reload() {
    this.setCache(reloadDataCacheFunc);
  }

  includeInColumnSet(field: keyof GridConfigColumns, uniqueName: string, isIncluded: boolean) {
    // console.log('includeInColumnSet', field, uniqueName, isIncluded);
    if (isIncluded) {
      this.setConfig(cfg => ({
        ...cfg,
        [field]: [...(cfg[field] || []), uniqueName],
      }));
    } else {
      this.setConfig(cfg => ({
        ...cfg,
        [field]: (cfg[field] || []).filter(x => x != uniqueName),
      }));
    }
  }

  showAllColumns() {
    this.setConfig(cfg => ({
      ...cfg,
      hiddenColumns: [],
    }));
  }

  hideAllColumns() {
    this.setConfig(cfg => ({
      ...cfg,
      hiddenColumns: this.columns.filter(x => x.uniquePath.length == 1).map(x => x.uniqueName),
    }));
  }

  get hiddenColumnIndexes() {
    // console.log('GridDisplay.hiddenColumn', this.config.hiddenColumns);
    return (this.config.hiddenColumns || []).map(x => _.findIndex(this.allColumns, y => y.uniqueName == x));
  }

  isColumnChecked(column: DisplayColumn) {
    // console.log('isColumnChecked', column, this.config.hiddenColumns);
    return column.uniquePath.length == 1
      ? !this.config.hiddenColumns.includes(column.uniqueName)
      : this.config.addedColumns.includes(column.uniqueName);
  }

  applyFilterOnSelect(select: Select, displayedColumnInfo: DisplayedColumnInfo) {
    const conditions = [];
    for (const uniqueName in this.config.filters) {
      const filter = this.config.filters[uniqueName];
      if (!filter) continue;
      const column = displayedColumnInfo[uniqueName];
      if (!column) continue;
      try {
        const condition = parseFilter(filter, getFilterType(column.dataType));
        if (condition) {
          conditions.push(
            _.cloneDeepWith(condition, (expr: Expression) => {
              if (expr.exprType == 'placeholder') {
                return this.createColumnExpression(column, { alias: column.sourceAlias });
              }
              // return {
              //   exprType: 'column',
              //   columnName: column.columnName,
              //   source: { alias: column.sourceAlias },
              // };
            })
          );
        }
      } catch (err) {
        console.warn(err.message);
        continue;
      }
    }

    if (conditions.length > 0) {
      select.where = {
        conditionType: 'and',
        conditions,
      };
    }
  }

  applySortOnSelect(select: Select, displayedColumnInfo: DisplayedColumnInfo) {
    if (this.config.sort?.length > 0) {
      select.orderBy = this.config.sort
        .map(col => ({ ...col, dispInfo: displayedColumnInfo[col.uniqueName] }))
        .map(col => ({ ...col, expr: select.columns.find(x => x.alias == col.uniqueName) }))
        .filter(col => col.dispInfo && col.expr)
        .map(col => ({
          ...col.expr,
          direction: col.order,
        }));
    }
  }

  get isGrouped() {
    return !_.isEmpty(this.config.grouping);
  }

  get groupColumns() {
    return this.isGrouped ? _.keys(_.pickBy(this.config.grouping, v => v == 'GROUP' || v.startsWith('GROUP:'))) : null;
  }

  applyGroupOnSelect(select: Select, displayedColumnInfo: DisplayedColumnInfo) {
    const groupColumns = this.groupColumns;
    if (groupColumns && groupColumns.length > 0) {
      // @ts-ignore
      select.groupBy = groupColumns.map(col => {
        const colExpr: Expression = {
          exprType: 'column',
          columnName: displayedColumnInfo[col].columnName,
          source: { alias: displayedColumnInfo[col].sourceAlias },
        };
        const grouping = this.config.grouping[col];
        if (grouping.startsWith('GROUP:')) {
          return {
            exprType: 'transform',
            transform: grouping,
            expr: colExpr,
          };
        } else {
          return colExpr;
        }
      });
    }
    if (!_.isEmpty(this.config.grouping)) {
      for (let i = 0; i < select.columns.length; i++) {
        const uniqueName = select.columns[i].alias;
        // if (groupColumns && groupColumns.includes(uniqueName)) continue;
        const grouping = this.getGrouping(uniqueName);
        if (grouping == 'GROUP') {
          continue;
        } else if (grouping == 'NULL') {
          select.columns[i].alias = null;
        } else if (grouping && grouping.startsWith('GROUP:')) {
          select.columns[i] = {
            exprType: 'transform',
            transform: grouping as any,
            expr: select.columns[i],
            alias: select.columns[i].alias,
          };
        } else {
          let func = 'MAX';
          let argsPrefix = '';
          if (grouping) {
            if (grouping == 'COUNT DISTINCT') {
              func = 'COUNT';
              argsPrefix = 'DISTINCT ';
            } else {
              func = grouping;
            }
          }
          select.columns[i] = {
            alias: select.columns[i].alias,
            exprType: 'call',
            func,
            argsPrefix,
            args: [select.columns[i]],
          };
        }
      }
      select.columns = select.columns.filter(x => x.alias);
    }
  }

  getColumns(columnFilter) {
    return this.columns.filter(col => filterName(columnFilter, col.columnName));
  }

  getGridColumns() {
    return this.getColumns(null).filter(x => this.isColumnChecked(x));
  }

  isExpandedColumn(uniqueName: string) {
    return this.config.expandedColumns.includes(uniqueName);
  }

  toggleExpandedColumn(uniqueName: string, value?: boolean) {
    this.includeInColumnSet('expandedColumns', uniqueName, value == null ? !this.isExpandedColumn(uniqueName) : value);
  }

  getFilter(uniqueName: string) {
    return this.config.filters[uniqueName];
  }

  setFilter(uniqueName, value) {
    this.setConfig(cfg => ({
      ...cfg,
      filters: {
        ...cfg.filters,
        [uniqueName]: value,
      },
    }));
    this.reload();
  }

  showFilter(uniqueName) {
    this.setConfig(cfg => {
      if (!cfg.filters.uniqueName)
        return {
          ...cfg,
          filters: {
            ..._.omitBy(cfg.filters, v => !v),
            [uniqueName]: '',
          },
        };
      return cfg;
    });
  }

  removeFilter(uniqueName) {
    this.setConfig(cfg => ({
      ...cfg,
      filters: _.omit(cfg.filters, [uniqueName]),
    }));
    this.reload();
  }

  setFilters(dct) {
    this.setConfig(cfg => ({
      ...cfg,
      filters: {
        ...cfg.filters,
        ...dct,
      },
    }));
    this.reload();
  }

  setSort(uniqueName, order) {
    this.setConfig(cfg => ({
      ...cfg,
      sort: [{ uniqueName, order }],
    }));
    this.reload();
  }

  addToSort(uniqueName, order) {
    this.setConfig(cfg => ({
      ...cfg,
      sort: [...(cfg.sort || []), { uniqueName, order }],
    }));
    this.reload();
  }

  clearSort() {
    this.setConfig(cfg => ({
      ...cfg,
      sort: [],
    }));
    this.reload();
  }

  setGrouping(uniqueName, groupFunc: GroupFunc) {
    this.setConfig(cfg => ({
      ...cfg,
      grouping: groupFunc
        ? {
            ...cfg.grouping,
            [uniqueName]: groupFunc,
          }
        : _.omitBy(cfg.grouping, (v, k) => k == uniqueName),
    }));
    this.reload();
  }

  getGrouping(uniqueName): GroupFunc {
    if (this.isGrouped) {
      if (this.config.grouping[uniqueName]) return this.config.grouping[uniqueName];
      const column = (this.baseTable || this.baseView)?.columns?.find(x => x.columnName == uniqueName);
      if (isTypeLogical(column?.dataType)) return 'COUNT DISTINCT';
      if (column?.autoIncrement) return 'COUNT';
      return 'MAX';
    }
    return null;
  }

  clearGrouping() {
    this.setConfig(cfg => ({
      ...cfg,
      grouping: {},
    }));
    this.reload();
  }

  getSortOrder(uniqueName) {
    return this.config.sort.find(x => x.uniqueName == uniqueName)?.order;
  }

  getSortOrderIndex(uniqueName) {
    if (this.config.sort.length <= 1) return -1;
    return _.findIndex(this.config.sort, x => x.uniqueName == uniqueName);
  }

  isSortDefined() {
    return (this.config.sort || []).length > 0;
  }

  get filterCount() {
    return _.compact(_.values(this.config.filters)).length;
  }

  clearFilters() {
    this.setConfig(cfg => ({
      ...cfg,
      filters: {},
    }));
    this.reload();
  }

  resetConfig() {
    this.setConfig(cfg => createGridConfig());
    this.reload();
  }

  getChangeSetCondition(row) {
    if (!this.changeSetKeyFields) return null;
    return _.pick(row, this.changeSetKeyFields);
  }

  getChangeSetField(row, uniqueName, insertedRowIndex): ChangeSetFieldDefinition {
    const col = this.columns.find(x => x.uniqueName == uniqueName);
    if (!col) return null;
    const baseObj = this.baseTableOrSimilar;
    if (!baseObj) return null;
    if (baseObj.pureName != col.pureName || baseObj.schemaName != col.schemaName) {
      return null;
    }

    return {
      ...this.getChangeSetRow(row, insertedRowIndex),
      uniqueName: uniqueName,
      columnName: col.columnName,
    };
  }

  getChangeSetRow(row, insertedRowIndex): ChangeSetRowDefinition {
    const baseObj = this.baseTableOrSimilar;
    if (!baseObj) return null;
    return {
      pureName: baseObj.pureName,
      schemaName: baseObj.schemaName,
      insertedRowIndex,
      condition: insertedRowIndex == null ? this.getChangeSetCondition(row) : null,
    };
  }

  createSelect(options = {}): Select {
    return null;
  }

  processReferences(select: Select, displayedColumnInfo: DisplayedColumnInfo, options) {}

  createColumnExpression(col, source, alias?) {
    let expr = null;
    if (this.dialect.createColumnViewExpression) {
      expr = this.dialect.createColumnViewExpression(col.columnName, col.dataType, source, alias);
      if (expr) {
        return expr;
      }
    }
    return {
      exprType: 'column',
      alias: alias || col.columnName,
      source,
      ...col,
    };
  }

  createSelectBase(name: NamedObjectInfo, columns: ColumnInfo[], options) {
    if (!columns) return null;
    const orderColumnName = columns[0].columnName;
    const select: Select = {
      commandType: 'select',
      from: {
        name: _.pick(name, ['schemaName', 'pureName']),
        alias: 'basetbl',
      },
      columns: columns.map(col => this.createColumnExpression(col, { alias: 'basetbl' })),
      orderBy: [
        {
          exprType: 'column',
          columnName: orderColumnName,
          direction: 'ASC',
        },
      ],
    };
    const displayedColumnInfo = _.keyBy(
      this.columns.map(col => ({ ...col, sourceAlias: 'basetbl' })),
      'uniqueName'
    );
    this.processReferences(select, displayedColumnInfo, options);
    this.applyFilterOnSelect(select, displayedColumnInfo);
    this.applyGroupOnSelect(select, displayedColumnInfo);
    this.applySortOnSelect(select, displayedColumnInfo);
    return select;
  }

  getRowNumberOverSelect(select: Select, offset: number, count: number): Select {
    const innerSelect: Select = {
      commandType: 'select',
      from: select.from,
      where: select.where,
      columns: [
        ...select.columns,
        {
          alias: '_rowNumber',
          exprType: 'rowNumber',
          orderBy: select.orderBy
            ? select.orderBy.map(x =>
                x.exprType != 'column'
                  ? x
                  : x.source
                  ? x
                  : {
                      ...x,
                      source: { alias: 'basetbl' },
                    }
              )
            : [
                {
                  ...select.columns[0],
                  direction: 'ASC',
                },
              ],
        },
      ],
    };

    const res: Select = {
      commandType: 'select',
      selectAll: true,
      from: {
        subQuery: innerSelect,
        alias: '_RowNumberResult',
      },
      where: {
        conditionType: 'between',
        expr: {
          exprType: 'column',
          columnName: '_RowNumber',
          source: {
            alias: '_RowNumberResult',
          },
        },
        left: {
          exprType: 'value',
          value: offset + 1,
        },
        right: {
          exprType: 'value',
          value: offset + count,
        },
      },
    };

    return res;
  }

  getPageQuery(offset: number, count: number) {
    if (!this.driver) return null;
    let select = this.createSelect();
    if (!select) return null;
    if (this.dialect.rangeSelect) select.range = { offset: offset, limit: count };
    else if (this.dialect.rowNumberOverPaging && offset > 0)
      select = this.getRowNumberOverSelect(select, offset, count);
    else if (this.dialect.limitSelect) select.topRecords = count;
    return select;
    // const sql = treeToSql(this.driver, select, dumpSqlSelect);
    // return sql;
  }

  getExportQuery(postprocessSelect = null) {
    const select = this.createSelect({ isExport: true });
    if (!select) return null;
    if (postprocessSelect) postprocessSelect(select);
    const sql = treeToSql(this.driver, select, dumpSqlSelect);
    return sql;
  }

  getExportQueryJson(postprocessSelect = null) {
    const select = this.createSelect({ isExport: true });
    if (!select) return null;
    if (postprocessSelect) postprocessSelect(select);
    return select;
  }

  getExportColumnMap() {
    const changesDefined = this.config.hiddenColumns?.length > 0 || this.config.addedColumns?.length > 0;
    if (this.isDynamicStructure && !changesDefined) {
      return null;
    }
    return this.getColumns(null)
      .filter(col => col.isChecked)
      .map(col => ({
        dst: col.uniqueName,
        src: col.uniqueName,
        ignore: !changesDefined,
      }));
  }

  resizeColumn(uniqueName: string, computedSize: number, diff: number) {
    this.setConfig(cfg => {
      const columnWidths = {
        ...cfg.columnWidths,
      };
      if (columnWidths[uniqueName]) {
        columnWidths[uniqueName] += diff;
      } else {
        columnWidths[uniqueName] = computedSize + diff;
      }
      return {
        ...cfg,
        columnWidths,
      };
    });
  }

  getCountQuery() {
    let select = this.createSelect();
    select.orderBy = null;

    if (this.isGrouped) {
      select = {
        commandType: 'select',
        from: {
          subQuery: select,
          alias: 'subq',
        },
        columns: [
          {
            exprType: 'raw',
            sql: 'COUNT(*)',
            alias: 'count',
          },
        ],
      };
    } else {
      select.columns = [
        {
          exprType: 'raw',
          sql: 'COUNT(*)',
          alias: 'count',
        },
      ];
    }
    return select;
    // const sql = treeToSql(this.driver, select, dumpSqlSelect);
    // return sql;
  }

  compileFilters(): Condition {
    const filters = this.config && this.config.filters;
    if (!filters) return null;
    const conditions = [];
    for (const name in filters) {
      const column = this.isDynamicStructure ? null : this.columns.find(x => x.columnName == name);
      if (!this.isDynamicStructure && !column) continue;
      const filterType =
        this.filterTypeOverride ?? (this.isDynamicStructure ? 'mongo' : getFilterType(column.dataType));
      try {
        const condition = parseFilter(filters[name], filterType);
        const replaced = _.cloneDeepWith(condition, (expr: Expression) => {
          if (expr.exprType == 'placeholder')
            return {
              exprType: 'column',
              columnName: this.isDynamicStructure ? name : column.columnName,
            };
        });
        conditions.push(replaced);
      } catch (err) {
        // filter parse error - ignore filter
      }
    }
    if (conditions.length == 0) return null;
    return {
      conditionType: 'and',
      conditions,
    };
  }

  switchToFormView(rowData) {
    if (!this.baseTable) return;
    const { primaryKey } = this.baseTable;
    if (!primaryKey) return;
    const { columns } = primaryKey;

    this.setConfig(cfg => ({
      ...cfg,
      isFormView: true,
      formViewKey: rowData
        ? _.pick(
            rowData,
            columns.map(x => x.columnName)
          )
        : null,
      formViewKeyRequested: null,
    }));
  }

  switchToJsonView() {
    this.setConfig(cfg => ({
      ...cfg,
      isJsonView: true,
    }));
  }
}

export function reloadDataCacheFunc(cache: GridCache): GridCache {
  return {
    // ...cache,
    ...createGridCache(),
    refreshTime: new Date().getTime(),
  };
}
