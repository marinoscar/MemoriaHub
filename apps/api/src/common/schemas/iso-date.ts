import { z } from 'zod';

/**
 * Zod schema for a date-time field in **response** DTOs.
 *
 * Emits `{ type: 'string', format: 'date-time' }` in JSON Schema, which
 * `toJSONSchema` (called by nestjs-zod during Swagger document generation)
 * can represent without throwing the "Date cannot be represented in JSON
 * Schema" error that `z.date()` triggers in zod v4.
 *
 * These response DTOs are used solely for `@ApiResponse({ type: ... })`
 * Swagger typing — no runtime re-parsing of response objects through Zod
 * occurs (no ZodSerializerInterceptor is registered). Services return JS
 * `Date` objects from Prisma, which NestJS/Fastify serialises via
 * JSON.stringify → Date#toISOString(), producing an ISO 8601 UTC string
 * that satisfies this schema in documentation.
 */
export const isoDateTime = z.iso.datetime();

/**
 * Zod schema for a date-time field in **request** DTOs (body / query params).
 *
 * On the input side callers send ISO 8601 strings; this schema validates the
 * string format and then pipes it through `z.coerce.date()` so the parsed
 * value is a JS `Date` that Prisma can consume directly.
 *
 * In JSON Schema (io: 'input') this emits `{ type: 'string', format:
 * 'date-time' }` — representable without errors — while preserving the
 * `Date` output type that services expect.
 */
export const isoDateTimeInput = z.iso.datetime().pipe(z.coerce.date());
