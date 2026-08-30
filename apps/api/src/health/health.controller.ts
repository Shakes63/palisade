import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { DockerService } from "../docker/docker.service";
import { GameEndpointService } from "../docker/game-endpoint.service";
import { hostDataDirMismatch, mismatchMessage } from "../config/ensure-host-data-dir";

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
    const missingShared = await this.endpoints.managerMissingSharedNetwork().catch(() => null);
    const network = this.endpoints.sharedNetworkName();
    // Progress note while an install moves off the pre-1.11 "ark-net" network. Not a
    // fault — it clears itself as servers are restarted — but it needs saying, since
    // finishing it is what restores the WebUI link on Unraid custom networks (GH #31).
    const migration = await this.endpoints.migrationNote().catch(() => null);
    const dataDir = hostDataDirMismatch();
    const warnings = [
      ...(missingShared
        ? [
            `The manager container is not attached to the "${network}" network. Game servers on the bridge are reached by IP where possible, but RCON/player counts may fail for containers with unpublished ports. Fix: docker network connect ${network} <manager container>`,
          ]
        : []),
      ...(migration ? [migration] : []),
      // A HOST_DATA_DIR that disagrees with the real /data mount puts every game
      // server somewhere the user never configured (GH #29).
      ...(dataDir ? [mismatchMessage(dataDir.configured, dataDir.detected)] : []),
    ];
    return {
      status: "ok",
      docker: (await this.docker.ping()) ? "connected" : "unreachable",
      ...(warnings.length ? { warnings } : {}),
      time: new Date().toISOString(),
    };
  }
}
