import { Global, Module } from "@nestjs/common";
import { DockerService } from "./docker.service";
import { GameEndpointService } from "./game-endpoint.service";

@Global()
@Module({
  providers: [DockerService, GameEndpointService],
  exports: [DockerService, GameEndpointService],
})
export class DockerModule {}
