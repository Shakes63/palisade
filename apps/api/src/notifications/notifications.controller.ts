import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { EventType, type NotificationKind } from "@ark/shared";
import { NotificationsService } from "./notifications.service";

class TargetDto {
  @IsString() @MaxLength(64) id!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsIn(["discord", "slack", "ntfy", "webhook"]) kind!: NotificationKind;
  @IsString() @MaxLength(2000) url!: string;
  @IsBoolean() enabled!: boolean;
  @IsArray() @IsEnum(EventType, { each: true }) events!: EventType[];
}

class PutTargetsBody {
  @IsArray() @ValidateNested({ each: true }) @Type(() => TargetDto) targets!: TargetDto[];
}

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
