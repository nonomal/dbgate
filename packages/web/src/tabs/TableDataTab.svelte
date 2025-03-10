<script lang="ts" context="module">
  const getCurrentEditor = () => getActiveComponent('TableDataTab');
  const INTERVALS = [5, 10, 15, 13, 60];

  registerCommand({
    id: 'tableData.save',
    group: 'save',
    category: 'Table data',
    name: 'Save',
    // keyText: 'CtrlOrCommand+S',
    toolbar: true,
    isRelatedToTab: true,
    icon: 'icon save',
    testEnabled: () => getCurrentEditor()?.canSave(),
    onClick: () => getCurrentEditor().save(),
  });

  registerCommand({
    id: 'tableData.setAutoRefresh.1',
    category: 'Data grid',
    name: 'Refresh every 1 second',
    isRelatedToTab: true,
    testEnabled: () => !!getCurrentEditor(),
    onClick: () => getCurrentEditor().setAutoRefresh(1),
  });

  for (const seconds of INTERVALS) {
    registerCommand({
      id: `tableData.setAutoRefresh.${seconds}`,
      category: 'Data grid',
      name: `Refresh every ${seconds} seconds`,
      isRelatedToTab: true,
      testEnabled: () => !!getCurrentEditor(),
      onClick: () => getCurrentEditor().setAutoRefresh(seconds),
    });
  }

  registerCommand({
    id: 'tableData.stopAutoRefresh',
    category: 'Data grid',
    name: 'Stop auto refresh',
    isRelatedToTab: true,
    keyText: 'CtrlOrCommand+Shift+R',
    testEnabled: () => getCurrentEditor()?.isAutoRefresh() === true,
    onClick: () => getCurrentEditor().stopAutoRefresh(null),
  });

  registerCommand({
    id: 'tableData.startAutoRefresh',
    category: 'Data grid',
    name: 'Start auto refresh',
    isRelatedToTab: true,
    keyText: 'CtrlOrCommand+Shift+R',
    testEnabled: () => getCurrentEditor()?.isAutoRefresh() === false,
    onClick: () => getCurrentEditor().startAutoRefresh(),
  });

  export const matchingProps = ['conid', 'database', 'schemaName', 'pureName'];
  export const allowAddToFavorites = props => true;
</script>

