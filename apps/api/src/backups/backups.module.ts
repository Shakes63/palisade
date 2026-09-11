import { Module } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { BackupsController } from "./backups.controller";
import { RconModule } from "../rcon/rcon.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [RconModule, AuthModule],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}
