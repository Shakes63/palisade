import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { OidcService } from "./oidc.service";
import { Public } from "./public.decorator";
import { MinRole } from "./min-role.decorator";
import { AuthThrottlerGuard } from "./auth-throttler.guard";
import { FirstRunBody, LoginBody, OidcExchangeBody, OidcUnlinkBody } from "./auth.dto";
import { CurrentUser } from "./current-user.decorator";
import type { AuthUser } from "./auth-user";

/** The slices of Express's request/response the SSO redirects use. */
type CookieRequest = { headers: { cookie?: string; origin?: string } };
type RedirectResponse = {
  cookie(name: string, value: string, opts: Record<string, unknown>): void;
  clearCookie(name: string, opts: Record<string, unknown>): void;
  redirect(status: number, url: string): void;
};

const FLOW_COOKIE = "palisade_oidc";
const FLOW_COOKIE_PATH = "/api/auth/oidc";

function readCookie(req: CookieRequest, name: string): string | undefined {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly oidc: OidcService,
  ) {}

  /** Whether the first-run wizard still needs to run, and how the login page offers SSO. */
  @Public()
  @Get("status")
  async status() {
    return { ...(await this.auth.status()), ...(await this.oidc.loginOptions()) };
  }

  /** The redirect URI an admin registers at the provider. */
  @MinRole("admin")
  @Get("oidc/redirect-uri")
  async oidcRedirectUri() {
    return { redirectUri: await this.oidc.redirectUri() };
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post("oidc/start")
  oidcStart(@Req() req: CookieRequest, @Res({ passthrough: true }) res: RedirectResponse) {
    return this.startOidc(req, res);
  }

  /** Start an SSO round trip that links the provider account to the calling user. */
  @MinRole("viewer")
  @Post("oidc/link")
  oidcLink(
    @CurrentUser() user: AuthUser,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: RedirectResponse,
  ) {
    return this.startOidc(req, res, user.sub);
  }

  @MinRole("viewer")
  @UseGuards(AuthThrottlerGuard)
  @Post("oidc/unlink")
  async oidcUnlink(@CurrentUser() user: AuthUser, @Body() body: OidcUnlinkBody) {
    await this.auth.unlinkOidc(user.sub, body.password);
    return { ok: true };
  }

  /** The provider redirects the browser here; it leaves with a ticket for the web UI. */
  @Public()
  @Get("oidc/callback")
  async oidcCallback(
    @Query("state") state: string | undefined,
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Req() req: CookieRequest,
    @Res() res: RedirectResponse,
  ) {
    const cookieState = readCookie(req, FLOW_COOKIE);
    res.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
    // A signed-in user linking their account would be bounced off /login.
    const returnTo = state && this.oidc.isLinkFlow(state) ? "/" : "/login";
    let target: string;
    try {
      const result = await this.oidc.complete(state, cookieState, code, errorDescription || error);
      target = `${returnTo}#sso=${"ticket" in result ? result.ticket : "linked"}`;
    } catch (e) {
      target = `${returnTo}#sso_error=${encodeURIComponent((e as Error).message)}`;
    }
    res.redirect(302, target);
  }

  @Public()
  @UseGuards(AuthThrottlerGuard)
  @Post("oidc/exchange")
  oidcExchange(@Body() body: OidcExchangeBody) {
    return this.oidc.redeem(body.ticket);
  }

  private async startOidc(
    req: CookieRequest,
    res: RedirectResponse,
    linkUserId?: string,
  ): Promise<{ url: string }> {
    const { url, state } = await this.oidc.begin(linkUserId, req.headers.origin);
    res.cookie(FLOW_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      path: FLOW_COOKIE_PATH,
      maxAge: 10 * 60_000,
      secure: (await this.oidc.redirectUri()).startsWith("https:"),
    });
    return { url };
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
