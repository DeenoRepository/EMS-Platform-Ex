-- Migration 002: Исправление безопасности ядра (bootstrap_state, versioning, credential_hash, modules.manage)
CREATE TABLE IF NOT EXISTS ems_core.bootstrap_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status VARCHAR(32) NOT NULL CHECK (status IN ('ready', 'completed', 'locked-legacy')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Инициализация bootstrap_state при upgrade:
-- Обычный upgrade никогда не ставит 'ready'. Если есть активный администратор — 'completed', иначе 'locked-legacy'.
INSERT INTO ems_core.bootstrap_state (id, status)
SELECT 1,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM ems_core.employee_roles er
      JOIN ems_core.employees e ON e.id = er.employee_id
      WHERE er.role_id = 'role.platform.admin' AND e.status = 'ACTIVE'
    ) THEN 'completed'
    ELSE 'locked-legacy'
  END
ON CONFLICT (id) DO NOTHING;

-- Версионирование доступности модулей для compare-and-set (optimistic lock)
ALTER TABLE ems_core.module_availability ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Поддержка credential_hash и маркера формата сессий
ALTER TABLE ems_core.sessions ADD COLUMN IF NOT EXISTS credential_hash VARCHAR(64);
ALTER TABLE ems_core.sessions ADD COLUMN IF NOT EXISTS format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ems_core.sessions ALTER COLUMN format_version SET DEFAULT 2;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_credential_hash ON ems_core.sessions(credential_hash) WHERE credential_hash IS NOT NULL;

-- Отзыв всех старых сессий при upgrade до допуска новых операций
UPDATE ems_core.sessions
SET revoked_at = NOW(),
    revocation_reason = 'UPGRADE_SECURITY_REVOCATION'
WHERE revoked_at IS NULL;

-- Маркер формата в аудите для безопасной маскировки устаревших ID объектов сессий
ALTER TABLE ems_core.audit_log ADD COLUMN IF NOT EXISTS format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ems_core.audit_log ALTER COLUMN format_version SET DEFAULT 2;

-- Явное добавление разрешения modules.manage системной роли администратора
INSERT INTO ems_core.role_permissions (role_id, permission_id)
SELECT 'role.platform.admin', 'modules.manage'
WHERE EXISTS (SELECT 1 FROM ems_core.roles WHERE id = 'role.platform.admin')
ON CONFLICT DO NOTHING;
