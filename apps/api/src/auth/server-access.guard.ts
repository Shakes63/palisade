import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { AccessService } from "./access.service";
import type { AuthUser } from "./auth-user";

interface RequestLike {
  method: string;
  user?: AuthUser;
  params?: Record<string, string | undefined>;
  /** Express route template, e.g. "/api/servers/:id/start". */
  route?: { path?: string };
}

/** Route templates a restricted user may never call: they create servers
 *  (consuming host ports/disk), which is an admin/unrestricted decision. */
const CREATE_ROUTES = new Set(["/servers", "/servers/import"]);

/**
 * Per-user server/cluster scoping, layered after RolesGuard (GH #73).
 *
 * Handles the common case from the route template alone: anything under
 * `servers/:id` checks the server, anything under `clusters/:id` checks the
 * cluster. Routes that carry the server id elsewhere (schedules by body/query,
 * `DELETE backups/:snapshotId`, cluster membership bodies, copy targets) and
 * list endpoints do their own checks with AccessService + @CurrentUser().
 */
@Injectable()
export class ServerAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  /** Strip the global prefix so tests and the app agree on the template. */
  static normalize(template: string | undefined): string {
    if (!template) return "";
    return template.replace(/^\/api(?=\/|$)/, "");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestLike>();
    if (AccessService.unrestricted(req.user)) return true;

    const path = ServerAccessGuard.normalize(req.route?.path);
    if (req.method === "POST" && CREATE_ROUTES.has(path)) {
      throw new ForbiddenException("Restricted users cannot create servers");
    }
    const id = req.params?.id;
    if (id && (path === "/servers/:id" || path.startsWith("/servers/:id/"))) {
      await this.access.assertServer(req.user, id);
    } else if (id && (path === "/clusters/:id" || path.startsWith("/clusters/:id/"))) {
      await this.access.assertCluster(req.user, id);
    }
    return true;
  }
}
