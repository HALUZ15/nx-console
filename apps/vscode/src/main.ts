import { existsSync } from 'fs';
import { dirname, join, parse } from 'path';
import {
  commands,
  ExtensionContext,
  FileSystemWatcher,
  RelativePattern,
  tasks,
  TreeView,
  Uri,
  window,
  workspace,
} from 'vscode';

import {
  CliTaskProvider,
  registerCliTaskCommands,
  registerNxCommands,
} from '@nx-console/vscode/tasks';
import {
  getOutputChannel,
  getTelemetry,
  initTelemetry,
  getGenerators,
  teardownTelemetry,
  watchFile,
} from '@nx-console/server';
import {
  GlobalConfigurationStore,
  WorkspaceConfigurationStore,
} from '@nx-console/vscode/configuration';
import { revealWebViewPanel } from '@nx-console/vscode/webview';
import {
  LOCATE_YOUR_WORKSPACE,
  RunTargetTreeItem,
  RunTargetTreeProvider,
} from '@nx-console/vscode/nx-run-target-view';
import { verifyNodeModules } from '@nx-console/vscode/verify';
import {
  NxCommandsTreeItem,
  NxCommandsTreeProvider,
} from '@nx-console/vscode/nx-commands-view';
import {
  NxProjectTreeItem,
  NxProjectTreeProvider,
} from '@nx-console/vscode/nx-project-view';
import { environment } from './environments/environment';
import { Awaited } from '@nx-console/schema';

import {
  WorkspaceJsonSchema,
  ProjectJsonSchema,
} from '@nx-console/vscode/json-schema';

let runTargetTreeView: TreeView<RunTargetTreeItem>;
let nxProjectTreeView: TreeView<NxProjectTreeItem>;
let nxCommandsTreeView: TreeView<NxCommandsTreeItem>;

let currentRunTargetTreeProvider: RunTargetTreeProvider;
let nxProjectsTreeProvider: NxProjectTreeProvider;

let cliTaskProvider: CliTaskProvider;
let context: ExtensionContext;
let workspaceFileWatcher: FileSystemWatcher | undefined;

export async function activate(c: ExtensionContext) {
  try {
    const startTime = Date.now();
    context = c;

    GlobalConfigurationStore.fromContext(context);
    WorkspaceConfigurationStore.fromContext(context);

    currentRunTargetTreeProvider = new RunTargetTreeProvider(
      context.extensionPath
    );

    initTelemetry(GlobalConfigurationStore.instance, environment.production);

    runTargetTreeView = window.createTreeView('nxRunTarget', {
      treeDataProvider: currentRunTargetTreeProvider,
    }) as TreeView<RunTargetTreeItem>;

    const revealWebViewPanelCommand = commands.registerCommand(
      'nxConsole.revealWebViewPanel',
      async (runTargetTreeItem: RunTargetTreeItem, contextMenuUri?: Uri) => {
        if (
          !existsSync(
            join(runTargetTreeItem.workspaceJsonPath, '..', 'node_modules')
          )
        ) {
          const { validNodeModules: hasNodeModules } = verifyNodeModules(
            join(runTargetTreeItem.workspaceJsonPath, '..')
          );
          if (!hasNodeModules) {
            return;
          }
        }
        revealWebViewPanel({
          runTargetTreeItem,
          context,
          cliTaskProvider,
          runTargetTreeView,
          contextMenuUri,
        });
      }
    );

    const manuallySelectWorkspaceDefinitionCommand = commands.registerCommand(
      LOCATE_YOUR_WORKSPACE.command?.command || '',
      async () => {
        return manuallySelectWorkspaceDefinition();
      }
    );
    const vscodeWorkspacePath =
      workspace.workspaceFolders && workspace.workspaceFolders[0].uri.fsPath;

    if (vscodeWorkspacePath) {
      scanForWorkspace(vscodeWorkspacePath);
    }

    context.subscriptions.push(
      runTargetTreeView,
      revealWebViewPanelCommand,
      manuallySelectWorkspaceDefinitionCommand
    );

    // registers itself as a CodeLensProvider and watches config to dispose/re-register
    const { WorkspaceCodeLensProvider } = await import(
      '@nx-console/vscode/nx-workspace'
    );
    new WorkspaceCodeLensProvider(context);
    new WorkspaceJsonSchema(context);
    new ProjectJsonSchema(context);

    getTelemetry().extensionActivated((Date.now() - startTime) / 1000);
  } catch (e) {
    window.showErrorMessage(
      'Nx Console encountered an error when activating (see output panel)'
    );
    getOutputChannel().appendLine(
      'Nx Console encountered an error when activating'
    );
    getOutputChannel().appendLine(JSON.stringify(e));
    getTelemetry().exception(e.message);
  }
}

export async function deactivate() {
  getTelemetry().extensionDeactivated();
  teardownTelemetry();
}

// -----------------------------------------------------------------------------

function manuallySelectWorkspaceDefinition() {
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    return window
      .showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select workspace directory',
      })
      .then((value) => {
        if (value && value[0]) {
          const selectedDirectory = value[0].fsPath;
          return setWorkspace(
            join(
              selectedDirectory,
              existsSync(join(selectedDirectory, 'angular.json'))
                ? 'angular.json'
                : 'workspace.json'
            )
          );
        }
      });
  } else {
    window.showInformationMessage(
      'Cannot select an Nx workspace when no folders are opened in the explorer'
    );
  }
}

