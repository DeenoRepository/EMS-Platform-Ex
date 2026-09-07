-- Migration 001: Инициализация схемы ядра EMS (ems_core)
CREATE SCHEMA IF NOT EXISTS ems_core;

-- Отделы
CREATE TABLE IF NOT EXISTS ems_core.departments (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Роли
CREATE TABLE IF NOT EXISTS ems_core.roles (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Разрешения ролей
CREATE TABLE IF NOT EXISTS ems_core.role_permissions (
    role_id VARCHAR(64) NOT NULL REFERENCES ems_core.roles(id) ON DELETE CASCADE,
    permission_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (role_id, permission_id)
);

-- Сотрудники
CREATE TABLE IF NOT EXISTS ems_core.employees (
    id VARCHAR(64) PRIMARY KEY,
    directory_id VARCHAR(64) NOT NULL,
    object_guid VARCHAR(64) NOT NULL,
    upn VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'BLOCKED')),
    department_id VARCHAR(64) REFERENCES ems_core.departments(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_directory_guid UNIQUE (directory_id, object_guid)
);

CREATE INDEX IF NOT EXISTS idx_employees_upn ON ems_core.employees(upn);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON ems_core.employees(department_id);

-- Назначения ролей сотрудникам
CREATE TABLE IF NOT EXISTS ems_core.employee_roles (
    employee_id VARCHAR(64) NOT NULL REFERENCES ems_core.employees(id) ON DELETE CASCADE,
    role_id VARCHAR(64) NOT NULL REFERENCES ems_core.roles(id) ON DELETE RESTRICT,
    PRIMARY KEY (employee_id, role_id)
);

-- Доступность модулей отделам
CREATE TABLE IF NOT EXISTS ems_core.module_availability (
    module_id VARCHAR(128) NOT NULL,
    department_id VARCHAR(64) NOT NULL REFERENCES ems_core.departments(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (module_id, department_id)
);

-- Сессии сотрудников
CREATE TABLE IF NOT EXISTS ems_core.sessions (
    id VARCHAR(128) PRIMARY KEY,
    employee_id VARCHAR(64) NOT NULL REFERENCES ems_core.employees(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    idle_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee_active ON ems_core.sessions(employee_id) WHERE revoked_at IS NULL;

-- Журнал аудита
CREATE TABLE IF NOT EXISTS ems_core.audit_log (
    id VARCHAR(64) PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    subject_id VARCHAR(64) NOT NULL,
    action VARCHAR(128) NOT NULL,
    object_type VARCHAR(128) NOT NULL,
    object_id VARCHAR(128) NOT NULL,
    result VARCHAR(32) NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
    correlation_id VARCHAR(64),
    details JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON ems_core.audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON ems_core.audit_log(subject_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON ems_core.audit_log(action, timestamp DESC);
