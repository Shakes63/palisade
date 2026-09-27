import { IsOptional, IsString, MinLength } from "class-validator";

export class LoginBody {
  @IsString() username!: string;
  @IsString() password!: string;
}

export class OidcExchangeBody {
  @IsString() ticket!: string;
}

export class OidcUnlinkBody {
  @IsString() password!: string;
}

export class FirstRunBody {
  @IsString() username!: string;
  @IsString() @MinLength(8) password!: string;
  @IsOptional() @IsString() dataDir?: string;
  @IsOptional() @IsString() curseForgeApiKey?: string;
  @IsOptional() @IsString() steamWebApiKey?: string;
  @IsOptional() @IsString() timezone?: string;
}
