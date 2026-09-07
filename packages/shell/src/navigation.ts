import type { UIContributionDeclaration } from '@ems/contracts';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly active?: boolean;
}

export interface ShellUserSummary {
  readonly employeeId: string;
  readonly departmentName: string;
  readonly roles: readonly string[];
}

export interface ShellLayoutProps {
  readonly title: string;
  readonly navigationItems: readonly NavItem[];
  readonly currentUser?: ShellUserSummary;
}

export function filterNavigationForUser(
  contributions: readonly UIContributionDeclaration[],
  userPermissions: readonly string[],
): readonly NavItem[] {
  return contributions
    .filter((contrib) => {
      if (contrib.targetSlot !== 'sidebar') return false;
      if (!contrib.requiredPermission) return true;
      return userPermissions.includes(contrib.requiredPermission);
    })
    .map((contrib) => ({
      id: contrib.id,
      label: contrib.label,
      path: contrib.path,
    }));
}
