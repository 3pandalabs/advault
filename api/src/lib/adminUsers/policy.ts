// Who may change whose role (routes/adminUsers.ts). Pure, so it is tested
// without a database.

export type Role = "advertiser" | "admin";

export type RoleChangeBlock = "same_role" | "own_role" | "last_admin" | "deleted_user" | null;

/**
 * Why a role change must be refused, or null when it may go ahead.
 * - an admin cannot change their own role (no locking yourself out by mistake);
 * - the last admin can never be removed;
 * - a deleted (anonymised) account is never made an admin.
 */
export function roleChangeBlock(args: {
  actorId: string;
  targetId: string;
  targetRole: Role;
  targetDeleted: boolean;
  newRole: Role;
  adminCount: number;
}): RoleChangeBlock {
  if (args.targetRole === args.newRole) return "same_role";
  if (args.actorId === args.targetId) return "own_role";
  if (args.targetDeleted && args.newRole === "admin") return "deleted_user";
  if (args.targetRole === "admin" && args.newRole !== "admin" && args.adminCount <= 1) return "last_admin";
  return null;
}
