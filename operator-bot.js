import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 3000,   // poll every 5s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,     // contract buffer
  SAFE_DELAY = 2,          // wait 2s after lock
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;
let lastExecuted = 0;

function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T',' ').replace('Z',' UTC');
}

async function sendTx(fn) {
  const tx = await fn({
    gasLimit: Number(GAS_LIMIT),
  });
  console.log(`[operator-bot] Tx sent: ${tx.hash}`);
  return await tx.wait();
}

async function bootstrapGenesis() {
  const started = await prediction.genesisStartOnce();
  const locked = await prediction.genesisLockOnce();

  if (!started) {
    console.log(`[operator-bot] ⚡ genesisStartRound`);
    const r = await sendTx((opts) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
    return true;
  }

  if (started && !locked) {
    console.log(`[operator-bot] ⚡ genesisLockRound`);
    const r = await sendTx((opts) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
    return true;
  }

  return false;
}

async function checkAndExecute() {
  if (txPending) return;

  try {
    const boot = await bootstrapGenesis();
    if (boot) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);

    // only run once per epoch
    if (epoch.toString() === lastExecuted.toString()) return;

    if (lockTime > 0 && now >= lockTime + SAFE_DELAY && now <= lockTime + BUFFER_SECONDS) {
      console.log(`[operator-bot] Executing epoch ${epoch}... now=${ts(now)} lock=${ts(lockTime)}`);
      txPending = true;
      try {
        const r = await sendTx((opts) => prediction.executeRound(opts));
        console.log(`[operator-bot] ✅ Executed round ${epoch} (${r.hash})`);
        lastExecuted = epoch;
      } finally {
        txPending = false;
      }
    } else if (lockTime > 0 && now > lockTime + BUFFER_SECONDS) {
      console.log(`[operator-bot] ⏩ Missed epoch ${epoch} (lock=${ts(lockTime)}). Moving on...`);
      lastExecuted = epoch;
    } else {
      console.log(`[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)}`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
