-- Rollback Migration 001: Удаление схемы ядра EMS (ems_core)
DROP TABLE IF EXISTS ems_core.audit_log CASCADE;
DROP TABLE IF EXISTS ems_core.sessions CASCADE;
DROP TABLE IF EXISTS ems_core.module_availability CASCADE;
DROP TABLE IF EXISTS ems_core.employee_roles CASCADE;
DROP TABLE IF EXISTS ems_core.employees CASCADE;
DROP TABLE IF EXISTS ems_core.role_permissions CASCADE;
DROP TABLE IF EXISTS ems_core.roles CASCADE;
DROP TABLE IF EXISTS ems_core.schema_migrations CASCADE;
DROP TABLE IF EXISTS ems_core.departments CASCADE;
DROP SCHEMA IF EXISTS ems_core CASCADE;
