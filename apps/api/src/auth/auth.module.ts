import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthController } from "./auth.controller";
import { UsersController } from "./users.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { ServerAccessGuard } from "./server-access.guard";
import { AccessService } from "./access.service";
import { AuthThrottlerGuard } from "./auth-throttler.guard";
import { loadEnv } from "../config/env";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: loadEnv().JWT_SECRET,
    }),
    // Only enforced where AuthThrottlerGuard is applied (login/first-run) —
    // deliberately NOT a global guard: dashboards poll /servers every 5s.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
  ],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    AccessService,
    AuthThrottlerGuard,
    // Protect every route by default; opt out with @Public(). RolesGuard layers
    // on top (registration order matters — it reads req.user set by the JWT guard):
    // GET = any role, mutations = operator+, @MinRole overrides per route.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Per-user server/cluster scoping (GH #73), after roles so a viewer's
    // forbidden mutation is still reported as a role problem, not a 404.
    { provide: APP_GUARD, useClass: ServerAccessGuard },
  ],
  exports: [AuthService, AccessService],
})
export class AuthModule {}
