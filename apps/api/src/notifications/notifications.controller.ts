import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { EventType, type NotificationKind } from "@ark/shared";
import { NotificationsService } from "./notifications.service";
import { MinRole } from "../auth/min-role.decorator";

class TargetDto {
  @IsString() @MaxLength(64) id!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsIn(["discord", "slack", "ntfy", "webhook"]) kind!: NotificationKind;
  // require_tld off so LAN hosts like http://ntfy:8080 still pass.
  @IsUrl(
    { protocols: ["http", "https"], require_protocol: true, require_tld: false },
    { message: "url must be a full http(s):// URL" },
  )
  @MaxLength(2000)
  url!: string;
  @IsBoolean() enabled!: boolean;
  @IsArray() @IsEnum(EventType, { each: true }) events!: EventType[];
}

export class PutTargetsBody {
  @IsArray() @ValidateNested({ each: true }) @Type(() => TargetDto) targets!: TargetDto[];
}

@MinRole("admin")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list() {
    return { targets: await this.notifications.getTargets() };
  }

  @Put()
  async put(@Body() body: PutTargetsBody) {
    await this.notifications.saveTargets(body.targets);
    return { ok: true };
  }

  @Post("test/:id")
  test(@Param("id") id: string) {
    return this.notifications.test(id);
  }
}
