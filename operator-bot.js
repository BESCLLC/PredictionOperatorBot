import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: 'json' };

const {
  RPC_URL,
  OPERATOR_KEY,
  PREDICTION_ADDRESS,
  ORACLE_ADDRESS,
  CHECK_INTERVAL = 1000, // 1s
  GAS_LIMIT = 500000,
  BUFFER_SECONDS = 30,   // Must match contract
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY || !ORACLE_ADDRESS) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, OPERATOR_KEY, or ORACLE_ADDRESS');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

// Oracle contract
const oracleAbi = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function version() view returns (uint256)',
];
const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, provider);

let txPending = false;
let lastHandledEpoch = 0;
const lastAttemptedEpochs = new Map();

function ts(unix) {
  return new Date(Number(unix) * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const tx = await fn({
        gasLimit: Number(GAS_LIMIT),
        gasPrice: ethers.parseUnits('1000', 'gwei'),
        nonce,
      });
      console.log(`[operator-bot] 🚀 Tx sent: ${tx.hash}, nonce=${nonce}`);
      const receipt = await tx.wait(2);
      return receipt;
    } catch (err) {
      console.error(`[operator-bot] ❌ Tx failed (try ${attempt}): ${err.message}`);
      if (attempt === 5) throw err;
      await sleep(1000);
    }
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce({ blockTag: 'latest' });
  const lockOnce = await prediction.genesisLockOnce({ blockTag: 'latest' });
  console.log(`[operator-bot] Genesis - StartOnce=${startOnce}, LockOnce=${lockOnce}`);

  if (!startOnce) {
    try {
      const r = await sendTx(opts => prediction.genesisStartRound(opts));
      console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
      await sleep(1000);
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ genesisStartRound failed: ${err.message}`);
      return false;
    }
  }

  if (startOnce && !lockOnce) {
    const currentEpoch = Number(await prediction.currentEpoch());
    const round = await prediction.rounds(currentEpoch);
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);

    if (now < lockTime) {
      console.log(`[operator-bot] ⏳ Waiting for genesis lock window: Now=${ts(now)}, Lock=${ts(lockTime)}`);
      return false;
    }

    try {
      const r = await sendTx(opts => prediction.genesisLockRound(opts));
      console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
      await sleep(1000);
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ genesisLockRound failed: ${err.message}`);
      return false;
    }
  }

  return false;
}

// --- Try execute an epoch ---
async function tryExecute(epoch) {
  if (epoch <= lastHandledEpoch) return false;

  const now = Math.floor(Date.now() / 1000);
  const lastAttempt = lastAttemptedEpochs.get(epoch) || 0;
  if (now - lastAttempt < 30) {
    console.log(`[operator-bot] ⏳ Cooldown skip epoch ${epoch}`);
    return false;
  }

  const round = await prediction.rounds(epoch);
  const lockTime = Number(round.lockTimestamp);
  const oracleCalled = round.oracleCalled;

  console.log(`[operator-bot] Checking epoch ${epoch}: Now=${ts(now)}, Lock=${ts(lockTime)}, OracleCalled=${oracleCalled}`);

  // Check previous round (must be ended)
  let canEndPrevious = true;
  if (epoch >= 1) {
    const prevRound = await prediction.rounds(epoch - 1);
    console.log(`[operator-bot] Previous round (epoch ${epoch - 1}): close=${ts(Number(prevRound.closeTimestamp))}, oracleCalled=${prevRound.oracleCalled}`);
    if (Number(prevRound.closeTimestamp) === 0 || now < Number(prevRound.closeTimestamp)) {
      console.log(`[operator-bot] ⏳ Waiting for prev round ${epoch - 1} to end`);
      canEndPrevious = false;
    }
  }

  const EXECUTION_WINDOW_START = lockTime;
  const EXECUTION_WINDOW_END = lockTime + Number(BUFFER_SECONDS);

  if (lockTime > 0 && now >= EXECUTION_WINDOW_START && now <= EXECUTION_WINDOW_END && canEndPrevious) {
    try {
      const oracleData = await oracle.latestRoundData();
      const oracleRoundId = Number(oracleData[0]);
      const oracleTimestamp = Number(oracleData[3]);
      const oracleLatestRoundId = Number(await prediction.oracleLatestRoundId());
      const oracleUpdateAllowance = Number(await prediction.oracleUpdateAllowance());

      console.log(`[operator-bot] Oracle check: roundId=${oracleRoundId}, contract=${oracleLatestRoundId}, ts=${ts(oracleTimestamp)}`);

      if (oracleRoundId > oracleLatestRoundId && oracleTimestamp <= now + oracleUpdateAllowance) {
        console.log(`[operator-bot] ▶ Executing epoch ${epoch}`);
        txPending = true;
        lastAttemptedEpochs.set(epoch, now);
        try {
          const r = await sendTx(opts => prediction.executeRound(opts));
          console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
          lastHandledEpoch = epoch;
          txPending = false;
          return true;
        } catch (err) {
          console.error(`[operator-bot] ❌ Execute failed: ${err.message}`);
          txPending = false;
        }
      } else {
        console.log(`[operator-bot] ❌ Oracle data not fresh for epoch ${epoch}`);
      }
    } catch (err) {
      console.error(`[operator-bot] ❌ Oracle check failed: ${err.message}`);
    }
  }

  if (lockTime > 0 && now > lockTime + Number(BUFFER_SECONDS)) {
    console.log(`[operator-bot] ⏩ Missed epoch ${epoch}`);
  }
  return false;
}

