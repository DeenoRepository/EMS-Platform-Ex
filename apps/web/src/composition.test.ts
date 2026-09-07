import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAppComposition } from './index.js';
import { DEMO_MODULE_ID } from '@ems/demo-module';
import { DIAGNOSTIC_EXTENSION_ID } from '@ems/diagnostic-extension';

describe('AppComposition integration tests', () => {
  test('композиция успешно инициализирует реестр и регистрирует модули', () => {
    const app = createAppComposition();

    const demoModule = app.registry.getModule(DEMO_MODULE_ID);
    assert.ok(demoModule, 'Демо-модуль должен быть зарегистрирован');
    assert.equal(demoModule?.manifest.displayName, 'Демо-каталог производства');

    const diagModule = app.registry.getModule(DIAGNOSTIC_EXTENSION_ID);
    assert.ok(diagModule, 'Диагностическое расширение должно быть зарегистрировано');
  });

  test('выполнение диагностики здоровья системы возвращает SUBSYSTEMS_OPERATIONAL', async () => {
    const app = createAppComposition();

    const diagResult = await app.registry.runDiagnostic(
      DIAGNOSTIC_EXTENSION_ID,
      'system-health',
    );

    assert.equal(diagResult.status, 'ok');
    assert.equal(diagResult.detailCode, 'SUBSYSTEMS_OPERATIONAL');
  });

  test('фильтрация навигации скрывает пункты без соответствующих разрешений', () => {
    const app = createAppComposition();

    // Пользователь без разрешений
    const emptyNav = app.getNavigationForUser([]);
    assert.equal(emptyNav.length, 0);

    // Пользователь с разрешением demo-catalog.view
    const userNav = app.getNavigationForUser(['demo-catalog.view']);
    assert.equal(userNav.length, 1);
    assert.equal(userNav[0]?.label, 'Демо-каталог');
    assert.equal(userNav[0]?.path, '/demo-catalog');
  });
});
