import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { IsArray, IsIn, IsString } from "class-validator";
import { AccessListsService, type AccessListKey } from "./accesslists.service";

class PutListBody {
  @IsIn(["admins", "whitelist", "banned"]) key!: AccessListKey;
  @IsArray() @IsString({ each: true }) entries!: string[];
}

@Controller("servers/:id/accesslists")
export class AccessListsController {
  constructor(private readonly accesslists: AccessListsService) {}

  @Get()
  get(@Param("id") id: string) {
    return this.accesslists.get(id);
  }

  @Put()
  put(@Param("id") id: string, @Body() body: PutListBody) {
    return this.accesslists.put(id, body.key, body.entries);
  }
}
