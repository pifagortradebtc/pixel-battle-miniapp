/**
 * Проба I-X1: анонимные ошибочные кадры WebSocket не должны ронять процесс.
 * Запуск: node scripts/probe-ws-bad-frames.mjs ws://127.0.0.1:3000/ws http://127.0.0.1:3000/health
 * Шлёт четыре кадра (слишком большой, не-UTF-8, немаскированный, фрагментированный сверх лимита) сырыми сокетами,
 * затем проверяет, что health отвечает 200. Код выхода 0 — процесс жив; 1 — health пропал. агент Юноны, 07.10.
 */
import net from "node:net";
import crypto from "node:crypto";

const [wsUrl = "ws://127.0.0.1:3000/ws", healthUrl = "http://127.0.0.1:3000/health"] = process.argv.slice(2);
const u = new URL(wsUrl);
const host = u.hostname, port = Number(u.port || 80), path = u.pathname + u.search;

function frame({ fin = true, opcode, payload, mask = true }) {
  const len = payload.length;
  const head = [(fin ? 0x80 : 0) | opcode];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65536) head.push(maskBit | 126, len >> 8, len & 255);
  else { head.push(maskBit | 127); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); head.push(...b); }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((x, i) => x ^ key[i % 4]));
  return Buffer.concat([Buffer.from(head), key, masked]);
}

function handshakeAndSend(frames) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host, () => {
      const key = crypto.randomBytes(16).toString("base64");
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let upgraded = false;
    sock.on("data", (d) => {
      if (!upgraded && d.toString("latin1").startsWith("HTTP/1.1 101")) {
        upgraded = true;
        for (const f of frames) sock.write(f);
        setTimeout(() => { sock.destroy(); resolve("sent"); }, 400);
      } else if (!upgraded) { sock.destroy(); resolve("no-upgrade:" + d.toString("latin1").split("\r\n")[0]); }
    });
    sock.on("error", (e) => resolve("sock-error:" + e.code));
    sock.on("close", () => resolve("closed"));
    setTimeout(() => { sock.destroy(); resolve("timeout"); }, 3000);
  });
}

const cases = {
  oversize: [frame({ opcode: 1, payload: Buffer.alloc(200000, 0x61) })],
  "bad-utf8": [frame({ opcode: 1, payload: Buffer.from([0xff, 0xfe, 0xfd, 0x80]) })],
  unmasked: [frame({ opcode: 1, payload: Buffer.from("x"), mask: false })],
  fragmented: [frame({ fin: false, opcode: 1, payload: Buffer.alloc(100000, 0x62) }),
               frame({ fin: false, opcode: 0, payload: Buffer.alloc(100000, 0x63) }),
               frame({ fin: true, opcode: 0, payload: Buffer.alloc(100000, 0x64) })],
};
for (const [name, frames] of Object.entries(cases)) console.log(name, await handshakeAndSend(frames));
await new Promise((r) => setTimeout(r, 500));
try {
  const res = await fetch(healthUrl);
  console.log("health", res.status);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.log("health unreachable:", e?.message || e);
  process.exit(1);
}
