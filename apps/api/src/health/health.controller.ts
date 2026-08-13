import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { DockerService } from "../docker/docker.service";
import { GameEndpointService } from "../docker/game-endpoint.service";
import { ARK_NETWORK } from "../common/naming";

@Controller("health")
export class HealthController {
  constructor(
    private readonly docker: DockerService,
    private readonly endpoints: GameEndpointService,
  ) {}

  @Public()
  @Get()
  async health() {
    // A manager that isn't on ark-net can still run every container, but can't
    // resolve them by name — which used to surface only as an opaque RCON DNS
    // error (GH #21). Say so up front. Null = we couldn't tell; stay quiet.
    const missingArkNet = await this.endpoints.managerMissingArkNet().catch(() => null);
    return {
      status: "ok",
      docker: (await this.docker.ping()) ? "connected" : "unreachable",
      ...(missingArkNet
        ? {
            warnings: [
              `The manager container is not attached to the "${ARK_NETWORK}" network. Game servers on the bridge are reached by IP where possible, but RCON/player counts may fail for containers with unpublished ports. Fix: docker network connect ${ARK_NETWORK} <manager container>`,
            ],
          }
        : {}),
      time: new Date().toISOString(),
    };
  }
}
