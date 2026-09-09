/**
 * Канонизация идентификатора объекта службы каталога (S2-FR-002).
 *
 * Active Directory хранит `objectGUID` как 16 двоичных байт со смешанным порядком:
 * первые три поля записаны little-endian, оставшиеся два - big-endian. Текстовое
 * представление одного и того же объекта в разных инструментах отличается, поэтому
 * ядро обязано получать одну стабильную форму, пригодную для сравнения и хранения.
 *
 * Канонической формой считается GUID в нижнем регистре без фигурных скобок:
 * `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 */

const CANONICAL_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRACED_GUID = /^\{(.+)\}$/;
const OBJECT_GUID_BYTE_LENGTH = 16;

function toHex(bytes: Uint8Array, start: number, end: number, littleEndian: boolean): string {
  let hex = '';
  if (littleEndian) {
    for (let index = end - 1; index >= start; index -= 1) {
      hex += (bytes[index] as number).toString(16).padStart(2, '0');
    }
    return hex;
  }
  for (let index = start; index < end; index += 1) {
    hex += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Преобразует 16 байт `objectGUID` в каноническую строку GUID.
 * Возвращает `undefined`, если длина не равна 16 байтам.
 */
export function objectGuidFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length !== OBJECT_GUID_BYTE_LENGTH) return undefined;
  const timeLow = toHex(bytes, 0, 4, true);
  const timeMid = toHex(bytes, 4, 6, true);
  const timeHigh = toHex(bytes, 6, 8, true);
  const clockSeq = toHex(bytes, 8, 10, false);
  const node = toHex(bytes, 10, 16, false);
  return `${timeLow}-${timeMid}-${timeHigh}-${clockSeq}-${node}`;
}

/**
 * Приводит значение атрибута службы каталога к канонической форме GUID.
 *
 * Принимаются только два надежных представления:
 * - двоичные 16 байт (`Buffer`/`Uint8Array`), как их возвращает AD;
 * - уже текстовый GUID, при необходимости в фигурных скобках и верхнем регистре.
 *
 * Любое другое значение отклоняется: молчаливая интерпретация испорченной
 * бинарной строки как идентификатора привела бы к подмене личности.
 */
export function normalizeObjectGuid(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return objectGuidFromBytes(value);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const unwrapped = BRACED_GUID.exec(trimmed)?.[1] ?? trimmed;
    const lowered = unwrapped.toLowerCase();
    return CANONICAL_GUID.test(lowered) ? lowered : undefined;
  }

  return undefined;
}
