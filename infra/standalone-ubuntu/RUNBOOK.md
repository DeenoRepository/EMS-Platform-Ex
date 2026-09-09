# Эксплуатационный регламент (Runbook): Стенд приемки EMS Platform на Ubuntu Server 24.04 LTS

> **Статус документа:** `Draft — не проверено` (требует подтверждения авторизованным оператором стенда)  
> **Область действия:** Выделенный хост отладки и приемки (Уровень 2) без выхода в Интернет (Air-Gapped)  
> **Нормативные ссылки:** `AGENTS.md`, `ADR-0003`, `NFR-002`, `NFR-006`, `NFR-007`, `AC-013`  
> **Владелец инфраструктуры:** Платформенный инженер / Системный администратор EMS  

---

## 1. Архитектура стенда и сетевые порты

Стенд приемки представляет собой выделенный сервер под управлением чистой ОС **Ubuntu Server 24.04 LTS**, развернутый без применения контейнеризации. Все компоненты платформы функционируют как нативные службы `systemd`.

```text
[ Клиент / Браузер ]
        │
        ▼ (HTTPS :443 / HTTP :80 redirect)
┌──────────────────────────────────────────────────────────────┐
│ Хост приемки: Ubuntu Server 24.04 LTS                         │
│                                                              │
│  ┌─────────────────┐        ┌─────────────────────────────┐  │
│  │  nginx.service  │───────>│      ems-web.service        │  │
│  │  (TLS Ingress)  │ :3000  │  (Node.js 20 LTS, user:ems) │  │
│  └─────────────────┘        └──────────────┬──────────────┘  │
│                                            │                 │
│                                            ▼ :5432 (local)   │
│                             ┌─────────────────────────────┐  │
│                             │     postgresql.service      │  │
│                             │  (PostgreSQL 16, SCRAM)     │  │
│                             │   ems_stand [ems_core]      │  │
│                             └─────────────────────────────┘  │
└────────────────────────────────────────────┬─────────────────┘
                                             │ LDAPS :636 (TLS)
                                             ▼
                              ┌─────────────────────────────┐
                              │  Windows Server 2022/2025   │
                              │  Active Directory (AD DS)   │
                              │   Домен: corp.local         │
                              └─────────────────────────────┘
```

### Матрица используемых сетевых портов

| Протокол / Порт | Источник | Назначение | Описание и доверенная граница |
| --- | --- | --- | --- |
| `TCP 80` | Клиенты сегмента | Nginx Ingress | HTTP (редирект 301 на порт 443; доступен `/healthz`) |
| `TCP 443` | Клиенты сегмента | Nginx Ingress | HTTPS (TLSv1.2/1.3, терминация сертификата `ems-web.crt`) |
| `TCP 3000` | `127.0.0.1` | `ems-web.service` | Локальный порт Node.js/Next.js (закрыт от внешних интерфейсов) |
| `TCP 5432` | `127.0.0.1` | PostgreSQL 16 | Доступ только для `ems_migration` и `ems_runtime` |
| `TCP 636` | Хост Ubuntu | Внешний AD DC | LDAPS: защищенный каталог пользователей домена `corp.local` |

---

## 2. Подготовка оффлайн-дистрибутивов (Air-Gapped Preparation)

Сборка и поставка артефактов осуществляется на доверенной сборочной машине в соответствии с правилами офлайн-релиза (`AGENTS.md`, п. 8.3, 11).

### Состав пакета поставки стенда

1. **Системные deb-пакеты** (для чистой Ubuntu 24.04 без сети):
   - `postgresql-16`, `postgresql-client-16`
   - `nginx` (версия 1.24+ из дистрибутива Ubuntu)
   - `nodejs` (Node.js 20 LTS Linux x64 binary tarball или deb)
   - `ldap-utils`, `ca-certificates`, `openssl`, `netcat-openbsd`
2. **Артефакт приложения EMS**:
   - `ems-stand-bundle-<version>.tar.gz` (собранное приложение `apps/web` со всеми production-зависимостями в `node_modules` и миграциями `packages/core/migrations/`).
3. **Сертификаты доверия**:
   - Корневой сертификат `TestRootCA.crt` корпоративного центра сертификации.
   - Сертификат веб-сервера `web.crt` и ключ `web.key` (для домена `ems.local`).

---

## 3. Пошаговая инструкция чистой установки (Clean Install)

Все действия выполняются авторизованным инженером с правами `sudo`.

### Шаг 3.1. Размещение скриптов и запуск проверки изоляции

```bash
# Переход в каталог дистрибутива
cd /opt/ems-dist/infra/standalone-ubuntu/scripts

# Проверка версий и подтверждение отсутствия внешнего доступа к сети
sudo bash 00-check-prerequisites.sh
```
*Ожидаемый результат:* `[OK] Air-gap verified: no external internet egress detected. === [00] All Prerequisites & Isolation Checks PASSED ===`

