import { describe, expect, it } from "vitest";
import { roleChangeBlock } from "./policy.js";

const base = { actorId: "a", targetId: "b", targetRole: "advertiser" as const, targetDeleted: false, newRole: "admin" as const, adminCount: 1 };

describe("roleChangeBlock", () => {
  it("lets an admin promote another user", () => {
    expect(roleChangeBlock(base)).toBeNull();
  });
  it("lets an admin demote another admin when one would remain", () => {
    expect(roleChangeBlock({ ...base, targetRole: "admin", newRole: "advertiser", adminCount: 2 })).toBeNull();
  });
  it("refuses changing your own role", () => {
    expect(roleChangeBlock({ ...base, targetId: "a", targetRole: "admin", newRole: "advertiser", adminCount: 3 })).toBe("own_role");
  });
  it("never removes the last admin", () => {
    expect(roleChangeBlock({ ...base, targetRole: "admin", newRole: "advertiser", adminCount: 1 })).toBe("last_admin");
  });
  it("never promotes a deleted account", () => {
    expect(roleChangeBlock({ ...base, targetDeleted: true })).toBe("deleted_user");
  });
  it("reports a no-op", () => {
    expect(roleChangeBlock({ ...base, targetRole: "admin" })).toBe("same_role");
  });
});
