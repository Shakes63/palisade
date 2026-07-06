import { Module } from "@nestjs/common";
import { IcarusModsController } from "./icarusmods.controller";
import { IcarusModsService } from "./icarusmods.service";

@Module({
  controllers: [IcarusModsController],
  providers: [IcarusModsService],
})
export class IcarusModsModule {}
