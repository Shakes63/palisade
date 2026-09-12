import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { BackupsService } from "./backups.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../auth/access.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/auth-user";

// 1 GB cap — worlds are usually far smaller; huge modded Minecraft worlds may not fit.
const UPLOAD = { limits: { fileSize: 1024 * 1024 * 1024 } };
type Upload = { originalname: string; buffer: Buffer };

/** The slice of Express's Response we use (avoids a @types/express dependency). */
interface HeaderSettable {
  setHeader(name: string, value: string): void;
}

@Controller()
export class BackupsController {
  constructor(
    private readonly backups: BackupsService,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @Get("servers/:id/backups")
  list(@Param("id") id: string) {
    return this.backups.list(id);
  }

  @Post("servers/:id/backups")
  create(@Param("id") id: string) {
    return this.backups.create(id, "manual");
  }

  /** Stream a snapshot as a tar.gz (browser download). */
  @Get("servers/:id/backups/:snapshotId/download")
  async download(
    @Param("id") id: string,
    @Param("snapshotId") snapshotId: string,
    @Res({ passthrough: true }) res: HeaderSettable,
  ) {
    const { stream, filename } = await this.backups.download(id, snapshotId);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return new StreamableFile(stream);
  }

  @Post("servers/:id/backups/:snapshotId/restore")
  restore(@Param("id") id: string, @Param("snapshotId") snapshotId: string) {
    return this.backups.restore(id, snapshotId);
  }

  /** Import a saves archive uploaded through the browser (server must be stopped). */
  @Post("servers/:id/backups/upload")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  upload(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.backups.importSaves(id, file.originalname, file.buffer);
  }

  /** Not under servers/:id, so the guard can't scope it: resolve the owning
   *  server and check that (GH #73). */
  @Delete("backups/:snapshotId")
  async remove(@Param("snapshotId") snapshotId: string, @CurrentUser() user: AuthUser) {
    const snap = await this.prisma.snapshot.findUnique({
      where: { id: snapshotId },
      select: { serverId: true },
    });
    if (!snap) throw new NotFoundException("Backup not found");
    await this.access.assertServer(user, snap.serverId);
    return this.backups.remove(snapshotId);
  }
}
