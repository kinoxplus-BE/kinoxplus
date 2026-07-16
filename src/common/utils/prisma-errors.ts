/** Prisma unique-constraint violation (duplicate key), without depending on
 * generated-client internals. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/** Column names involved in a P2002, e.g. ['username']. Empty when unknown. */
export function uniqueViolationTarget(err: unknown): string[] {
  if (typeof err === 'object' && err !== null && 'meta' in err) {
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target))
      return target.filter((t) => typeof t === 'string');
  }
  return [];
}
