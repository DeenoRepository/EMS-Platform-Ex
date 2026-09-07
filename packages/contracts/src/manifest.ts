export interface PermissionDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export type UISlot = 'sidebar' | 'dashboard' | 'settings';

export interface UIContributionDeclaration {
  readonly id: string;
  readonly targetSlot: UISlot;
  readonly label: string;
  readonly path: string;
  readonly requiredPermission?: string;
}

export type DiagnosticStatus = 'ok' | 'error' | 'timeout';

export interface DiagnosticResult {
  readonly status: DiagnosticStatus;
  readonly detailCode: string;
  readonly durationMs: number;
}

export interface DiagnosticDeclaration {
  readonly id: string;
  readonly displayName: string;
}

export type ModuleKind = 'business-module' | 'core-extension';

export interface ModuleManifest {
  readonly id: string;
  readonly kind: ModuleKind;
  readonly contractVersion: string;
  readonly displayName: string;
  readonly permissions: readonly PermissionDeclaration[];
  readonly uiContributions: readonly UIContributionDeclaration[];
  readonly diagnostics?: readonly DiagnosticDeclaration[];
}
