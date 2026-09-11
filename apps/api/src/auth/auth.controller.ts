import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";
import { MinRole } from "./min-role.decorator";
import { AuthThrottlerGuard } from "./auth-throttler.guard";
import { FirstRunBody, LoginBody } from "./auth.dto";
import { CurrentUser } from "./current-user.decorator";
import type { AuthUser } from "./auth-user";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Whether the first-run wizard still needs to run. */
  @Public()
  @Get("status")
  status() {
    return this.auth.status();
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post("first-run")
  firstRun(@Body() body: FirstRunBody) {
    return this.auth.firstRun(body);
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post("login")
  login(@Body() body: LoginBody) {
    return this.auth.login(body);
  }

  /** Who am I — username, role and server access for the web UI's gating. */
  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }

  /** Invalidate every outstanding token for the calling user (bumps tokenVersion). */
  @MinRole("viewer") // self-service — every role may log itself out everywhere
  @Post("logout-all")
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.sub);
  }
}
