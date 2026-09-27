import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import { ROLES, type Role } from "@ark/shared";
import { AuthService } from "./auth.service";
import { MinRole } from "./min-role.decorator";
import { CurrentUser } from "./current-user.decorator";
import type { AuthUser } from "./auth-user";

/** Role + per-server access (GH #73). Grants only matter when `restricted`. */
class UserAccessBody {
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsBoolean() restricted?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) serverIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) clusterIds?: string[];
}

class CreateUserBody extends UserAccessBody {
  @IsString() username!: string;
  @IsString() @MinLength(8) password!: string;
}

@MinRole("admin")
@Controller("users")
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list() {
    return this.auth.listUsers();
  }

  @Post()
  create(@Body() body: CreateUserBody) {
    const { username, password, ...access } = body;
    return this.auth.createUser(username, password, access);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UserAccessBody) {
    return this.auth.updateUser(id, body);
  }

  @Delete(":id/sso")
  async unlinkSso(@CurrentUser() me: AuthUser, @Param("id") id: string) {
    if (id === me.sub) throw new BadRequestException("Unlink your own SSO account from the account menu");
    await this.auth.unlinkOidc(id);
    return { ok: true };
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.auth.deleteUser(id);
  }
}
