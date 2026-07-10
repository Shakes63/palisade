import { Module } from "@nestjs/common";
import { AdoptionService } from "./adoption.service";
import { AdoptionController } from "./adoption.controller";
import { ServersModule } from "../servers/servers.module";

@Module({
  imports: [ServersModule],
  controllers: [AdoptionController],
  providers: [AdoptionService],
})
export class AdoptionModule {}
