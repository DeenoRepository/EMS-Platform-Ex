import { ExtensionRegistry } from '@ems/core';
import { demoModuleManifest } from '@ems/demo-module';
import {
  diagnosticExtensionManifest,
  runSystemHealthDiagnostic,
} from '@ems/diagnostic-extension';
import { filterNavigationForUser } from '@ems/shell';

export interface AppComposition {
  readonly registry: ExtensionRegistry;
  readonly getNavigationForUser: (permissions: readonly string[]) => ReturnType<typeof filterNavigationForUser>;
}

export function createAppComposition(): AppComposition {
  const registry = new ExtensionRegistry();

  const demoReg = registry.register(demoModuleManifest);
  if (!demoReg.ok) {
    throw new Error(`Ошибка регистрации демо-модуля: ${demoReg.error.message}`);
  }

  const diagReg = registry.register(
    diagnosticExtensionManifest,
    runSystemHealthDiagnostic,
  );
  if (!diagReg.ok) {
    throw new Error(`Ошибка регистрации диагностического расширения: ${diagReg.error.message}`);
  }

  return {
    registry,
    getNavigationForUser: (permissions: readonly string[]) => {
      const allContributions = registry
        .getAllModules()
        .flatMap((m) => m.manifest.uiContributions);
      return filterNavigationForUser(allContributions, permissions);
    },
  };
}
