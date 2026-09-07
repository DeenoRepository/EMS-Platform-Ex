-- EMS Platform: Создание баз данных ems_dev и ems_test

SELECT 'CREATE DATABASE ems_dev OWNER ems_migration'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ems_dev')\gexec

SELECT 'CREATE DATABASE ems_test OWNER ems_migration'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ems_test')\gexec

-- Настройка базы данных разработки ems_dev
\connect ems_dev

-- Безопасность: отзыв создания в public у PUBLIC
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Предоставление прав подключения
GRANT CONNECT ON DATABASE ems_dev TO ems_runtime;
GRANT USAGE ON SCHEMA public TO ems_runtime;

-- Настройка default privileges для всех объектов, создаваемых ролью ems_migration
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT USAGE ON SCHEMAS TO ems_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ems_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT USAGE, SELECT ON SEQUENCES TO ems_runtime;

-- Настройка базы данных приемочного тестирования ems_test
\connect ems_test

-- Безопасность: отзыв создания в public у PUBLIC
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Предоставление прав подключения
GRANT CONNECT ON DATABASE ems_test TO ems_runtime;
GRANT USAGE ON SCHEMA public TO ems_runtime;

-- Настройка default privileges для всех объектов, создаваемых ролью ems_migration
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT USAGE ON SCHEMAS TO ems_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ems_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ems_migration GRANT USAGE, SELECT ON SEQUENCES TO ems_runtime;
