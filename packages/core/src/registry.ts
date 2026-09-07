import type {
  ModuleManifest,
  Result,
  DiagnosticResult,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';

export const SUPPORTED_CONTRACT_VERSIONS = ['1.0.0'] as const;
export const ALLOWED_UI_SLOTS = ['sidebar', 'dashboard', 'settings'] as const;

export interface RegisteredModule {
  readonly manifest: ModuleManifest;
  readonly registeredAt: Date;
}

export interface DiagnosticRunner {
  (diagnosticId: string): Promise<DiagnosticResult>;
}

export class ExtensionRegistry {
  private readonly modules = new Map<string, RegisteredModule>();
  private readonly permissionOwners = new Map<string, string>();
  private readonly contributionOwners = new Map<string, string>();
  private readonly diagnosticRunners = new Map<string, DiagnosticRunner>();

  register(
    manifest: ModuleManifest,
    runner?: DiagnosticRunner,
  ): Result<void> {
    if (!manifest.id || manifest.id.trim().length === 0) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор модуля не может быть пустым',
        retryable: false,
      });
    }

    if (this.modules.has(manifest.id)) {
      return fail({
        code: 'CONFLICT',
        message: `Модуль или расширение с идентификатором '${manifest.id}' уже зарегистрирован`,
        retryable: false,
      });
    }

    if (
      !SUPPORTED_CONTRACT_VERSIONS.includes(
        manifest.contractVersion as (typeof SUPPORTED_CONTRACT_VERSIONS)[number],
      )
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Неподдерживаемая версия контракта '${manifest.contractVersion}' для модуля '${manifest.id}'`,
        retryable: false,
      });
    }

    // Валидация разрешений
    const localPerms = new Set<string>();
    for (const perm of manifest.permissions) {
      if (!perm.id || perm.id.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Модуль '${manifest.id}' содержит объявление разрешения с пустым идентификатором`,
          retryable: false,
        });
      }
      if (localPerms.has(perm.id)) {
        return fail({
          code: 'CONFLICT',
          message: `Дублирующееся разрешение '${perm.id}' внутри манифеста модуля '${manifest.id}'`,
          retryable: false,
        });
      }
      localPerms.add(perm.id);

      const existingOwner = this.permissionOwners.get(perm.id);
      if (existingOwner) {
        return fail({
          code: 'CONFLICT',
          message: `Разрешение '${perm.id}' уже объявлено модулем '${existingOwner}'`,
          retryable: false,
        });
      }
    }

    // Валидация UI-вкладов (FR-033, ADR-0001)
    const localContributions = new Set<string>();
    for (const contrib of manifest.uiContributions) {
      if (!contrib.id || contrib.id.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Модуль '${manifest.id}' содержит UI-вклад с пустым идентификатором`,
          retryable: false,
        });
      }
      if (!contrib.label || contrib.label.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `UI-вклад '${contrib.id}' модуля '${manifest.id}' содержит пустой label`,
          retryable: false,
        });
      }
      if (!contrib.path || contrib.path.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `UI-вклад '${contrib.id}' модуля '${manifest.id}' содержит пустой path`,
          retryable: false,
        });
      }
      if (!ALLOWED_UI_SLOTS.includes(contrib.targetSlot as (typeof ALLOWED_UI_SLOTS)[number])) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Недопустимый targetSlot '${contrib.targetSlot}' для UI-вклада '${contrib.id}'`,
          retryable: false,
        });
      }
      if (localContributions.has(contrib.id)) {
        return fail({
          code: 'CONFLICT',
          message: `Дублирующийся UI-вклад '${contrib.id}' внутри манифеста модуля '${manifest.id}'`,
          retryable: false,
        });
      }
      localContributions.add(contrib.id);

      const existingOwner = this.contributionOwners.get(contrib.id);
      if (existingOwner) {
        return fail({
          code: 'CONFLICT',
          message: `UI-вклад '${contrib.id}' уже объявлен модулем '${existingOwner}'`,
          retryable: false,
        });
      }
    }

    // Валидация диагностик: запрет отсутствующего раннера (FR-033)
    if (manifest.diagnostics && manifest.diagnostics.length > 0) {
      if (!runner) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Модуль '${manifest.id}' объявляет диагностические проверки, но runner не предоставлен`,
          retryable: false,
        });
      }

      const localDiagnostics = new Set<string>();
      for (const diag of manifest.diagnostics) {
        if (!diag.id || diag.id.trim().length === 0) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: `Модуль '${manifest.id}' содержит диагностику с пустым идентификатором`,
            retryable: false,
          });
        }
        if (localDiagnostics.has(diag.id)) {
          return fail({
            code: 'CONFLICT',
            message: `Дублирующаяся диагностика '${diag.id}' внутри манифеста модуля '${manifest.id}'`,
            retryable: false,
          });
        }
        localDiagnostics.add(diag.id);
      }
    }

    // Применяем регистрацию после успешной валидации
    for (const permId of localPerms) {
      this.permissionOwners.set(permId, manifest.id);
    }
    for (const contribId of localContributions) {
      this.contributionOwners.set(contribId, manifest.id);
    }

    if (runner && manifest.diagnostics) {
      for (const diag of manifest.diagnostics) {
        this.diagnosticRunners.set(`${manifest.id}:${diag.id}`, runner);
      }
    }

    this.modules.set(manifest.id, {
      manifest,
      registeredAt: new Date(),
    });

    return ok(undefined);
  }

  getModule(id: string): RegisteredModule | undefined {
    return this.modules.get(id);
  }

  getAllModules(): readonly RegisteredModule[] {
    return Array.from(this.modules.values());
  }

  getAllPermissions(): readonly string[] {
    return Array.from(this.permissionOwners.keys());
  }

  async runDiagnostic(
    moduleId: string,
    diagnosticId: string,
    timeoutMs = 5000,
  ): Promise<DiagnosticResult> {
    const key = `${moduleId}:${diagnosticId}`;
    const runner = this.diagnosticRunners.get(key);
    if (!runner) {
      return {
        status: 'error',
        detailCode: 'DIAGNOSTIC_NOT_FOUND',
        durationMs: 0,
      };
    }

    const start = Date.now();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<DiagnosticResult>((resolve) => {
        timerId = setTimeout(() => {
          resolve({
            status: 'timeout',
            detailCode: 'DIAGNOSTIC_TIMEOUT',
            durationMs: Date.now() - start,
          });
        }, timeoutMs);
      });

      const runnerPromise = runner(diagnosticId);
      return await Promise.race([runnerPromise, timeoutPromise]);
    } catch {
      return {
        status: 'error',
        detailCode: 'DIAGNOSTIC_EXECUTION_FAILED',
        durationMs: Date.now() - start,
      };
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }
}
