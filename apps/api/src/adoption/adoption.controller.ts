import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { AdoptionService } from "./adoption.service";
import { MinRole } from "../auth/min-role.decorator";

class AdoptBody {
  @IsString() containerId!: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(100) adminPassword?: string;
  @IsOptional() @IsString() @MaxLength(100) serverPassword?: string;
}

@MinRole("admin")
@Controller("adoption")
export class AdoptionController {
  constructor(private readonly adoption: AdoptionService) {}

  @Get("candidates")
  candidates() {
    return this.adoption.candidates();
  }

  @Post()
  adopt(@Body() body: AdoptBody) {
    return this.adoption.adopt(body);
  }
}
