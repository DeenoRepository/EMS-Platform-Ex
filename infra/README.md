# Инфраструктура отладочного стенда EMS Platform

Настоящий каталог содержит конфигурации, сценарии автоматизации и регламенты для двухуровневой инфраструктуры отладки и приемки EMS Platform в соответствии с требованиями `ADR-0003`, `NFR-002`, `NFR-006..007` и `AC-013`.

---

## Архитектура: Двухуровневая модель

### Уровень 1: Локальный Docker-стенд (Local Dev/Debug)
Предназначен для ежедневной разработки, локальной отладки и запуска интеграционных тестов ядра:
- **PostgreSQL 16**: инициализация баз `ems_dev` и `ems_test`, схем и разделенных ролей `ems_migration` и `ems_runtime`.
- **Samba 4 Active Directory DC**: эмуляция Microsoft Active Directory (домен `corp.local`), бинарный `objectGUID`, `userPrincipalName`, LDAPS (порт 636) со строгой проверкой TLS.
- **Nginx Ingress**: локальный reverse proxy для проверки HTTPS (порт 443), HSTS и заголовков безопасности.

### Уровень 2: Выделенный изолированный стенд (Standalone Ubuntu 24.04 LTS)
Предназначен для приемочных испытаний (Acceptance Gate) на чистой ОС без контейнеров:
- Системные службы `systemd`: `postgresql.service`, `nginx.service`, `ems-web.service`.
- Внешний контроллер домена Microsoft Active Directory на Windows Server.
- Полная изоляция от сети Интернет (Air-Gapped контур).

---

## Структура каталогов

```text
infra/
├── README.md                                    # Настоящее руководство
├── certs/                                       # Инфраструктура доверия и сертификатов
│   ├── generate-certs.ps1 / generate-certs.sh   # Генераторы тестового Root CA и сертификатов
│   └── openssl.cnf                              # Конфигурация SAN (DNS, IP)
├── docker/                                      # [Уровень 1] Локальный Docker-стенд
│   ├── docker-compose.yml                       # Сервисы postgres, samba-ad, nginx
│   ├── .env.example                             # Шаблон переменных окружения
│   ├── postgres/                                # Dockerfile и SQL-скрипты инициализации ролей и баз
│   ├── samba-ad/                                # Dockerfile Samba 4 AD DC и скрипты наполнения
│   ├── nginx/                                   # Конфигурация локального reverse proxy
│   └── scripts/
│       ├── stand-up.ps1 / stand-up.sh           # Запуск стенда и ожидание готовности healthcheck
│       ├── stand-down.ps1 / stand-down.sh       # Останов стенда и очистка томов
│       └── run-acceptance.ps1 / run-acceptance.sh # Прогон приемочного теста PostgreSQL
└── standalone-ubuntu/                           # [Уровень 2] Стенд приемки Ubuntu 24.04 LTS
    ├── RUNBOOK.md                               # Подробный эксплуатационный регламент
    ├── configs/                                 # Сниппеты postgresql.conf, pg_hba.conf, nginx, systemd
    ├── scripts/                                 # Скрипты пошаговой установки и верификации (00..99)
    └── windows-ad-scripts/
        └── setup-test-ad.ps1                    # Скрипт подготовки AD на Windows Server
```

---

## Быстрый старт: Уровень 1 (Локальный Docker-стенд)

### 1. Генерация сертификатов

```powershell
# Windows (PowerShell)
& .\infra\certs\generate-certs.ps1

# Linux / macOS (Bash)
bash ./infra/certs/generate-certs.sh
```

### 2. Запуск локального стенда

```powershell
# Windows (PowerShell)
& .\infra\docker\scripts\stand-up.ps1

# Linux / macOS (Bash)
bash ./infra/docker/scripts/stand-up.sh
```
Скрипт автоматически запустит сборку образов, поднимет контейнеры и дождется прохождения проверок работоспособности (Healthcheck) на портах 5432, 636 и 443.

### 3. Запуск реального интеграционного теста PostgreSQL

```powershell
# Windows (PowerShell)
& .\infra\docker\scripts\run-acceptance.ps1

# Linux / macOS (Bash)
bash ./infra/docker/scripts/run-acceptance.sh
```
Команда выполнит сквозной цикл DDL (clean install -> rollback -> re-apply) и проверку конкурентной вставки на изолированной PostgreSQL.

### 4. Останов стенда

```powershell
# Windows (PowerShell)
& .\infra\docker\scripts\stand-down.ps1

# Linux / macOS (Bash)
bash ./infra/docker/scripts/stand-down.sh
```

---

## Справочник синтетических учетных записей (Baseline)

Все учетные записи являются синтетическими и изолированными (`AGENTS.md`, п. 1):

| UPN | Отображаемое имя | Пароль по умолчанию | Назначение |
| --- | --- | --- | --- |
| `svc_ems_ldap@corp.local` | EMS LDAP Service Account | `Ldap_Service_Secret123!` | Сервисный read-only bind для поиска пользователей |
| `bootstrap-admin@corp.local` | Администратор Платформы | `Admin_Pass_Secret123!` | Первичная инициализация системы (Bootstrap) |
| `regular-user@corp.local` | Иванов Иван Иванович | `User_Pass_Secret123!` | Штатный активный пользователь с назначенными ролями |
| `pending-user@corp.local` | Петров Петр Сергеевич | `Pending_Pass_Secret123!` | Первый вход в систему (сотрудник без назначений) |
| `blocked-user@corp.local` | Сидоров Сидор Сидорович | `Blocked_Pass_Secret123!` | Заблокированный в каталоге сотрудник (AD error 533) |

---

## Развертывание Уровня 2 (Standalone Ubuntu 24.04 LTS)

Подробное руководство по установке на чистый сервер без доступа к сети Интернет приведено в:
👉 **[`infra/standalone-ubuntu/RUNBOOK.md`](./standalone-ubuntu/RUNBOOK.md)**
