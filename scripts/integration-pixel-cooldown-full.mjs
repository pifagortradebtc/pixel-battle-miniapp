/**
 * Интеграционные проверки авторитетного кулдауна пикселя (сервер):
 * A — база 15 с; B–E — личный бафф 10/5/2/1 с; F–G — глобальный mstim 1 с и сброс.
 *
 *   npm run test:pixel-cooldown-full
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PK = "integration_full_cd_pk";
const SPAWN = 6;

function borderCells(sp) {
  const x0 = sp.x0 | 0;
  const y0 = sp.y0 | 0;
  const out = [];
  for (let y = y0; y < y0 + SPAWN; y++) {
    out.push([x0 - 1, y], [x0 + SPAWN, y]);
  }
  for (let x = x0 - 1; x <= x0 + SPAWN; x++) {
    out.push([x, y0 - 1], [x, y0 + SPAWN]);
  }
  const seen = new Set();
  return out.filter(([x, y]) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  const dataDir = path.resolve(os.tmpdir(), `pixel-cd-full-${Date.now()}`);
  const port = 38000 + Math.floor(Math.random() * 900);
  fs.mkdirSync(dataDir, { recursive: true });

  const now = Date.now();
  const roundState = {
    roundIndex: 0,
    roundStartMs: now - 60_000,
    playStartMs: now - 55_000,
    roundDurationMs: 120_000,
    tournamentQuickTestMode: true,
    tournamentTimeScale: 1,
    mstimAltSeasonBurstUntilMs: 0,
    round0WarmupMs: 5000,
    roundTimerStarted: true,
    eligibleTokens: [],
    eligiblePlayerKeys: [],
    gameFinished: false,
    winnerTokensByPlayerKey: {},
    battleEventsApplied: {},
    manualBattleSlots: {},
    treasureGridW: 0,
    treasureGridH: 0,
    mapTreasures: {},
    mapTreasureClaimed: [],
    gamePaused: false,
    pauseWallStartedAt: 0,
    pauseCapturedWarmup: false,
    warmupPauseExtensionMs: 0,
    teamManualScoreBonus: {},
    quantumFarmLevels: [],
  };
  fs.writeFileSync(path.join(dataDir, "round-state.json"), JSON.stringify(roundState));
  fs.writeFileSync(path.join(dataDir, "dynamic-teams.json"), JSON.stringify({ nextId: 1, teams: [] }));

  const env = {
    ...process.env,
    PORT: String(port),
    PIXEL_BATTLE_DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: "",
    PIXEL_BATTLE_ENABLE_TEST_WS: "true",
    REDIS_URL: "",
    WALLET_BACKEND: "json",
  };

  const proc = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let bootErr = "";
  proc.stderr.on("data", (c) => {
    bootErr += String(c);
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server start timeout (${bootErr.slice(-400)})`)), 25_000);
    const onOut = (c) => {
      if (String(c).includes("Pixel Battle:")) {
        clearTimeout(t);
        proc.stdout.off("data", onOut);
        resolve();
      }
    };
    proc.stdout.on("data", onOut);
  });

  /** @type {unknown[]} */
  const incoming = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.on("message", (d) => {
    try {
      incoming.push(JSON.parse(String(d)));
    } catch {
      /* ignore */
    }
  });

  async function waitPred(pred, ms = 12_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ix = incoming.findIndex(pred);
      if (ix >= 0) return incoming.splice(ix, 1)[0];
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(
      `timeout; last: ${incoming
        .slice(-8)
        .map((m) => m?.type)
        .join(",")}`
    );
  }

  function flushIncoming() {
    incoming.length = 0;
  }

  function send(o) {
    ws.send(JSON.stringify(o));
  }

  async function probeCd(expectedMs, label) {
    flushIncoming();
    send({ type: "__testPixelCooldownProbe", playerKey: PK, teamId: 0 });
    const ack = await waitPred((m) => m.type === "__testPixelCooldownProbeAck");
    if (ack.cd !== expectedMs) {
      throw new Error(`${label}: expected cd=${expectedMs}, got ${ack.cd} ${JSON.stringify(ack)}`);
    }
  }

  async function clearPersonalBuff() {
    send({
      type: "__testSetPersonalRecovery",
      playerKey: PK,
      sec: 15,
      untilMs: Date.now() - 60_000,
    });
    await waitPred((m) => m.type === "__testSetPersonalRecoveryAck" && m.ok);
  }

  try {
    send({ type: "clientProfile", playerKey: PK });
    await waitPred((m) => m.type === "wallet");

    await probeCd(15_000, "TEST A no buff");

    for (const tier of [10, 5, 2, 1]) {
      await clearPersonalBuff();
      await probeCd(15_000, `after clear before ${tier}s`);
      send({
        type: "__testSetPersonalRecovery",
        playerKey: PK,
        tierSec: tier,
        untilMs: Date.now() + 120_000,
      });
      await waitPred((m) => m.type === "__testSetPersonalRecoveryAck" && m.ok);
      await probeCd(tier * 1000, `TEST shop ${tier}s buff`);
    }

    await clearPersonalBuff();
    send({ type: "createTeam", name: "CdFull", emoji: "🧪", playerKey: PK });
    const cr = await waitPred((m) => m.type === "created");
    const sp = cr.team?.spawn;
    if (!sp) throw new Error("no spawn");

    let p1 = null;
    for (const [x, y] of borderCells(sp)) {
      flushIncoming();
      send({ type: "pixel", x, y, playerKey: PK });
      const reply = await waitPred(
        (m) => m.type === "wallet" || m.type === "invalidPlacement" || m.type === "pixelReject",
        8000
      );
      if (reply.type === "wallet") {
        p1 = [x, y];
        break;
      }
    }
    if (!p1) throw new Error("first pixel failed");

    let p2 = null;
    for (const [x, y] of borderCells(sp)) {
      if (x === p1[0] && y === p1[1]) continue;
      flushIncoming();
      send({ type: "pixel", x, y, playerKey: PK });
      const reply = await waitPred(
        (m) => m.type === "wallet" || m.type === "invalidPlacement" || m.type === "pixelReject",
        8000
      );
      if (
        (reply.type === "invalidPlacement" && reply.reason === "cooldown not ready") ||
        (reply.type === "pixelReject" && reply.reason === "cooldown not ready")
      ) {
        p2 = [x, y];
        break;
      }
      if (reply.type === "wallet") throw new Error("second pixel too soon (15s base)");
    }
    if (!p2) throw new Error("no cooldown second cell");

    const t1 = Date.now();
    send({ type: "__testSetMstim", untilMs: Date.now() + 300_000 });
    const mack = await waitPred((m) => m.type === "__testSetMstimAck");
    if (!mack.active) throw new Error("mstim should be active");

    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - (Date.now() - t1))));
    flushIncoming();
    send({ type: "pixel", x: p2[0], y: p2[1], playerKey: PK });
    const after = await waitPred(
      (m) => m.type === "wallet" || m.type === "invalidPlacement" || m.type === "pixelReject",
      8000
    );
    if (after.type !== "wallet") {
      throw new Error(`TEST F mstim pixel: expected wallet, got ${JSON.stringify(after)}`);
    }

    send({ type: "__testSetMstim", untilMs: 0 });
    await waitPred((m) => m.type === "__testSetMstimAck");
    await probeCd(15_000, "TEST G after mstim off");

    console.log("test:pixel-cooldown-full OK (15s base, shop 10/5/2/1s, mstim 1s, mstim off)");
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