// --- Recover stuck rounds ---
async function recoverStuckRounds(currentEpoch) {
  const now = Math.floor(Date.now() / 1000);
  for (let epoch = Math.max(currentEpoch - 5, 1); epoch <= currentEpoch; epoch++) {
    if (epoch <= lastHandledEpoch) continue;
    const round = await prediction.rounds(epoch);
    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);
    const oracleCalled = round.oracleCalled;

    console.log(`[operator-bot] Recovery check ${epoch}: lock=${ts(lockTime)}, close=${ts(closeTime)}, oracleCalled=${oracleCalled}`);

    if (lockTime > 0 && closeTime > 0 && now >= closeTime && now <= closeTime + Number(BUFFER_SECONDS)) {
      try {
        const oracleData = await oracle.latestRoundData();
        const oracleRoundId = Number(oracleData[0]);
        const oracleTimestamp = Number(oracleData[3]);
        const oracleLatestRoundId = Number(await prediction.oracleLatestRoundId());
        const oracleUpdateAllowance = Number(await prediction.oracleUpdateAllowance());

        if (oracleRoundId > oracleLatestRoundId && oracleTimestamp <= now + oracleUpdateAllowance) {
          console.log(`[operator-bot] ▶ Recovering stuck epoch ${epoch}`);
          txPending = true;
          lastAttemptedEpochs.set(epoch, now);
          try {
            const r = await sendTx(opts => prediction.executeRound(opts));
            console.log(`[operator-bot] 🎯 Recovery success: epoch ${epoch} (${r.hash})`);
            lastHandledEpoch = epoch;
            txPending = false;
            return true;
          } catch (err) {
            console.error(`[operator-bot] ❌ Recovery failed: ${err.message}`);
            txPending = false;
          }
        }
      } catch (err) {
        console.error(`[operator-bot] ❌ Recovery oracle failed: ${err.message}`);
      }
    }
  }
  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;
  try {
    const contractBuffer = await prediction.bufferSeconds();
    if (Number(contractBuffer) !== Number(BUFFER_SECONDS)) {
      console.error(`[operator-bot] ⚠ BUFFER_SECONDS mismatch: env=${BUFFER_SECONDS}, contract=${contractBuffer}`);
    }

    if (await bootstrapGenesis()) return;

    const currentEpoch = Number(await prediction.currentEpoch());

    if (await recoverStuckRounds(currentEpoch)) return;

    for (const e of [currentEpoch, currentEpoch + 1, currentEpoch - 1]) {
      if (e > 0 && e > lastHandledEpoch) {
        const executed = await tryExecute(e);
        if (executed) break;
      }
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Main error: ${err.message}`);
    txPending = false;
  }
}

// --- Monitoring ---
setInterval(async () => {
  try {
    const epoch = Number(await prediction.currentEpoch());
    const oracleRoundId = Number(await prediction.oracleLatestRoundId());
    const paused = await prediction.paused();
    const startOnce = await prediction.genesisStartOnce();
    const lockOnce = await prediction.genesisLockOnce();
    const oracleUpdateAllowance = Number(await prediction.oracleUpdateAllowance());
    const oracleData = await oracle.latestRoundData();
    const round = await prediction.rounds(epoch);
    console.log(`[monitor] Epoch=${epoch}, OracleID=${oracleRoundId}, paused=${paused}, GenesisStart=${startOnce}, GenesisLock=${lockOnce}, allowance=${oracleUpdateAllowance}, OracleData={roundId=${Number(oracleData[0])}, price=${Number(oracleData[1])}, ts=${ts(Number(oracleData[3]))}}, CurrentRound={lock=${ts(Number(round.lockTimestamp))}, oracleCalled=${round.oracleCalled}}`);
  } catch (err) {
    console.error(`[monitor] ❌ ${err.message}`);
  }
}, 3000);

provider.on('error', err => console.error(`[operator-bot] ❌ RPC error: ${err.message}`));

(async () => {
  try {
    const operator = await prediction.operatorAddress();
    if (operator !== wallet.address) {
      console.error(`[operator-bot] ❌ Wallet ${wallet.address} is not operator (${operator})`);
    } else {
      console.log(`[operator-bot] ✅ Wallet ${wallet.address} is operator`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Operator check failed: ${err.message}`);
  }
})();

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
