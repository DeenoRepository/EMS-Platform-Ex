import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionRegistry } from './registry.js';
import type { ModuleManifest } from '@ems/contracts';

describe('ExtensionRegistry contract tests', () => {
  const validManifest: ModuleManifest = {
    id: 'test.module.orders',
    kind: 'business-module',
    contractVersion: '1.0.0',
    displayName: 'Управление заказами',
    permissions: [
      {
        id: 'orders.view',
        displayName: 'Просмотр заказов',
      },
    ],
    uiContributions: [
      {
        id: 'nav.orders',
        targetSlot: 'sidebar',
        label: 'Заказы',
        path: '/orders',
        requiredPermission: 'orders.view',
      },
    ],
  };

  test('успешная регистрация корректного манифеста', () => {
    const registry = new ExtensionRegistry();
    const result = registry.register(validManifest);

    assert.equal(result.ok, true);
    assert.equal(registry.getAllModules().length, 1);
    assert.deepEqual(registry.getAllPermissions(), ['orders.view']);
  });

  test('отклонение дублирующегося идентификатора модуля (FR-033)', () => {
    const registry = new ExtensionRegistry();
    const first = registry.register(validManifest);
    assert.equal(first.ok, true);

    const duplicate = registry.register(validManifest);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) {
      assert.equal(duplicate.error.code, 'CONFLICT');
    }
  });

  test('отклонение дублирующегося разрешения от другого модуля', () => {
    const registry = new ExtensionRegistry();
    registry.register(validManifest);

    const conflictingManifest: ModuleManifest = {
      id: 'test.module.other',
      kind: 'business-module',
      contractVersion: '1.0.0',
      displayName: 'Другой модуль',
      permissions: [
        {
          id: 'orders.view', // Конфликт!
          displayName: 'Чужой просмотр',
        },
      ],
      uiContributions: [],
    };

    const result = registry.register(conflictingManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'CONFLICT');
    }
  });

  test('отклонение неподдерживаемой версии контракта (FR-033)', () => {
    const registry = new ExtensionRegistry();
    const badVersionManifest: ModuleManifest = {
      ...validManifest,
      id: 'test.module.bad-version',
      contractVersion: '999.0.0',
    };

    const result = registry.register(badVersionManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'VALIDATION_FAILED');
    }
  });

  test('отклонение пустого идентификатора модуля', () => {
    const registry = new ExtensionRegistry();
    const emptyIdManifest: ModuleManifest = {
      ...validManifest,
      id: '   ',
    };

    const result = registry.register(emptyIdManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'VALIDATION_FAILED');
    }
  });

  test('диагностическое расширение возвращает ok при штатной работе (FR-035)', async () => {
    const registry = new ExtensionRegistry();
    const diagManifest: ModuleManifest = {
      id: 'test.extension.diagnostics',
      kind: 'core-extension',
      contractVersion: '1.0.0',
      displayName: 'Диагностика',
      permissions: [],
      uiContributions: [],
      diagnostics: [
        { id: 'health-check', displayName: 'Проверка здоровья' },
      ],
    };

    registry.register(diagManifest, async (diagId) => {
      assert.equal(diagId, 'health-check');
      return {
        status: 'ok',
        detailCode: 'OK_STATUS',
        durationMs: 5,
      };
    });

    const res = await registry.runDiagnostic('test.extension.diagnostics', 'health-check');
    assert.equal(res.status, 'ok');
    assert.equal(res.detailCode, 'OK_STATUS');
  });

  test('диагностика возвращает ошибку для неизвестного идентификатора', async () => {
    const registry = new ExtensionRegistry();
    const res = await registry.runDiagnostic('non-existent', 'unknown');
    assert.equal(res.status, 'error');
    assert.equal(res.detailCode, 'DIAGNOSTIC_NOT_FOUND');
  });
});
