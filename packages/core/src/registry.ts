import type {
  ModuleManifest,
  Result,
  DiagnosticResult,
} from '@ems/contracts';
import { ok, fail } from '@ems/contracts';

export const SUPPORTED_CONTRACT_VERSIONS = ['1.0.0'] as const;

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

    for (const perm of manifest.permissions) {
      const existingOwner = this.permissionOwners.get(perm.id);
      if (existingOwner) {
        return fail({
          code: 'CONFLICT',
          message: `Разрешение '${perm.id}' уже объявлено модулем '${existingOwner}'`,
          retryable: false,
        });
      }
    }

    for (const perm of manifest.permissions) {
      this.permissionOwners.set(perm.id, manifest.id);
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
    try {
      const timeoutPromise = new Promise<DiagnosticResult>((resolve) => {
        setTimeout(() => {
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
    }
  }
}
