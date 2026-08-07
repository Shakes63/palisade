import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { Game } from "@ark/shared";
import { IMAGE_TAG_RE } from "../common/images";

/** Validated representation of a single user-defined env var. */
export class EnvVarItem {
  /** Keys must follow POSIX variable-name rules so they're safe inside a Docker
   *  env array (no shell expansion is involved, but junk keys confuse images). */
  @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, { message: "key must be a valid env var name (letters, digits, underscores; cannot start with a digit)" })
  key!: string;

  /** No null bytes; arbitrary printable string up to 4096 chars. */
  @IsString()
  @Matches(/^[^\x00]{0,4096}$/, { message: "value must not contain null bytes and must be ≤4096 characters" })
  value!: string;
}

/** Reusable: an optional, validated Docker image tag (null clears the pin). */
const ImageTagField = () =>
  Matches(IMAGE_TAG_RE, { message: "imageTag must be a valid Docker tag (letters, digits, . _ -)" });

export class CreateServerBody {
  @IsString() name!: string;
  @IsIn(Object.values(Game)) game!: Game; // every supported game (ASA, ASE, CONAN, …)
  @IsString() map!: string;
  @IsOptional() @IsInt() @Min(1) maxPlayers?: number;
  @IsOptional() @IsString() clusterId?: string | null;
  @IsOptional() @IsArray() modIds?: number[];
  @IsOptional() @IsInt() @Min(512) ramLimitMb?: number;
  @IsOptional() @IsNumber() @Min(0.5) cpuLimit?: number;
  @IsOptional() @IsString() adminPassword?: string;
  @IsOptional() @IsString() serverPassword?: string;
  @IsOptional() @IsString() spectatorPassword?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  /** Advanced: pin the game image to a specific tag instead of the shipped default. */
  @IsOptional() @ImageTagField() imageTag?: string | null;
  /** Import only: host path of an existing Saved dir to copy in. */
  @IsOptional() @IsString() savedSourcePath?: string;
  /** User-defined extra env vars injected into the game container. */
  @IsOptional() @IsArray() @ArrayMaxSize(64) @ValidateNested({ each: true }) @Type(() => EnvVarItem) extraEnv?: EnvVarItem[];
}

export class UpdateServerBody {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() map?: string;
  @IsOptional() @IsInt() @Min(1) maxPlayers?: number;
  @IsOptional() @IsInt() @Min(1024) gamePort?: number;
  @IsOptional() @IsInt() @Min(1024) queryPort?: number;
  @IsOptional() @IsInt() @Min(1024) rconPort?: number;
  @IsOptional() @IsString() clusterId?: string | null;
  @IsOptional() @IsArray() modIds?: number[];
  /** 0 clears the limit (unlimited). */
  @IsOptional() @IsInt() @Min(0) ramLimitMb?: number;
  @IsOptional() @IsNumber() @Min(0) cpuLimit?: number;
  @IsOptional() @IsString() adminPassword?: string;
  @IsOptional() @IsString() serverPassword?: string;
  @IsOptional() @IsString() spectatorPassword?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  /** Advanced: pin the game image to a specific tag (null clears the pin). */
  @IsOptional() @ImageTagField() imageTag?: string | null;
  /** User-defined extra env vars injected into the game container. */
  @IsOptional() @IsArray() @ArrayMaxSize(64) @ValidateNested({ each: true }) @Type(() => EnvVarItem) extraEnv?: EnvVarItem[];
}

export class RconBody {
  @IsString() command!: string;
}

export class PlayerActionBody {
  @IsString() playerId!: string;
}

export class BroadcastBody {
  @IsString() message!: string;
}
