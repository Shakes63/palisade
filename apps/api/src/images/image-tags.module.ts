import { Module } from "@nestjs/common";
import { ImageTagsService } from "./image-tags.service";
import { ImageTagsController } from "./image-tags.controller";
import { GameVersionsService } from "./game-versions.service";
import { GameVersionsController } from "./game-versions.controller";

@Module({
  controllers: [ImageTagsController, GameVersionsController],
  providers: [ImageTagsService, GameVersionsService],
})
export class ImageTagsModule {}
