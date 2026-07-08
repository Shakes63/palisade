import { createSocket } from "node:dgram";

/** Result of a lightweight player-count query against a game server. */
export interface QueryCount {
  online: number;
  max: number | null;
}

/** One UDP request/response exchange with a timeout; resolves the first datagram. */
function udpExchange(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error("query timeout"));
    }, timeoutMs);
    sock.once("error", (e) => {
      clearTimeout(timer);
      sock.close();
      reject(e);
    });
    sock.once("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

const A2S_INFO_REQUEST = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), // header + 'T'
  Buffer.from("Source Engine Query\0", "ascii"),
]);

/**
 * Steam A2S_INFO query — the standard "server browser" protocol most Steam
 * dedicated servers answer on their query port (ASE, Conan, Icarus, Valheim,
 * 7DTD, Enshrouded…). Handles the modern challenge handshake (S2C_CHALLENGE
 * 0x41 → resend with the 4 challenge bytes appended).
 */
export async function a2sInfo(host: string, port: number, timeoutMs = 2500): Promise<QueryCount> {
  let res = await udpExchange(host, port, A2S_INFO_REQUEST, timeoutMs);
  if (res.length >= 9 && res[4] === 0x41) {
    // Challenge response — retry with the challenge appended.
    const challenge = res.subarray(5, 9);
    res = await udpExchange(host, port, Buffer.concat([A2S_INFO_REQUEST, challenge]), timeoutMs);
  }
  if (res.length < 6 || res[4] !== 0x49) throw new Error("unexpected A2S response");
  // Payload after the 'I' byte: protocol(1), then 4 null-terminated strings
  // (name, map, folder, game), int16 appid, byte players, byte maxplayers, …
  let off = 6; // skip 4-byte header, 'I', protocol byte
  for (let s = 0; s < 4; s++) {
    const end = res.indexOf(0, off);
    if (end === -1) throw new Error("truncated A2S response");
    off = end + 1;
  }
  off += 2; // appid
  if (off + 1 >= res.length) throw new Error("truncated A2S response");
  return { online: res.readUInt8(off), max: res.readUInt8(off + 1) };
}

// RakNet's fixed "offline message" magic (identifies unconnected packets).
const RAKNET_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

/**
 * RakNet unconnected ping — what the Minecraft Bedrock server answers on its game
 * port. The pong carries a ';'-separated status string:
 * "MCPE;<motd>;<protocol>;<version>;<online>;<max>;…".
 */
export async function raknetPing(host: string, port: number, timeoutMs = 2500): Promise<QueryCount> {
  const req = Buffer.alloc(1 + 8 + 16 + 8);
  req[0] = 0x01; // Unconnected Ping
  req.writeBigUInt64BE(BigInt(Date.now() & 0x7fffffff), 1);
  RAKNET_MAGIC.copy(req, 9);
  req.writeBigUInt64BE(0x1234n, 25); // arbitrary client GUID
  const res = await udpExchange(host, port, req, timeoutMs);
  if (res.length < 35 || res[0] !== 0x1c) throw new Error("unexpected RakNet response");
  const strLen = res.readUInt16BE(33);
  const status = res.subarray(35, 35 + strLen).toString("utf8");
  const parts = status.split(";");
  const online = Number(parts[4]);
  const max = Number(parts[5]);
  if (!Number.isFinite(online)) throw new Error("unparseable RakNet status");
  return { online, max: Number.isFinite(max) ? max : null };
}
