import { Module } from "@nestjs/common";
import { ClustersService } from "./clusters.service";
import { ClustersController } from "./clusters.controller";
import { ServersModule } from "../servers/servers.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [ServersModule, AuthModule],
  controllers: [ClustersController],
  providers: [ClustersService],
  exports: [ClustersService],
})
export class ClustersModule {}
