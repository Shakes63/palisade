import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";
import { ClustersService } from "./clusters.service";

class CreateClusterBody {
  @IsString() name!: string;
  @IsOptional() @IsString() clusterId?: string;
}
class AddMemberBody {
  @IsString() serverId!: string;
}

@Controller("clusters")
export class ClustersController {
  constructor(private readonly clusters: ClustersService) {}

  @Get()
  list() {
    return this.clusters.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.clusters.get(id);
  }

  @Post()
  create(@Body() body: CreateClusterBody) {
    return this.clusters.create(body.name, body.clusterId);
  }

  @Post(":id/members")
  addMember(@Param("id") id: string, @Body() body: AddMemberBody) {
    return this.clusters.addMember(id, body.serverId);
  }

  @Delete(":id/members/:serverId")
  removeMember(@Param("id") _id: string, @Param("serverId") serverId: string) {
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
