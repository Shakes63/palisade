import { Module } from "@nestjs/common";
import { PortForwardsController, RouterController } from "./portforwards.controller";
import { PortForwardsService } from "./portforwards.service";

@Module({
  controllers: [PortForwardsController, RouterController],
  providers: [PortForwardsService],
})
export class PortForwardsModule {}
