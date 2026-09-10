import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from "class-validator";
import { PortForwardsService } from "./portforwards.service";
import { MinRole } from "../auth/min-role.decorator";

/** The Settings form's current (possibly unsaved) router fields. */
class RouterTestBody {
  @IsOptional() @IsIn(["pfsense", "unifi"]) router?: "pfsense" | "unifi";
  @IsOptional() @IsString() host?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() site?: string;
  @IsOptional() @IsString() targetIp?: string;
}

/** Settings-scoped router utilities (not tied to a server). */
@MinRole("admin")
@Controller("router")
export class RouterController {
  constructor(private readonly portforwards: PortForwardsService) {}

  /** Validate router (pfSense or UniFi) host + API key + target IP. The body
   *  carries the form's current values so Test works before Save; blanks fall
   *  back to the saved settings. */
  @Post("test")
  test(@Body() body: RouterTestBody) {
    return this.portforwards.testConnection(body);
  }
}

class ToggleForwardBody {
  @IsInt() port!: number;
  @IsIn(["udp", "tcp"]) proto!: "udp" | "tcp";
  @IsBoolean() enabled!: boolean;
}

@Controller("servers/:id/portforwards")
export class PortForwardsController {
  constructor(private readonly portforwards: PortForwardsService) {}

  /** Each player-facing forward's state on the router. */
  @Get()
  status(@Param("id") id: string) {
    return this.portforwards.status(id);
  }

  /** Create missing forwards and re-target mismatched ones + apply. */
  @Post()
  apply(@Param("id") id: string) {
    return this.portforwards.apply(id);
  }

  /** Enable or disable one forward. */
  @Patch()
  toggle(@Param("id") id: string, @Body() body: ToggleForwardBody) {
    return this.portforwards.setEnabled(id, body.port, body.proto, body.enabled);
  }

  /** Delete one forward (?port=&proto=), or all of this server's forwards. */
  @Delete()
  remove(
    @Param("id") id: string,
    @Query("port") port?: string,
    @Query("proto") proto?: string,
  ) {
    const p = port !== undefined ? Number(port) : undefined;
    return this.portforwards.remove(id, p, proto === "tcp" ? "tcp" : proto === "udp" ? "udp" : undefined);
  }
}
