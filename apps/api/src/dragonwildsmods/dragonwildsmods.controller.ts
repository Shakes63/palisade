import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { DragonwildsModsService } from "./dragonwildsmods.service";

// 1 GB cap — a mod's .ucas carries the cooked assets and runs to hundreds of MB.
const UPLOAD = { limits: { fileSize: 1024 * 1024 * 1024 } };
type Upload = { originalname: string; buffer: Buffer };

@Controller("servers/:id/dragonwildsmods")
export class DragonwildsModsController {
  constructor(private readonly mods: DragonwildsModsService) {}

  @Get()
  status(@Param("id") id: string) {
    return this.mods.status(id);
  }

  @Post("files")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  addFile(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.mods.addFile(id, file.originalname, file.buffer);
  }

  @Delete(":name")
  removeMod(@Param("id") id: string, @Param("name") name: string) {
    return this.mods.removeMod(id, name);
  }
}