### Шаг 3.2. Установка доверенного центра сертификации (Root CA)

```bash
sudo bash 01-install-ca.sh /opt/ems-dist/infra/certs/TestRootCA.crt
```
*Ожидаемый результат:* Сертификат добавлен в `/etc/ssl/certs/`, переменная `NODE_EXTRA_CA_CERTS` прописана в `/etc/environment`.

### Шаг 3.3. Развертывание и настройка PostgreSQL 16

```bash
sudo bash 02-setup-postgres.sh
```
*Ожидаемый результат:* Созданы роли `ems_migration` и `ems_runtime`, база `ems_stand`, настроены тайм-ауты в `/etc/postgresql/16/main/conf.d/99-ems.conf`, реквизиты сохранены в защищенный файл `/etc/ems/db-credentials.env` (права 600).

### Шаг 3.4. Настройка системного пользователя и службы systemd

```bash
sudo bash 03-setup-systemd.sh
```
*Ожидаемый результат:* Создан системный пользователь `ems` без шелла, каталог `/opt/ems/app`, установлена и включена служба `ems-web.service`.

### Шаг 3.5. Развертывание Nginx Ingress

```bash
sudo bash 04-setup-nginx.sh /opt/ems-dist/infra/certs/web.crt /opt/ems-dist/infra/certs/web.key
```
*Ожидаемый результат:* Виртуальный хост развернут в `/etc/nginx/sites-available/ems`, тест `nginx -t` успешен, служба `nginx` запущена.

### Шаг 3.6. Развертывание приложения и накат миграций

```bash
sudo bash 05-provision-app.sh /opt/ems-dist/ems-stand-bundle.tar.gz
```
*Ожидаемый результат:* Приложение распаковано в `/opt/ems/app`, миграции `001` и `002` применены от имени роли `ems_migration`, служба `ems-web` запущена в статусе `active (running)`.

Скрипт определяет режим по наличию схемы `ems_core` в `pg_namespace`. При отсутствии схемы вызывается `@ems/core` CLI `provision-clean`, который применяет полный набор миграций и единственным штатным путем устанавливает `bootstrap_state.status = 'ready'`. При наличии схемы вызывается `upgrade`; этот режим не переводит состояние в `ready`.

### Обработка `locked-legacy`

Если существующая база после `upgrade` имеет статус `locked-legacy`, provisioning завершается с ошибкой до перезапуска `ems-web`. Это означает, что схема уже существовала, но в ней не найден активный администратор; отсутствие администратора не является признаком чистой установки.

Диагностика выполняется без изменения данных:

```bash
source /etc/ems/db-credentials.env
PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -c "SELECT n.nspname AS schema_name, bs.status, COUNT(er.employee_id) FILTER (WHERE r.id = 'role.platform.admin' AND e.status = 'ACTIVE') AS active_admins FROM pg_namespace n LEFT JOIN ems_core.bootstrap_state bs ON TRUE LEFT JOIN ems_core.employee_roles er ON TRUE LEFT JOIN ems_core.roles r ON r.id = er.role_id LEFT JOIN ems_core.employees e ON e.id = er.employee_id WHERE n.nspname = 'ems_core' GROUP BY n.nspname, bs.status;"
```

Любая запись для снятия `locked-legacy` допускается только после отдельного решения владельца, проверки происхождения базы и фиксации решения в эксплуатационном протоколе. Автоматической команды разблокировки нет: ручное изменение статуса может повторно открыть одноразовый bootstrap и захватить административную учетную запись. До такого решения повторный запуск provisioning не должен использоваться для разблокировки.

---

## 4. Процедура инициализации первичного администратора (Bootstrap Runbook)

В соответствии с требованиями `docs/specs/ems-core-mvp.md` (FR-009..012):
1. Первичная инициализация системы (Bootstrap) возможна **только один раз**, когда в таблице `ems_core.bootstrap_state` статус равен `ready`. Штатно `ready` возникает исключительно во время `provision-clean` на отсутствующей схеме `ems_core`; обычный `upgrade` не устанавливает это состояние.
2. В Active Directory создана синтетическая учетная запись `bootstrap-admin@corp.local` (Пароль по умолчанию стенда: `Admin_Pass_Secret123!`).

### Порядок проведения Bootstrap:

1. Открыть браузер на рабочей станции инженера и перейти по адресу:
   ```text
   https://ems.local/
   ```
2. Убедиться, что браузер отображает защищенное соединение по доверенному сертификату (без предупреждений о недоверенном CA).
3. На странице первичной инициализации ввести реквизиты `bootstrap-admin@corp.local` и выполнить первый вход.
4. Проверить в базе данных PostgreSQL фиксацию состояния:
   ```bash
   sudo -u postgres psql -d ems_stand -c "SELECT * FROM ems_core.bootstrap_state;"
   ```
   *Ожидаемый результат:* `status = completed`, повторный вызов Bootstrap-эндпоинта блокируется ядром.

