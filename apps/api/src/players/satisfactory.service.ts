import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Game, ServerState, EventType } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { EventsService } from "../events/events.service";
import { containerName } from "../common/naming";
import { GameEndpointService } from "../docker/game-endpoint.service";
import { satisfactoryClaim } from "./satisfactory-api";

const POLL_MS = 60_000;

/**
 * Auto-claims Satisfactory servers. A fresh Satisfactory server is "unclaimed" —
 * normally the first player claims it in-game, choosing the server name + admin
 * password. This poller does that step through the HTTPS API instead, using the
 * server's configured name + admin password (+ join password when set), so a
 * Palisade-created server is immediately joinable with the expected credentials.
 * Claimed servers refuse the InitialAdmin login, making the poll a cheap no-op —
 * which also makes this self-healing across wipes/re-installs.
 */
@Injectable()
export class SatisfactoryService implements OnModuleInit {
  private readonly logger = new Logger(SatisfactoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsService,
    private readonly endpoints: GameEndpointService,
  ) {}

  onModuleInit(): void {
    setInterval(() => void this.poll(), POLL_MS).unref?.();
  }

  private async poll(): Promise<void> {
    const rows = await this.prisma.server
      .findMany({ where: { game: Game.SATISFACTORY, state: ServerState.Running } })
      .catch(() => []);
    for (const s of rows) {
      if (!s.adminPasswordEnc) continue; // nothing to claim with — in-game claim applies
      try {
        const { host, port } = await this.endpoints.resolve(
          s.id,
          s.gamePort,
          containerName(s.id, Game.SATISFACTORY, s.name),
        );
        const result = await satisfactoryClaim(
          host,
          port,
          s.name,
          this.crypto.decrypt(s.adminPasswordEnc),
          s.serverPasswordEnc ? this.crypto.decrypt(s.serverPasswordEnc) : null,
        );
        if (result === "claimed") {
          this.logger.log(`Claimed Satisfactory server ${s.id} ("${s.name}") via the API`);
          await this.events.emit({
            type: EventType.ConfigChanged,
            message: `Satisfactory server claimed as "${s.name}" (admin password set)`,
            serverId: s.id,
          });
        }
      } catch {
        /* API not up yet / mid-boot — the next poll retries */
      }
    }
  }
}
