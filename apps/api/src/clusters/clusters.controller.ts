import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";
import { ClustersService } from "./clusters.service";
import { AccessService } from "../auth/access.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/auth-user";

class CreateClusterBody {
  @IsString() name!: string;
  @IsOptional() @IsString() clusterId?: string;
}
class AddMemberBody {
  @IsString() serverId!: string;
}

@Controller("clusters")
export class ClustersController {
  constructor(
    private readonly clusters: ClustersService,
    private readonly access: AccessService,
  ) {}

  /** Restricted users (GH #73) see a cluster when it was granted to them or any
   *  member is visible; a partially visible cluster lists only visible members. */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const [allowed, granted] = await Promise.all([
      this.access.allowedServerIds(user),
      this.access.grantedClusterIds(user),
    ]);
    return this.clusters.list(allowed, granted);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.clusters.get(id);
  }

  @Post()
  create(@Body() body: CreateClusterBody) {
    return this.clusters.create(body.name, body.clusterId);
  }

  // The guard checked the cluster (:id); the server comes by body/param so
  // it gets its own check here.
  @Post(":id/members")
  async addMember(@Param("id") id: string, @Body() body: AddMemberBody, @CurrentUser() user: AuthUser) {
    await this.access.assertServer(user, body.serverId);
    return this.clusters.addMember(id, body.serverId);
  }

  @Delete(":id/members/:serverId")
  async removeMember(
    @Param("id") _id: string,
    @Param("serverId") serverId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertServer(user, serverId);
    return this.clusters.removeMember(serverId);
  }

  @Post(":id/start")
  startAll(@Param("id") id: string) {
    // Detached: sequential member launches far outlast the proxy's ~30s ceiling.
    return this.clusters.startAllDetached(id);
  }

  @Post(":id/stop")
  stopAll(@Param("id") id: string) {
    return this.clusters.stopAllDetached(id);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.clusters.remove(id);
  }
}
