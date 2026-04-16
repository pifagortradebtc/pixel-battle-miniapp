/**
 * Проверяет, что при включённом «Мстим за Альт Сезон» сервер считает кулдаун пикселя 1000 мс
 * (тот же effectivePixelCooldownMs, что и обработчик type:"pixel").
 *
 * Запуск из корня репозитория:
 *   npm run test:mstim-cooldown
 *
 * Нужен PIXEL_BATTLE_ENABLE_TEST_WS (скрипт выставляет сам в env дочернего процесса).
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const PK = "integration_mstim_pk";
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
  const dataDir = path.resolve(os.tmpdir(), `pixel-mstim-test-${Date.now()}`);
  const port = 39000 + Math.floor(Math.random() * 800);
  fs.mkdirSync(dataDir, { recursive: true });

  const now = Date.now();
  /* Бой ещё идёт: playStart ≈ now−55s, длительность 120s → конец в будущем (иначе maybeEndRound грузит round-state и сбрасывает mstim). */
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
    const t = setTimeout(() => reject(new Error(`server start timeout (stderr: ${bootErr.slice(-400)})`)), 25_000);
    const onOut = (c) => {
      if (String(c).includes("Pixel Battle:")) {
        clearTimeout(t);
        proc.stdout.off("data", onOut);
        resolve();
      }
    };
    proc.stdout.on("data", onOut);
  });

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
      `timeout; last types: ${incoming
        .slice(-12)
        .map((m) => m.type)
        .join(",")}`
    );
  }

  function flushIncoming() {
    incoming.length = 0;
  }

  function send(o) {
    ws.send(JSON.stringify(o));
  }

  try {
    send({ type: "clientProfile", playerKey: PK });
    await waitPred((m) => m.type === "wallet");

    send({ type: "__testPixelCooldownProbe", playerKey: PK, teamId: 0 });
    let ack = await waitPred((m) => m.type === "__testPixelCooldownProbeAck");
    if (ack.cd !== 15_000) {
      throw new Error(`expected cd=15000 without mstim, got ${ack.cd} (probe ${JSON.stringify(ack)})`);
    }
    if (ack.mstimActive) throw new Error("mstimActive should be false initially");

    const until = Date.now() + 300_000;
    send({ type: "__testSetMstim", untilMs: until });
    ack = await waitPred((m) => m.type === "__testSetMstimAck");
    if (!ack.active) {
      throw new Error(`mstim should be active after __testSetMstim (ack=${JSON.stringify(ack)} sentUntil=${until})`);
    }

    send({ type: "__testPixelCooldownProbe", playerKey: PK, teamId: 0 });
    ack = await waitPred((m) => m.type === "__testPixelCooldownProbeAck");
    if (ack.cd !== 1000) {
      throw new Error(`expected cd=1000 with mstim ON, got ${ack.cd} (probe ${JSON.stringify(ack)})`);
    }
    if (!ack.mstimActive) throw new Error("probe should see mstimActive true");

    send({ type: "__testSetMstim", untilMs: 0 });
    await waitPred((m) => m.type === "__testSetMstimAck");

    send({ type: "createTeam", name: "MstimTest", emoji: "🧪", playerKey: PK });
    const cr = await waitPred((m) => m.type === "created");
    const sp = cr.team?.spawn;
    if (!sp) throw new Error("no spawn in created");

    /** @type {[number, number] | null} */
    let p1 = null;
    for (const [x, y] of borderCells(sp)) {
      flushIncoming();
      send({ type: "pixel", x, y, playerKey: PK });
      const reply = await waitPred(
        (m) =>
          m.type === "wallet" ||
          m.type === "invalidPlacement" ||
          m.type === "pixelReject",
        8000
      );
      if (reply.type === "wallet") {
        p1 = [x, y];
        break;
      }
    }
    if (!p1) throw new Error("first pixel never succeeded on border cells");

    const tPlace1 = Date.now();

    /** @type {[number, number] | null} */
    let p2 = null;
    for (const [x, y] of borderCells(sp)) {
      if (x === p1[0] && y === p1[1]) continue;
      flushIncoming();
      send({ type: "pixel", x, y, playerKey: PK });
      const reply = await waitPred(
        (m) =>
          m.type === "wallet" ||
          m.type === "invalidPlacement" ||
          m.type === "pixelReject",
        8000
      );
      if (
        (reply.type === "invalidPlacement" && reply.reason === "cooldown not ready") ||
        (reply.type === "pixelReject" && reply.reason === "cooldown not ready")
      ) {
        p2 = [x, y];
        break;
      }
      if (reply.type === "wallet") {
        throw new Error("second pixel succeeded immediately — expected 15s cooldown (mstim off)");
      }
    }
    if (!p2) throw new Error("no border cell gave cooldown-not-ready after first pixel (map/adjacency?)");

    flushIncoming();
    send({ type: "__testSetMstim", untilMs: Date.now() + 300_000 });
    await waitPred((m) => m.type === "__testSetMstimAck");

    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - (Date.now() - tPlace1))));

    flushIncoming();
    send({ type: "pixel", x: p2[0], y: p2[1], playerKey: PK });
    const afterMstim = await waitPred(
      (m) => m.type === "wallet" || m.type === "invalidPlacement" || m.type === "pixelReject",
      8000
    );
    if (afterMstim.type !== "wallet") {
      throw new Error(
        `expected second cell to succeed ~1s after first with mstim ON, got ${JSON.stringify(afterMstim)}`
      );
    }

    console.log("test:mstim-cooldown OK (probe 15s→1s, real pixel cooldown after ~1.1s with mstim)");
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
