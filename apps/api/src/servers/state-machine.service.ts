import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ServerState, canTransition, EventType, RealtimeTopic } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

const stateData = (to: ServerState) => ({
  state: to,
  runningSince: to === ServerState.Running ? new Date() : null,
});

/**
 * The ONLY way a server's state changes. Rejects illegal transitions and writes
 * an EventLog entry + realtime broadcast for every legal one (PLANNING.md).
 */
@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async transition(
    serverId: string,
    to: ServerState,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new BadRequestException("Server not found");
    const from = server.state as ServerState;
    if (from === to) return;
    if (!canTransition(from, to)) {
      throw new BadRequestException(`Illegal transition ${from} → ${to}`);
    }

    await this.prisma.server.update({ where: { id: serverId }, data: stateData(to) });
    this.realtime.broadcast({
      topic: RealtimeTopic.ServerState,
      serverId,
      payload: { state: to, from },
      at: new Date().toISOString(),
    });
    await this.events.emit({
      type: EventType.StateTransition,
      message: `${server.name}: ${from} → ${to}`,
      serverId,
      data: { from, to, ...data },
    });
    this.logger.log(`${serverId}: ${from} → ${to}`);
  }

  /**
   * Reconciliation only: snap the persisted state to observed reality, bypassing
   * the transition rules. Used on manager restart to adopt a still-running
   * container (e.g. Stopped→Running) or to mark a vanished one Stopped/Crashed —
   * neither of which is a legal lifecycle transition. Still logs an event.
   */
  async force(serverId: string, to: ServerState, reason: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;
    const from = server.state as ServerState;
    if (from === to) return;
    await this.prisma.server.update({ where: { id: serverId }, data: stateData(to) });
    this.realtime.broadcast({
      topic: RealtimeTopic.ServerState,
      serverId,
      payload: { state: to, from },
      at: new Date().toISOString(),
    });
    await this.events.emit({
      type: EventType.StateTransition,
      message: `${server.name}: ${from} → ${to} (reconcile: ${reason})`,
      serverId,
      data: { from, to, reconcile: true },
    });
    this.logger.log(`${serverId}: ${from} → ${to} (reconcile: ${reason})`);
  }

  async current(serverId: string): Promise<ServerState> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!s) throw new BadRequestException("Server not found");
    return s.state as ServerState;
  }
}
