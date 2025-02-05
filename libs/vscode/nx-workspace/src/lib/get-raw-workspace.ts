import type { WorkspaceJsonConfiguration } from '@nrwl/devkit';
import { readAndParseJson } from '@nx-console/server';
import { WorkspaceConfigurationStore } from '@nx-console/vscode/configuration';

/**
 * Get the raw workspace file that hasn't been normalized by nx
 */
export async function getRawWorkspace() {
  const workspaceJsonPath = WorkspaceConfigurationStore.instance.get(
    'nxWorkspaceJsonPath',
    ''
  );

  const rawWorkspace = (await readAndParseJson(
    workspaceJsonPath
  )) as WorkspaceJsonConfiguration;
  return { rawWorkspace, workspaceJsonPath };
}
