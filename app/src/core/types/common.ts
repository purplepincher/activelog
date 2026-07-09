import { z } from "zod";

/**
 * Shared primitives every schema in the app builds on. Keeping these in one
 * place means a change to "what counts as a valid timestamp" only happens
 * once. Ported near-verbatim from deckboss — these are domain-neutral by
 * definition.
 */

export const isoDateString = z.string().datetime({ offset: true });

export const uuidV4 = z.string().uuid();

export const SCHEMA_VERSION = "1.0";
