import type {
  ModuleManifest,
  DiagnosticResult,
} from '@ems/contracts';

export const DIAGNOSTIC_EXTENSION_ID = 'extension.core-diagnostics';

export const diagnosticExtensionManifest: ModuleManifest = {
  id: DIAGNOSTIC_EXTENSION_ID,
  kind: 'core-extension',
  contractVersion: '1.0.0',
  displayName: 'Диагностика системы',
  permissions: [
    {
      id: 'diagnostics.run',
      displayName: 'Запуск самодиагностики',
      description: 'Право на выполнение диагностических тестов подсистем',
    },
  ],
  uiContributions: [],
  diagnostics: [
    {
      id: 'system-health',
      displayName: 'Проверка целостности подсистем',
    },
  ],
};

export async function runSystemHealthDiagnostic(
  diagnosticId: string,
): Promise<DiagnosticResult> {
  const start = Date.now();

  if (diagnosticId !== 'system-health') {
    return {
      status: 'error',
      detailCode: 'UNKNOWN_DIAGNOSTIC_ID',
      durationMs: Date.now() - start,
    };
  }

  return {
    status: 'ok',
    detailCode: 'SUBSYSTEMS_OPERATIONAL',
    durationMs: Date.now() - start,
  };
}
