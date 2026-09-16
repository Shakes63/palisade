import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsBoolean, IsOptional, IsString } from "class-validator";
import { MinRole } from "../auth/min-role.decorator";
import { PalModsService } from "./palmods.service";

class FrameworkBody {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() preload?: string;
}

// 512 MB cap — pak mods are usually a few MB; frameworks a few tens.
const UPLOAD = { limits: { fileSize: 512 * 1024 * 1024 } };
type Upload = { originalname: string; buffer: Buffer };

@Controller("servers/:id/palmods")
export class PalModsController {
  constructor(private readonly palmods: PalModsService) {}

  @Get()
  status(@Param("id") id: string) {
    return this.palmods.status(id);
  }

  @Post("paks")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  addPak(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.palmods.addPak(id, file.originalname, file.buffer);
  }

  /**
   * The pak listing is recursive, so a name can be a nested path
   * ("ModName/ModName_P.pak"). That can't ride in a path segment: the web app
   * reaches the API through a Next rewrite (`/api/:path*`), where an encoded
   * `%2F` is not reliably preserved. A query param passes through untouched.
   */
  @Delete("paks")
  removePak(@Param("id") id: string, @Query("path") path?: string) {
    if (!path) throw new BadRequestException("Missing pak path");
    return this.palmods.removePak(id, path);
  }

  @Patch("framework")
  setFramework(@Param("id") id: string, @Body() body: FrameworkBody) {
    return this.palmods.setFramework(id, body);
  }

  @Post("framework/upload")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  installFramework(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.palmods.installFramework(id, file.buffer);
  }

  /** Download + verify + install the pinned UE4SS Linux build, then enable it. */
  @Post("framework/install-ue4ss")
  installUe4ss(@Param("id") id: string) {
    return this.palmods.installFrameworkFromUpstream(id);
  }

  /** Download + verify + install the pinned PalSchema build (Wine-only). */
  @Post("framework/install-palschema")
  installPalSchema(@Param("id") id: string) {
    return this.palmods.installPalSchemaFromUpstream(id);
  }

  @Post("framework/palschema/upload")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  uploadPalSchema(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.palmods.installPalSchema(id, file.buffer);
  }

  @Post("palschema/mods")
  @UseInterceptors(FileInterceptor("file", UPLOAD))
  addPalSchemaMod(@Param("id") id: string, @UploadedFile() file?: Upload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.palmods.addPalSchemaMod(id, file.originalname, file.buffer);
  }

  /**
   * The mod's editable JSON, as instance-root-relative paths the file-manager
   * read/write endpoints accept directly.
   *
   * Operator, not the viewer default a GET would otherwise get: this feeds an editor
   * whose reads and writes go through FilesController, which is operator-only. A
   * viewer allowed to list the files would just 403 on opening one.
   */
  @MinRole("operator")
  @Get("palschema/mods/:name/config")
  palSchemaModConfig(@Param("id") id: string, @Param("name") name: string) {
    return this.palmods.palSchemaModConfigFiles(id, name);
  }

  @Delete("palschema/mods/:name")
  removePalSchemaMod(@Param("id") id: string, @Param("name") name: string) {
    return this.palmods.removePalSchemaMod(id, name);
  }
}
