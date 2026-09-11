import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "./auth-user";

/** The authenticated caller, as populated by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
