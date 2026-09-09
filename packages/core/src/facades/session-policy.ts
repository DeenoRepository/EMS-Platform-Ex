/**
 * Централизованная политика времени жизни сессий EMS ядра (S2-FR-004, ADR-0005, ADR-0006).
 *
 * Единый источник истины для login и authorization:
 * - абсолютный deadline: 8 часов;
 * - лимит бездействия (idle TTL): 30 минут;
 * - окно троттлинга продления бездействия: 5 минут.
 */

export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const SESSION_IDLE_RENEW_THROTTLE_MS = 5 * 60 * 1000;
export const SESSION_IDLE_RENEW_THRESHOLD_MS = SESSION_IDLE_TTL_MS - SESSION_IDLE_RENEW_THROTTLE_MS;
