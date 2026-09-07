/**
 * One place that turns a failed service call into something to show a person.
 *
 * Every service fails by throwing `ServiceError` and nothing else, so a caller can map
 * a code onto a status without reading message text. Doing that once, here, is what
 * stops each handler inventing its own vocabulary of failure.
 */

import { ServiceError, type ServiceErrorCode } from "../lib/services/context";

const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  rate_limited: 429,
};

export function httpStatusFor(code: ServiceErrorCode): number {
  return STATUS[code];
}

export interface PresentedError {
  status: number;
  code: ServiceErrorCode | "internal";
  /** Safe to render. */
  message: string;
}

/**
 * The service layer writes its messages for people to read — "Opening a Conversation
 * needs a Verification Level of vouched or better" — so they are passed through rather
 * than replaced with something vaguer.
 *
 * Anything that is not a `ServiceError` is a bug, and its message is replaced. An
 * unexpected error's text is written for whoever is debugging it and routinely carries
 * a host, a query, or a connection string; showing that to a visitor turns a crash into
 * a disclosure.
 */
export function presentServiceError(error: unknown): PresentedError {
  if (error instanceof ServiceError) {
    return { status: httpStatusFor(error.code), code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "internal",
    message: "Something went wrong on this Instance. Nothing you did caused it.",
  };
}
