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
import { IcarusModsService } from "./icarusmods.service";

// 512 MB cap — Icarus pak mods are usually a few MB, merged packs a bit more.
const UPLOAD = { limits: { fileSize: 512 * 1024 * 1024 } };
type Upload = { originalname: string; buffer: Buffer };

@Controller("servers/:id/icarusmods")
export class IcarusModsController {
  constructor(private readonly icarusmods: IcarusModsService) {}

  @Get()
  status(@Param("id") id: string) {
    return this.icarusmods.status(id);
  }

  @Post("paks")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  addPak(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.icarusmods.addPak(id, file.originalname, file.buffer);
  }

  @Delete("paks/:name")
  removePak(@Param("id") id: string, @Param("name") name: string) {
    return this.icarusmods.removePak(id, name);
  }
}
