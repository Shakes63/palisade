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
import { BedrockModsService } from "./bedrockmods.service";

// 512 MB cap — addon packs are usually a few MB, big resource packs a bit more.
const UPLOAD = { limits: { fileSize: 512 * 1024 * 1024 } };
type Upload = { originalname: string; buffer: Buffer };

@Controller("servers/:id/bedrockmods")
export class BedrockModsController {
  constructor(private readonly bedrockmods: BedrockModsService) {}

  @Get()
  status(@Param("id") id: string) {
    return this.bedrockmods.status(id);
  }

  @Post("packs")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  addPack(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.bedrockmods.addPack(id, file.originalname, file.buffer);
  }

  @Delete("packs/:uuid")
  removePack(@Param("id") id: string, @Param("uuid") uuid: string) {
    return this.bedrockmods.removePack(id, uuid);
  }
}
