import { Module } from "@nestjs/common";
import { AccessListsController } from "./accesslists.controller";
import { AccessListsService } from "./accesslists.service";

@Module({
  controllers: [AccessListsController],
  providers: [AccessListsService],
})
export class AccessListsModule {}
