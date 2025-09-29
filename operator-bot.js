import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  OPERATOR_KEY,            // different wallet from oracle
  PREDICTION_ADDRESS,
  CHECK_INTERVAL = 5000,   // check every 5s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,     // must match contract
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or OPERATOR_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;
let lastHandledEpoch = 0;

// --- Helpers ---
function ts(unix: number) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sendTx(fn: any) {
  const tx = await fn({
    gasLimit: Number(GAS_LIMIT),
    gasPrice: ethers.parseUnits("1000", "gwei"), // locked gas
  });
  console.log(`[operator-bot] 🚀 Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt;
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce();
  const lockOnce = await prediction.genesisLockOnce();

  if (!startOnce) {
    console.log(`[operator-bot] ⚡ genesisStartRound`);
    const r = await sendTx((opts: any) => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
    return true;
  }
  if (startOnce && !lockOnce) {
    console.log(`[operator-bot] ⚡ genesisLockRound`);
    const r = await sendTx((opts: any) => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
    return true;
  }
  return false;
}

// --- Try execute an epoch ---
async function tryExecute(epoch: number) {
  if (epoch <= lastHandledEpoch) return false;

  const round = await prediction.rounds(epoch);
  const now = Math.floor(Date.now() / 1000);

  const lockTime = Number(round.lockTimestamp);
  const oracleCalled = round.oracleCalled;

  // valid execution window
  if (
    lockTime > 0 &&
    oracleCalled &&
    now >= lockTime &&
    now <= lockTime + Number(BUFFER_SECONDS)
  ) {
    console.log(`[operator-bot] ▶ Executing epoch ${epoch} now=${ts(now)}`);
    txPending = true;
    try {
      const r = await sendTx((opts: any) => prediction.executeRound(opts));
      console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
      lastHandledEpoch = epoch;
    } catch (e: any) {
      console.error(`[operator-bot] ❌ Failed epoch ${epoch}: ${e.message}`);
      // keep retrying until buffer expires
      txPending = false;
      return false;
    }
    txPending = false;
    return true;
  }

  // expired -> mark handled so we don't spam old ones
  if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch}`);
    lastHandledEpoch = epoch;
  }

  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const currentEpoch = Number(await prediction.currentEpoch());

    // 🔥 scan wider range: last 5 → current → next
    for (let e = currentEpoch - 5; e <= currentEpoch + 1; e++) {
      if (e > 0) {
        await tryExecute(e);
      }
    }
  } catch (err: any) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
