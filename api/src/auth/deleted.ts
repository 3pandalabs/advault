// Accounts deleted since this process started (lib/accountDeletion.ts).
// requireAuth refuses their still-valid access tokens; tokens are 15-minute,
// so after a restart nothing older can still be valid anyway.
const deletedIds = new Set<string>();

export function markUserDeleted(userId: string): void {
  deletedIds.add(userId);
}

export function isUserDeleted(userId: string): boolean {
  return deletedIds.has(userId);
}
