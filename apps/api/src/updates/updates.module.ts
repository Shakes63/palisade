import { Module } from "@nestjs/common";
import { UpdatesService } from "./updates.service";
import { ImageTagsModule } from "../images/image-tags.module";

@Module({
  // ImageTagsModule for the cached registry tag list — the update notification names
  // the versioned tag a new image corresponds to (GH #26).
  imports: [ImageTagsModule],
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}
