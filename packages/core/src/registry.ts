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
  private readonly diagnosticRunners = new Map<string, Map<string, DiagnosticRunner>>();

  register(
    manifest: ModuleManifest,
    runner?: DiagnosticRunner,
  ): Result<void> {
    if (!this.isManifestShapeValid(manifest)) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Манифест модуля имеет недопустимую структуру',
        retryable: false,
      });
    }

    if (runner !== undefined && typeof runner !== 'function') {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Диагностический runner должен быть функцией',
        retryable: false,
      });
    }

    if (!manifest.id || manifest.id.trim().length === 0) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Идентификатор модуля не может быть пустым',
        retryable: false,
      });
    }

    if (!manifest.displayName || manifest.displayName.trim().length === 0) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Отображаемое имя модуля не может быть пустым',
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
      if (!perm.displayName || perm.displayName.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Разрешение '${perm.id}' содержит пустое отображаемое имя`,
          retryable: false,
        });
      }
      if (perm.description !== undefined && typeof perm.description !== 'string') {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Разрешение '${perm.id}' содержит некорректное описание`,
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
      if (
        contrib.requiredPermission !== undefined &&
        (typeof contrib.requiredPermission !== 'string' || contrib.requiredPermission.trim().length === 0)
      ) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `UI-вклад '${contrib.id}' содержит пустое требуемое разрешение`,
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
        if (!diag.displayName || diag.displayName.trim().length === 0) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: `Диагностика '${diag.id}' содержит пустое отображаемое имя`,
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

    // Создаем защитную изолированную копию манифеста от последующих мутаций (план 5.5)
    const clonedManifest: ModuleManifest = {
      id: manifest.id,
      kind: manifest.kind,
      contractVersion: manifest.contractVersion,
      displayName: manifest.displayName,
      permissions: manifest.permissions.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        ...(p.description !== undefined ? { description: p.description } : {}),
      })),
      uiContributions: manifest.uiContributions.map((u) => ({
        id: u.id,
        targetSlot: u.targetSlot,
        label: u.label,
        path: u.path,
        ...(u.requiredPermission !== undefined ? { requiredPermission: u.requiredPermission } : {}),
      })),
      ...(manifest.diagnostics
        ? {
            diagnostics: manifest.diagnostics.map((d) => ({
              id: d.id,
              displayName: d.displayName,
            })),
          }
        : {}),
    };

    Object.freeze(clonedManifest);
    Object.freeze(clonedManifest.permissions);
    clonedManifest.permissions.forEach(Object.freeze);
    Object.freeze(clonedManifest.uiContributions);
    clonedManifest.uiContributions.forEach(Object.freeze);
    if (clonedManifest.diagnostics) {
      Object.freeze(clonedManifest.diagnostics);
      clonedManifest.diagnostics.forEach(Object.freeze);
    }

    // Применяем регистрацию ТОЛЬКО после того, как все проверки успешно пройдены
    for (const permId of localPerms) {
      this.permissionOwners.set(permId, clonedManifest.id);
    }
    for (const contribId of localContributions) {
      this.contributionOwners.set(contribId, clonedManifest.id);
    }

    if (runner && clonedManifest.diagnostics) {
      const moduleRunners = new Map<string, DiagnosticRunner>();
      for (const diag of clonedManifest.diagnostics) {
        moduleRunners.set(diag.id, runner);
      }
      this.diagnosticRunners.set(clonedManifest.id, moduleRunners);
    }

    this.modules.set(clonedManifest.id, {
      manifest: clonedManifest,
      registeredAt: new Date(),
    });

    return ok(undefined);
  }

  getModule(id: string): RegisteredModule | undefined {
    const registered = this.modules.get(id);
    return registered ? this.snapshot(registered) : undefined;
  }

  getAllModules(): readonly RegisteredModule[] {
    return Array.from(this.modules.values(), (registered) => this.snapshot(registered));
  }

  private snapshot(registered: RegisteredModule): RegisteredModule {
    const manifest: ModuleManifest = {
      id: registered.manifest.id,
      kind: registered.manifest.kind,
      contractVersion: registered.manifest.contractVersion,
      displayName: registered.manifest.displayName,
      permissions: registered.manifest.permissions.map((permission) => ({ ...permission })),
      uiContributions: registered.manifest.uiContributions.map((contribution) => ({ ...contribution })),
      ...(registered.manifest.diagnostics
        ? { diagnostics: registered.manifest.diagnostics.map((diagnostic) => ({ ...diagnostic })) }
        : {}),
    };
    return { manifest, registeredAt: new Date(registered.registeredAt.getTime()) };
  }

  getAllPermissions(): readonly string[] {
    return Array.from(this.permissionOwners.keys());
  }

  async runDiagnostic(
    moduleId: string,
    diagnosticId: string,
    timeoutMs = 5000,
  ): Promise<DiagnosticResult> {
    const runner = this.diagnosticRunners.get(moduleId)?.get(diagnosticId);
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
      const result = await Promise.race([runnerPromise, timeoutPromise]);
      if (!this.isDiagnosticResult(result)) {
        return {
          status: 'error',
          detailCode: 'INVALID_DIAGNOSTIC_RESULT',
          durationMs: Date.now() - start,
        };
      }
      return result;
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

  private isManifestShapeValid(manifest: ModuleManifest): boolean {
    if (!manifest || typeof manifest !== 'object') return false;
    if (
      typeof manifest.id !== 'string' ||
      typeof manifest.kind !== 'string' ||
      typeof manifest.contractVersion !== 'string' ||
      typeof manifest.displayName !== 'string'
    ) {
      return false;
    }
    if (!Array.isArray(manifest.permissions) || !Array.isArray(manifest.uiContributions)) {
      return false;
    }
    if (manifest.kind !== 'business-module' && manifest.kind !== 'core-extension') {
      return false;
    }
    if (manifest.diagnostics !== undefined && !Array.isArray(manifest.diagnostics)) {
      return false;
    }
    if (
      manifest.permissions.some(
        (permission) =>
          !permission ||
          typeof permission !== 'object' ||
          typeof permission.id !== 'string' ||
          typeof permission.displayName !== 'string',
      )
    ) {
      return false;
    }
    if (
      manifest.uiContributions.some(
        (contribution) =>
          !contribution ||
          typeof contribution !== 'object' ||
          typeof contribution.id !== 'string' ||
          typeof contribution.targetSlot !== 'string' ||
          typeof contribution.label !== 'string' ||
          typeof contribution.path !== 'string' ||
          (contribution.requiredPermission !== undefined &&
            typeof contribution.requiredPermission !== 'string'),
      )
    ) {
      return false;
    }
    if (
      manifest.diagnostics?.some(
        (diagnostic) =>
          !diagnostic ||
          typeof diagnostic !== 'object' ||
          typeof diagnostic.id !== 'string' ||
          typeof diagnostic.displayName !== 'string',
      )
    ) {
      return false;
    }
    return true;
  }

  private isDiagnosticResult(value: unknown): value is DiagnosticResult {
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      ((value as DiagnosticResult).status === 'ok' ||
        (value as DiagnosticResult).status === 'error' ||
        (value as DiagnosticResult).status === 'timeout') &&
      typeof (value as DiagnosticResult).detailCode === 'string' &&
      Number.isFinite((value as DiagnosticResult).durationMs) &&
      (value as DiagnosticResult).durationMs >= 0
    );
  }
}