<script lang="ts">
  import _ from 'lodash';
  import App from '../App.svelte';
  import TableDataGrid from '../datagrid/TableDataGrid.svelte';
  import useGridConfig from '../utility/useGridConfig';
  import {
    changeSetContainsChanges,
    changeSetToSql,
    createChangeSet,
    createGridCache,
    createGridConfig,
    getDeleteCascades,
    TableFormViewDisplay,
    TableGridDisplay,
  } from 'dbgate-datalib';
  import { findEngineDriver } from 'dbgate-tools';
  import { reloadDataCacheFunc } from 'dbgate-datalib';
  import { writable } from 'svelte/store';
  import createUndoReducer from '../utility/createUndoReducer';
  import invalidateCommands from '../commands/invalidateCommands';
  import { showModal } from '../modals/modalTools';
  import ErrorMessageModal from '../modals/ErrorMessageModal.svelte';
  import { useConnectionInfo, useDatabaseInfo } from '../utility/metadataLoaders';
  import { scriptToSql } from 'dbgate-sqltree';
  import { extensions } from '../stores';
  import ConfirmSqlModal from '../modals/ConfirmSqlModal.svelte';
  import createActivator, { getActiveComponent } from '../utility/createActivator';
  import registerCommand from '../commands/registerCommand';
  import { registerMenu } from '../utility/contextMenu';
  import { showSnackbarSuccess } from '../utility/snackbar';
  import StatusBarTabItem from '../widgets/StatusBarTabItem.svelte';
  import openNewTab from '../utility/openNewTab';
  import { onDestroy, setContext } from 'svelte';
  import { apiCall } from '../utility/api';
  import { getLocalStorage, setLocalStorage } from '../utility/storageCache';
  import ToolStripContainer from '../buttons/ToolStripContainer.svelte';
  import ToolStripCommandButton from '../buttons/ToolStripCommandButton.svelte';
  import ToolStripExportButton, { createQuickExportHandlerRef } from '../buttons/ToolStripExportButton.svelte';
  import ToolStripCommandSplitButton from '../buttons/ToolStripCommandSplitButton.svelte';
  import { getIntSettingsValue } from '../settings/settingsTools';

  export let tabid;
  export let conid;
  export let database;
  export let schemaName;
  export let pureName;

  export const activator = createActivator('TableDataTab', true);

  const config = useGridConfig(tabid);
  const cache = writable(createGridCache());
  const dbinfo = useDatabaseInfo({ conid, database });

  let autoRefreshInterval = getIntSettingsValue('dataGrid.defaultAutoRefreshInterval', 10, 1, 3600);
  let autoRefreshStarted = false;
  let autoRefreshTimer = null;

  $: connection = useConnectionInfo({ conid });

  const [changeSetStore, dispatchChangeSet] = createUndoReducer(createChangeSet());

  async function handleConfirmSql(sql) {
    const resp = await apiCall('database-connections/run-script', { conid, database, sql });
    const { errorMessage } = resp || {};
    if (errorMessage) {
      showModal(ErrorMessageModal, { title: 'Error when saving', message: errorMessage });
    } else {
      dispatchChangeSet({ type: 'reset', value: createChangeSet() });
      cache.update(reloadDataCacheFunc);
      showSnackbarSuccess('Saved to database');
    }
  }

  export function save() {
    const driver = findEngineDriver($connection, $extensions);
    const script = changeSetToSql($changeSetStore?.value, $dbinfo);
    const deleteCascades = getDeleteCascades($changeSetStore?.value, $dbinfo);
    const sql = scriptToSql(driver, script);
    const deleteCascadesScripts = _.map(deleteCascades, ({ title, commands }) => ({
      title,
      script: scriptToSql(driver, commands),
    }));
    // console.log('deleteCascadesScripts', deleteCascadesScripts);
    showModal(ConfirmSqlModal, {
      sql,
      onConfirm: sqlOverride => handleConfirmSql(sqlOverride || sql),
      engine: driver.engine,
      deleteCascadesScripts,
    });
  }

  export function canSave() {
    return changeSetContainsChanges($changeSetStore?.value);
  }

  export function setAutoRefresh(interval) {
    autoRefreshInterval = interval;
    startAutoRefresh();
    invalidateCommands();
  }

  export function isAutoRefresh() {
    return autoRefreshStarted;
  }

  export function startAutoRefresh() {
    closeRefreshTimer();
    autoRefreshTimer = setInterval(() => {
      cache.update(reloadDataCacheFunc);
    }, autoRefreshInterval * 1000);
    autoRefreshStarted = true;
    invalidateCommands();
  }

  export function stopAutoRefresh() {
    closeRefreshTimer();
    autoRefreshStarted = false;
    invalidateCommands();
  }

  function closeRefreshTimer() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  $: {
    $changeSetStore;
    invalidateCommands();
  }

  registerMenu({ command: 'tableData.save', tag: 'save' });

  const collapsedLeftColumnStore = writable(getLocalStorage('dataGrid_collapsedLeftColumn', false));
  setContext('collapsedLeftColumnStore', collapsedLeftColumnStore);
  $: setLocalStorage('dataGrid_collapsedLeftColumn', $collapsedLeftColumnStore);

  onDestroy(() => {
    closeRefreshTimer();
  });

  const quickExportHandlerRef = createQuickExportHandlerRef();

  function createAutoRefreshMenu() {
    return [
      { divider: true },
      { command: 'tableData.stopAutoRefresh', hideDisabled: true },
      { command: 'tableData.startAutoRefresh', hideDisabled: true },
      'tableData.setAutoRefresh.1',
      ...INTERVALS.map(seconds => ({ command: `tableData.setAutoRefresh.${seconds}`, text: `...${seconds} seconds` })),
    ];
  }
</script>

<ToolStripContainer>
  <TableDataGrid
    {...$$props}
    config={$config}
    setConfig={config.update}
    cache={$cache}
    setCache={cache.update}
    changeSetState={$changeSetStore}
    focusOnVisible
    {changeSetStore}
    {dispatchChangeSet}
  />

  <svelte:fragment slot="toolstrip">
    <ToolStripCommandSplitButton
      buttonLabel={autoRefreshStarted ? `Refresh (every ${autoRefreshInterval}s)` : null}
      commands={['dataGrid.refresh', ...createAutoRefreshMenu()]}
      hideDisabled
    />
    <ToolStripCommandSplitButton
      buttonLabel={autoRefreshStarted ? `Refresh (every ${autoRefreshInterval}s)` : null}
      commands={['dataForm.refresh', ...createAutoRefreshMenu()]}
      hideDisabled
    />

    <!-- <ToolStripCommandButton command="dataGrid.refresh" hideDisabled />
    <ToolStripCommandButton command="dataForm.refresh" hideDisabled /> -->
    <ToolStripCommandButton command="tableData.save" />
    <ToolStripCommandButton command="dataGrid.insertNewRow" hideDisabled />
    <ToolStripCommandButton command="dataGrid.deleteSelectedRows" hideDisabled />
    <ToolStripCommandButton command="dataGrid.switchToForm" hideDisabled />
    <ToolStripCommandButton command="dataGrid.switchToTable" hideDisabled />
    <ToolStripExportButton {quickExportHandlerRef} />
  </svelte:fragment>
</ToolStripContainer>

<StatusBarTabItem
  text="Open structure"
  icon="icon structure"
  clickable
  onClick={() => {
    openNewTab({
      title: pureName,
      icon: 'img table-structure',
      tabComponent: 'TableStructureTab',
      props: {
        schemaName,
        pureName,
        conid,
        database,
        objectTypeField: 'tables',
      },
    });
  }}
/>

<StatusBarTabItem
  text="View columns"
  icon={$collapsedLeftColumnStore ? 'icon columns-outline' : 'icon columns'}
  clickable
  onClick={() => collapsedLeftColumnStore.update(x => !x)}
/>
