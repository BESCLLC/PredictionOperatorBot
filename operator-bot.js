import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 15000,   // check more often for tighter sync
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,      // must match contract setting
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

let txPending = false;
let lastExecutedEpoch = 0;

function ts(unix) {
  return new Date(unix * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function sendTx(fn) {
  try {
    const tx = await fn({
      gasLimit: Number(GAS_LIMIT),
      gasPrice: ethers.parseUnits("1000", "gwei"), // fixed gas
    });
    console.log(`[operator-bot] Tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    return receipt;
  } catch (err) {
    console.error(`[operator-bot] ❌ Error sending tx: ${err.message}`);
    return null; // don’t crash
  }
}

async function bootstrapGenesis() {
  const genesisStartOnce = await prediction.genesisStartOnce();
  const genesisLockOnce = await prediction.genesisLockOnce();

  if (!genesisStartOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisStartRound...`);
    const receipt = await sendTx((opts) => prediction.genesisStartRound(opts));
    if (receipt) console.log(`[operator-bot] ✅ genesisStartRound executed (${receipt.hash})`);
    return true;
  }

  if (genesisStartOnce && !genesisLockOnce) {
    console.log(`[operator-bot] ⚡ Calling genesisLockRound...`);
    const receipt = await sendTx((opts) => prediction.genesisLockRound(opts));
    if (receipt) console.log(`[operator-bot] ✅ genesisLockRound executed (${receipt.hash})`);
    return true;
  }

  return false;
}

async function checkAndExecute() {
  if (txPending) return;

  try {
    const bootstrapped = await bootstrapGenesis();
    if (bootstrapped) return;

    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const block = await provider.getBlock("latest");
    const now = Number(block.timestamp);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    // If we’re behind, try to catch up
    if (lastExecutedEpoch > 0 && epoch > lastExecutedEpoch + 1) {
      console.log(`[operator-bot] ⚠️ Behind by ${epoch - lastExecutedEpoch} epochs, catching up...`);
      for (let e = lastExecutedEpoch + 1; e <= epoch; e++) {
        try {
          console.log(`[operator-bot] Catch-up: executing round ${e}`);
          txPending = true;
          const receipt = await sendTx((opts) => prediction.executeRound(opts));
          if (receipt) {
            console.log(`[operator-bot] ✅ Catch-up executed round ${e} (${receipt.hash})`);
            lastExecutedEpoch = e;
          }
          txPending = false;
        } catch (err) {
          console.error(`[operator-bot] ❌ Catch-up failed: ${err.message}`);
          txPending = false;
          break; // stop trying this loop, retry next tick
        }
      }
      return;
    }

    // Normal execution if we’re in window
    if (
      lockTime > 0 &&
      now >= closeTime &&
      now <= closeTime + Number(BUFFER_SECONDS)
    ) {
      console.log(
        `[operator-bot] Executing round ${epoch.toString()}... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
      );
      txPending = true;
      const receipt = await sendTx((opts) => prediction.executeRound(opts));
      if (receipt) {
        console.log(`[operator-bot] ✅ Round executed (${receipt.hash})`);
        lastExecutedEpoch = Number(epoch);
      }
      txPending = false;
    } else {
      console.log(
        `[operator-bot] Waiting... now=${ts(now)} lock=${ts(lockTime)} close=${ts(closeTime)}`
      );
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Error: ${err.message}`);
    txPending = false;
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
