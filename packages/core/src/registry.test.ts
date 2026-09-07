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

  test('отклонение дублирующегося разрешения внутри одного манифеста', () => {
    const registry = new ExtensionRegistry();
    const duplicatePermManifest: ModuleManifest = {
      ...validManifest,
      id: 'test.module.duplicate-perm',
      permissions: [
        { id: 'perm.one', displayName: 'Первое' },
        { id: 'perm.one', displayName: 'Дубликат' },
      ],
    };

    const result = registry.register(duplicatePermManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'CONFLICT');
      assert.match(result.error.message, /внутри манифеста/);
    }
  });

  test('отклонение манифеста с диагностиками при отсутствии runner (FR-033)', () => {
    const registry = new ExtensionRegistry();
    const manifestWithDiagNoRunner: ModuleManifest = {
      ...validManifest,
      id: 'test.module.diag-no-runner',
      diagnostics: [
        { id: 'check-something', displayName: 'Проверка' },
      ],
    };

    const result = registry.register(manifestWithDiagNoRunner);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'VALIDATION_FAILED');
      assert.match(result.error.message, /runner не предоставлен/);
    }
  });

  test('отклонение невалидного targetSlot для UI-вклада', () => {
    const registry = new ExtensionRegistry();
    const badSlotManifest: ModuleManifest = {
      ...validManifest,
      id: 'test.module.bad-slot',
      uiContributions: [
        {
          id: 'bad-contrib',
          targetSlot: 'unsupported-slot' as any,
          label: 'Метка',
          path: '/path',
        },
      ],
    };

    const result = registry.register(badSlotManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'VALIDATION_FAILED');
      assert.match(result.error.message, /Недопустимый targetSlot/);
    }
  });

  test('отклонение дублирующегося UI-вклада между модулями', () => {
    const registry = new ExtensionRegistry();
    const first = registry.register(validManifest);
    assert.equal(first.ok, true);

    const conflictingManifest: ModuleManifest = {
      ...validManifest,
      id: 'test.module.conflicting-ui',
      permissions: [],
      uiContributions: [
        {
          id: 'nav.orders', // дублирует validManifest
          targetSlot: 'sidebar',
          label: 'Заказы 2',
          path: '/orders2',
        },
      ],
    };

    const result = registry.register(conflictingManifest);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'CONFLICT');
      assert.match(result.error.message, /UI-вклад 'nav\.orders' уже объявлен/);
    }
  });

  test('мутация переданного объекта манифеста после регистрации не влияет на реестр (защитная копия)', () => {
    const registry = new ExtensionRegistry();
    const mutableManifest: ModuleManifest = {
      id: 'test.module.mutable',
      kind: 'business-module',
      contractVersion: '1.0.0',
      displayName: 'Оригинал',
      permissions: [{ id: 'perm.mutable', displayName: 'Разрешение' }],
      uiContributions: [{ id: 'nav.mutable', targetSlot: 'sidebar', label: 'Нав', path: '/nav' }],
    };

    const result = registry.register(mutableManifest);
    assert.equal(result.ok, true);

    // Пытаемся мутировать входной объект
    (mutableManifest.permissions as any).push({ id: 'perm.injected', displayName: 'Внедренное' });

    // Проверяем, что в реестре осталась защищенная копия
    const registered = registry.getModule('test.module.mutable');
    assert.equal(registered?.manifest.permissions.length, 1);
    assert.equal(registered?.manifest.permissions[0]?.id, 'perm.mutable');
    assert.deepEqual(registry.getAllPermissions(), ['perm.mutable']);
  });

  test('getter registry не позволяет изменить сохраненный manifest или registeredAt', () => {
    const registry = new ExtensionRegistry();
    assert.equal(registry.register(validManifest).ok, true);
    const first = registry.getModule(validManifest.id)!;
    (first.manifest.permissions as any).push({ id: 'injected', displayName: 'Injected' });
    first.registeredAt.setTime(0);
    const second = registry.getModule(validManifest.id)!;
    assert.equal(second.manifest.permissions.length, 1);
    assert.notEqual(second.registeredAt.getTime(), 0);
  });

  test('диагностическая ошибка, timeout и невалидный результат безопасны', async () => {
    const registry = new ExtensionRegistry();
    const manifest: ModuleManifest = {
      ...validManifest,
      id: 'test.extension.failures',
      diagnostics: [
        { id: 'throws', displayName: 'Throws' },
        { id: 'hangs', displayName: 'Hangs' },
        { id: 'invalid', displayName: 'Invalid' },
      ],
    };
    assert.equal(registry.register(manifest, async (id) => {
      if (id === 'throws') throw new Error('secret');
      if (id === 'hangs') return await new Promise<never>(() => undefined);
      return { status: 'invalid' } as any;
    }).ok, true);
    assert.equal((await registry.runDiagnostic(manifest.id, 'throws')).detailCode, 'DIAGNOSTIC_EXECUTION_FAILED');
    assert.equal((await registry.runDiagnostic(manifest.id, 'hangs', 1)).status, 'timeout');
    assert.equal((await registry.runDiagnostic(manifest.id, 'invalid')).detailCode, 'INVALID_DIAGNOSTIC_RESULT');
  });

  test('диагностики с двоеточиями не сталкиваются между модулями', async () => {
    const registry = new ExtensionRegistry();
    const makeManifest = (id: string, diagnosticId: string): ModuleManifest => ({
      id,
      kind: 'core-extension',
      contractVersion: '1.0.0',
      displayName: id,
      permissions: [],
      uiContributions: [],
      diagnostics: [{ id: diagnosticId, displayName: diagnosticId }],
    });
    assert.equal(registry.register(makeManifest('a:b', 'c'), async () => ({ status: 'ok', detailCode: 'A', durationMs: 0 })).ok, true);
    assert.equal(registry.register(makeManifest('a', 'b:c'), async () => ({ status: 'ok', detailCode: 'B', durationMs: 0 })).ok, true);
    assert.equal((await registry.runDiagnostic('a:b', 'c')).detailCode, 'A');
    assert.equal((await registry.runDiagnostic('a', 'b:c')).detailCode, 'B');
  });

  test('отклонение невалидного раннера диагностик (не функция)', () => {
    const registry = new ExtensionRegistry();
    const manifest: ModuleManifest = {
      ...validManifest,
      id: 'test.module.bad-runner-type',
      diagnostics: [{ id: 'diag1', displayName: 'Диагностика' }],
    };

    const res = registry.register(manifest, 'not-a-function' as any);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, 'VALIDATION_FAILED');
    }
  });
});
