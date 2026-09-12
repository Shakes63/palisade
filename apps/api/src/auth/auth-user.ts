import type { Role } from "@ark/shared";

/**
 * What JwtAuthGuard leaves on `req.user` (and the realtime gateway on
 * `socket.data.user`): the JWT claims plus the DB-backed `restricted` flag, which
 * is looked up per request (alongside tokenVersion) so an admin's access edits
 * apply immediately instead of at the next login.
 */
export interface AuthUser {
  sub: string;
  username?: string;
  /** Legacy single-admin tokens carry no role and count as admin. */
  role?: Role;
  ver: number;
  restricted: boolean;
}
