import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import { Game } from "@ark/shared";

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
  /** Import only: host path of an existing Saved dir to copy in. */
  @IsOptional() @IsString() savedSourcePath?: string;
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
  @IsOptional() @IsInt() @Min(512) ramLimitMb?: number;
  @IsOptional() @IsNumber() @Min(0.5) cpuLimit?: number;
  @IsOptional() @IsString() adminPassword?: string;
  @IsOptional() @IsString() serverPassword?: string;
  @IsOptional() @IsString() spectatorPassword?: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
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
