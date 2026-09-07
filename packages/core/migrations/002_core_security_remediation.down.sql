-- Rollback Migration 002: Откат изменений безопасности ядра
DELETE FROM ems_core.role_permissions WHERE role_id = 'role.platform.admin' AND permission_id = 'modules.manage';
ALTER TABLE ems_core.audit_log DROP COLUMN IF EXISTS format_version;
DROP INDEX IF EXISTS ems_core.uq_sessions_credential_hash;
ALTER TABLE ems_core.sessions DROP COLUMN IF EXISTS format_version;
ALTER TABLE ems_core.sessions DROP COLUMN IF EXISTS credential_hash;
ALTER TABLE ems_core.module_availability DROP COLUMN IF EXISTS version;
DROP TABLE IF EXISTS ems_core.bootstrap_state;
