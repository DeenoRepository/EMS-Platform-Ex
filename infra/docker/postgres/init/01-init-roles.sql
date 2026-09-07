-- EMS Platform: Инициализация ролей PostgreSQL
-- ems_migration: владелец схем, право на выполнение DDL и управление версиями
-- ems_runtime: DML-only (SELECT, INSERT, UPDATE, DELETE), запрет DDL

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ems_migration') THEN
        CREATE ROLE ems_migration WITH LOGIN PASSWORD 'migration_secret' CREATEDB;
    ELSE
        ALTER ROLE ems_migration WITH LOGIN PASSWORD 'migration_secret' CREATEDB;
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ems_runtime') THEN
        CREATE ROLE ems_runtime WITH LOGIN PASSWORD 'runtime_secret';
    ELSE
        ALTER ROLE ems_runtime WITH LOGIN PASSWORD 'runtime_secret';
    END IF;
END
$$;
