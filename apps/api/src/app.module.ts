import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { CryptoModule } from "./crypto/crypto.module";
import { EventsModule } from "./events/events.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { ManagerSettingsModule } from "./manager-settings/manager-settings.module";
import { DockerModule } from "./docker/docker.module";
import { CatalogModule } from "./catalog/catalog.module";
import { InstallerModule } from "./installer/installer.module";
import { AuthModule } from "./auth/auth.module";
import { ServersModule } from "./servers/servers.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { ModsModule } from "./mods/mods.module";
import { PalModsModule } from "./palmods/palmods.module";
import { IcarusModsModule } from "./icarusmods/icarusmods.module";
import { BedrockModsModule } from "./bedrockmods/bedrockmods.module";
import { SevenDaysModsModule } from "./sevendaysmods/sevendaysmods.module";
import { ValheimModsModule } from "./valheimmods/valheimmods.module";
import { AccessListsModule } from "./accesslists/accesslists.module";
import { ClustersModule } from "./clusters/clusters.module";
import { BackupsModule } from "./backups/backups.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PresetsModule } from "./presets/presets.module";
import { UpdatesModule } from "./updates/updates.module";
import { LogCaptureModule } from "./logs/log-capture.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    // Global infrastructure
    PrismaModule,
    CryptoModule,
    RealtimeModule,
    EventsModule,
    LogCaptureModule,
    ManagerSettingsModule,
    DockerModule,
    CatalogModule,
    InstallerModule,
    // Feature modules
    AuthModule,
    ServersModule,
    SchedulerModule,
    ModsModule,
    PalModsModule,
    IcarusModsModule,
    BedrockModsModule,
    SevenDaysModsModule,
    ValheimModsModule,
    AccessListsModule,
    ClustersModule,
    BackupsModule,
    NotificationsModule,
    PresetsModule,
    UpdatesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
