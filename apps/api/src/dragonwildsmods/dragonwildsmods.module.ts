import { Module } from "@nestjs/common";
import { DragonwildsModsController } from "./dragonwildsmods.controller";
import { DragonwildsModsService } from "./dragonwildsmods.service";

@Module({
  controllers: [DragonwildsModsController],
  providers: [DragonwildsModsService],
})
export class DragonwildsModsModule {}