function scanForWorkspace(vscodeWorkspacePath: string) {
  let currentDirectory = vscodeWorkspacePath;

  const { root } = parse(vscodeWorkspacePath);

  const workspaceJsonPath = WorkspaceConfigurationStore.instance.get(
    'nxWorkspaceJsonPath',
    ''
  );
  if (workspaceJsonPath) {
    currentDirectory = dirname(workspaceJsonPath);
  }

  while (currentDirectory !== root) {
    if (existsSync(join(currentDirectory, 'angular.json'))) {
      setWorkspace(join(currentDirectory, 'angular.json'));
    }
    if (existsSync(join(currentDirectory, 'workspace.json'))) {
      setWorkspace(join(currentDirectory, 'workspace.json'));
    }
    currentDirectory = dirname(currentDirectory);
  }
}

async function setWorkspace(workspaceJsonPath: string) {
  WorkspaceConfigurationStore.instance.set(
    'nxWorkspaceJsonPath',
    workspaceJsonPath
  );
  const { verifyWorkspace } = await import('@nx-console/vscode/nx-workspace');

  const { validWorkspaceJson } = await verifyWorkspace();
  if (!validWorkspaceJson) {
    return;
  }

  if (!cliTaskProvider) {
    cliTaskProvider = new CliTaskProvider();
    registerNxCommands(context, cliTaskProvider);
    tasks.registerTaskProvider('ng', cliTaskProvider);
    tasks.registerTaskProvider('nx', cliTaskProvider);
    registerCliTaskCommands(context, cliTaskProvider);

    nxProjectsTreeProvider = new NxProjectTreeProvider(
      context,
      cliTaskProvider
    );
    nxProjectTreeView = window.createTreeView('nxProjects', {
      treeDataProvider: nxProjectsTreeProvider,
    });

    const nxCommandsTreeProvider = new NxCommandsTreeProvider(context);
    nxCommandsTreeView = window.createTreeView('nxCommands', {
      treeDataProvider: nxCommandsTreeProvider,
    });

    context.subscriptions.push(nxCommandsTreeView, nxProjectTreeView);
  } else {
    WorkspaceConfigurationStore.instance.set(
      'nxWorkspaceJsonPath',
      workspaceJsonPath
    );
  }

  await setApplicationAndLibraryContext(workspaceJsonPath);

  const isNxWorkspace = existsSync(join(workspaceJsonPath, '..', 'nx.json'));
  const isAngularWorkspace = workspaceJsonPath.endsWith('angular.json');

  commands.executeCommand(
    'setContext',
    'isAngularWorkspace',
    isAngularWorkspace
  );
  commands.executeCommand('setContext', 'isNxWorkspace', isNxWorkspace);

  registerWorkspaceFileWatcher(context, workspaceJsonPath);

  currentRunTargetTreeProvider.refresh();
  nxProjectsTreeProvider.refresh();

  let workspaceType: 'nx' | 'angular' | 'angularWithNx' = 'nx';
  if (isNxWorkspace && isAngularWorkspace) {
    workspaceType = 'angularWithNx';
  } else if (isNxWorkspace && !isAngularWorkspace) {
    workspaceType = 'nx';
  } else if (!isNxWorkspace && isAngularWorkspace) {
    workspaceType = 'angular';
  }

  getTelemetry().record('WorkspaceType', { workspaceType });
}

async function setApplicationAndLibraryContext(workspaceJsonPath: string) {
  const { getNxConfig } = await import('@nx-console/vscode/nx-workspace');

  let nxConfig: Awaited<ReturnType<typeof getNxConfig>>;
  try {
    nxConfig = await getNxConfig(dirname(workspaceJsonPath));
  } catch {
    return;
  }

  commands.executeCommand('setContext', 'nxAppsDir', [
    join(
      dirname(workspaceJsonPath),
      nxConfig.workspaceLayout?.appsDir ?? 'apps'
    ),
  ]);
  commands.executeCommand('setContext', 'nxLibsDir', [
    join(
      dirname(workspaceJsonPath),
      nxConfig.workspaceLayout?.libsDir ?? 'libs'
    ),
  ]);

  const generatorCollections = await getGenerators(workspaceJsonPath);

  let hasApplicationGenerators = false;
  let hasLibraryGenerators = false;

  generatorCollections.forEach((generatorCollection) => {
    if (generatorCollection.data) {
      if (generatorCollection.data.type === 'application') {
        hasApplicationGenerators = true;
      } else if (generatorCollection.data.type === 'library') {
        hasLibraryGenerators = true;
      }
    }
  });

  commands.executeCommand(
    'setContext',
    'nx.hasApplicationGenerators',
    hasApplicationGenerators
  );
  commands.executeCommand(
    'setContext',
    'nx.hasLibraryGenerators',
    hasLibraryGenerators
  );
}

function registerWorkspaceFileWatcher(
  context: ExtensionContext,
  workspaceJsonPath: string
) {
  if (workspaceFileWatcher) {
    workspaceFileWatcher.dispose();
  }

  const workspaceDir = dirname(workspaceJsonPath);

  workspaceFileWatcher = watchFile(
    new RelativePattern(workspaceDir, '**/{workspace,angular,project}.json'),
    () => {
      commands.executeCommand('nxConsole.refreshNxProjectsTree');
    }
  );

  context.subscriptions.push(workspaceFileWatcher);
}