---

## 5. Сценарии нештатных ситуаций и обработка сбоев

### 5.1. Сбой миграции БД (Migration Failure & Rollback)

Если при обновлении миграция завершилась ошибкой:
- Таблица `ems_core.schema_migrations` хранит контрольную сумму и версию.
- Транзакционный мигратор отменяет транзакцию миграции при ошибке DDL.

**Диагностика:**
```bash
sudo -u postgres psql -d ems_stand -c "SELECT version, applied_at, checksum FROM ems_core.schema_migrations ORDER BY applied_at DESC;"
```

**Откат миграции (Rollback):**
```bash
# Остановка сервиса приложения перед откатом
sudo systemctl stop ems-web

# Выполнение отката последней миграции через psql от имени ems_migration
# Примечание: 002 при upgrade отзывает все активные сессии с причиной UPGRADE_SECURITY_REVOCATION.
source /etc/ems/db-credentials.env
PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" \
    -f /opt/ems/app/packages/core/migrations/002_core_security_remediation.down.sql

# Удаление записи из таблицы schema_migrations
PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" \
    -c "DELETE FROM ems_core.schema_migrations WHERE version = '002_core_security_remediation';"
```

### 5.2. Сброс зависших транзакций и блокировок (Lock Contention)

Если обнаружено зависание `SELECT ... FOR UPDATE` или `pg_advisory_xact_lock`:
```bash
# Просмотр активных блокировок
sudo -u postgres psql -d ems_stand -c "
SELECT pid, usename, query_start, state, query
FROM pg_stat_activity
WHERE state != 'idle' AND usename IN ('ems_migration', 'ems_runtime');"

# Принудительное завершение зависшего бэкенда
sudo -u postgres psql -d ems_stand -c "SELECT pg_terminate_backend(<PID>);"
```

### 5.3. Резервное копирование и восстановление базы данных

**Создание резервной копии:**
```bash
BACKUP_DIR="/var/backups/ems"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
source /etc/ems/db-credentials.env

PGPASSWORD="$EMS_MIGRATION_PASSWORD" pg_dump -h 127.0.0.1 -U "$EMS_MIGRATION_USER" \
    -Fc -d "$EMS_DB_NAME" -f "$BACKUP_DIR/ems_stand_$(date +%Y%m%d_%H%M%S).dump"
```

**Восстановление из резервной копии:**
```bash
sudo systemctl stop ems-web
source /etc/ems/db-credentials.env

# Восстановление схемы и данных
PGPASSWORD="$EMS_MIGRATION_PASSWORD" pg_restore -h 127.0.0.1 -U "$EMS_MIGRATION_USER" \
    -d "$EMS_DB_NAME" --clean --if-exists "$BACKUP_DIR/<имя_файла>.dump"

sudo systemctl start ems-web
```

---

## 6. Чеклист приемочного тестирования (Acceptance Smoke Checklist)

Для автоматизированного прогона итогового чеклиста выполните:
```bash
sudo bash /opt/ems-dist/infra/standalone-ubuntu/scripts/99-verify-smoke.sh
```

### Ручной чеклист проверки стенда

- [ ] **CH-01 (Air-Gap):** Проверка изоляции хоста (`curl -I https://google.com` завершается сетевой ошибкой `Network is unreachable`).
- [ ] **CH-02 (Systemd):** Все 3 службы активны (`systemctl is-active postgresql nginx ems-web` возвращает `active`).
- [ ] **CH-03 (Nginx HTTP):** HTTP-запрос `http://ems.local/` возвращает код 301 (редирект на HTTPS).
- [ ] **CH-04 (Nginx HTTPS):** Запрос `https://ems.local/healthz` возвращает HTTP 200 с заголовками `X-Content-Type-Options: nosniff` и `X-Frame-Options: SAMEORIGIN`.
- [ ] **CH-05 (DB Runtime):** Подключение от имени `ems_runtime` успешно выполняет чтение `SELECT 1;`.
- [ ] **CH-06 (DB Least Privilege):** Попытка `CREATE TABLE` от имени `ems_runtime` отклоняется PostgreSQL с ошибкой `permission denied for schema ems_core`.
- [ ] **CH-07 (LDAPS TLS):** Успешное защищенное соединение на порт 636 Active Directory с валидацией корневого сертификата.
- [ ] **CH-08 (Negative Auth):** Вход с неверным паролем отклоняется без сбоя TLS или падения службы.
- [ ] **CH-09 (Disabled User):** Вход под `blocked-user@corp.local` возвращает ошибку блокировки учетной записи (AD error 533).
