import { Module } from "@nestjs/common";
import { BedrockModsController } from "./bedrockmods.controller";
import { BedrockModsService } from "./bedrockmods.service";

@Module({
  controllers: [BedrockModsController],
  providers: [BedrockModsService],
})
export class BedrockModsModule {}
