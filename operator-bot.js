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
  BUFFER_SECONDS = 30,   // must match contract
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !OPERATOR_KEY || !ORACLE_ADDRESS) {
  throw new Error('Missing RPC_URL, PREDICTION_ADDRESS, OPERATOR_KEY, or ORACLE_ADDRESS');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

// Oracle (read-only)
const oracleAbi = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];
const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, provider);

let txPending = false;
let lastHandledEpoch = 0;
const lastAttemptedEpochs = new Map();
const recoveryFailures = new Map(); // epoch -> failure count
let pauseUnpauseAttempted = false;
let nextPositionIsBull = Math.random() < 0.5;

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

// --- Pause/unpause to reset a stuck genesis ---
// In PancakePrediction V3, unpause() resets genesisStartOnce and genesisLockOnce.
// pause() requires admin or operator; unpause() may require admin only.
async function tryResetViaUnpause(currentEpoch) {
  const key = `pauseUnpause-${currentEpoch}`;
  const lastAttempt = lastAttemptedEpochs.get(key) || 0;
  const now = Math.floor(Date.now() / 1000);
  if (now - lastAttempt < 3600) return false; // try at most once per hour

  lastAttemptedEpochs.set(key, now);
  console.log(`[operator-bot] 🔄 Epoch ${currentEpoch} is permanently stuck — attempting pause/unpause reset`);

  let didPause = false;
  try {
    const isPaused = await prediction.paused();
    if (!isPaused) {
      const r1 = await sendTx(opts => prediction.pause(opts));
      console.log(`[operator-bot] ✅ Paused (${r1.hash})`);
      didPause = true;
      await sleep(2000);
    } else {
      console.log(`[operator-bot] ℹ️ Contract already paused, proceeding to unpause`);
      didPause = true;
    }
    const r2 = await sendTx(opts => prediction.unpause(opts));
    console.log(`[operator-bot] ✅ Unpaused — genesis flags reset (${r2.hash})`);
    recoveryFailures.delete(currentEpoch);
    lastHandledEpoch = 0;
    return true;
  } catch (err) {
    console.error(`[operator-bot] ❌ Reset failed: ${err.message}`);
    if (didPause) {
      console.error(`[operator-bot] ⚠️  CONTRACT IS NOW PAUSED — call unpause() on ${PREDICTION_ADDRESS} to resume`);
    } else {
      console.error(`[operator-bot] ⚠️  MANUAL ACTION REQUIRED: call pause() then unpause() on ${PREDICTION_ADDRESS}`);
    }
    return false;
  }
}

// --- Genesis bootstrap ---
async function bootstrapGenesis() {
  const startOnce = await prediction.genesisStartOnce();
  const lockOnce = await prediction.genesisLockOnce();
  console.log(`[operator-bot] Genesis - StartOnce=${startOnce}, LockOnce=${lockOnce}`);

  if (!startOnce) {
    const r = await sendTx(opts => prediction.genesisStartRound(opts));
    console.log(`[operator-bot] ✅ genesisStartRound (${r.hash})`);
    await sleep(1000);
    return true;
  }

  if (startOnce && !lockOnce) {
    const currentEpoch = Number(await prediction.currentEpoch());
    const round = await prediction.rounds(currentEpoch);
    const now = Math.floor(Date.now() / 1000);
    const lockTime = Number(round.lockTimestamp);
    const bufferSeconds = Number(BUFFER_SECONDS);

    if (now < lockTime) {
      console.log(`[operator-bot] ⏳ Waiting for genesis lock window: Now=${ts(now)}, Lock=${ts(lockTime)}`);
      return true; // Block recovery/betting while genesis lock is pending
    } else if (now > lockTime + bufferSeconds) {
      console.log(`[operator-bot] ❌ Missed genesis lock window: Now=${ts(now)}, Window=${ts(lockTime)} to ${ts(lockTime + bufferSeconds)}`);
      // Missed the genesis lock window — reset and try again
      await tryResetViaUnpause(currentEpoch);
      return true;
    }

    const r = await sendTx(opts => prediction.genesisLockRound(opts));
    console.log(`[operator-bot] ✅ genesisLockRound (${r.hash})`);
    await sleep(1000);
    return true;
  }
  return false;
}

// --- Try to bet on the current round ---
async function tryBet(epoch) {
  const round = await prediction.rounds(epoch);
  const now = Math.floor(Date.now() / 1000);

  if (now <= Number(round.startTimestamp) || now >= Number(round.lockTimestamp)) return;

  const betInfo = await prediction.ledger(epoch, wallet.address);

  if (Number(betInfo.amount) > 0) return;

  const position = nextPositionIsBull ? 'betBull' : 'betBear';
  const amount = ethers.parseUnits('0.5', 18);

  console.log(`[operator-bot] ▶ Betting ${position} on epoch ${epoch} with ${amount}`);

  txPending = true;
  try {
    const r = await sendTx(opts => prediction[position](epoch, amount, opts));
    console.log(`[operator-bot] 🎯 Bet placed: epoch ${epoch} (${r.hash})`);
    nextPositionIsBull = !nextPositionIsBull;
  } catch (err) {
    console.error(`[operator-bot] ❌ Bet failed: ${err.message}`);
  }
  txPending = false;
}

// --- Try to execute a round ---
async function tryExecute(epoch) {
  if (epoch <= lastHandledEpoch) return false;

  const now = Math.floor(Date.now() / 1000);
  const lastAttempt = lastAttemptedEpochs.get(epoch) || 0;
  if (now - lastAttempt < 30) return false;

  const round = await prediction.rounds(epoch);
  const lockTime = Number(round.lockTimestamp);

  console.log(`[operator-bot] Checking epoch ${epoch}: Now=${ts(now)}, Lock=${ts(lockTime)}`);

  // Must let round N-2 be finished before executing N
  let canExecute = true;
  if (epoch >= 2) {
    const prev2 = await prediction.rounds(epoch - 2);
    if (Number(prev2.closeTimestamp) === 0 || now < Number(prev2.closeTimestamp)) {
      console.log(`[operator-bot] ⏳ Waiting for round ${epoch - 2} to end`);
      canExecute = false;
    }
  }

  const windowStart = lockTime;
  const windowEnd = lockTime + Number(BUFFER_SECONDS);

  if (lockTime > 0 && now >= windowStart && now <= windowEnd && canExecute) {
    try {
      const oracleData = await oracle.latestRoundData();
      console.log(`[operator-bot] Oracle roundId=${Number(oracleData[0])}, ts=${ts(Number(oracleData[3]))}`);

      console.log(`[operator-bot] ▶ Executing epoch ${epoch}`);
      txPending = true;
      lastAttemptedEpochs.set(epoch, now);
      const r = await sendTx(opts => prediction.executeRound(opts));
      console.log(`[operator-bot] 🎯 Success: epoch ${epoch} (${r.hash})`);
      lastHandledEpoch = epoch;
      txPending = false;
      return true;
    } catch (err) {
      console.error(`[operator-bot] ❌ Execute failed: ${err.message}`);
      txPending = false;
    }
  }
  return false;
}

// --- Recovery for stuck rounds ---
// executeRound() has no epoch param — it always acts on currentEpoch.
// Only attempt recovery for the current epoch after its lock window has passed.
// After 2 failures, escalate to pause/unpause reset.
async function recoverStuckRounds(currentEpoch) {
  if (currentEpoch <= lastHandledEpoch) return false;

  const now = Math.floor(Date.now() / 1000);
  const round = await prediction.rounds(currentEpoch);
  const lockTime = Number(round.lockTimestamp);

  // Not yet past the normal execution window — tryExecute handles this
  if (lockTime === 0 || now < lockTime + Number(BUFFER_SECONDS)) return false;

  const failures = recoveryFailures.get(currentEpoch) || 0;

  // After 1 failed recovery attempt, the contract is enforcing a hard time limit.
  // Escalate to pause/unpause reset so genesis can restart cleanly.
  if (failures >= 1) {
    return tryResetViaUnpause(currentEpoch);
  }

  const lastAttempt = lastAttemptedEpochs.get(`recover-${currentEpoch}`) || 0;
  if (now - lastAttempt < 300) return false; // retry at most every 5 minutes

  console.log(`[operator-bot] ▶ Recovering missed epoch ${currentEpoch} (lockTime=${ts(lockTime)}, attempt ${failures + 1})`);
  try {
    txPending = true;
    lastAttemptedEpochs.set(`recover-${currentEpoch}`, now);
    const r = await sendTx(opts => prediction.executeRound(opts));
    console.log(`[operator-bot] 🎯 Recovery success: epoch ${currentEpoch} (${r.hash})`);
    lastHandledEpoch = currentEpoch;
    recoveryFailures.delete(currentEpoch);
    txPending = false;
    return true;
  } catch (err) {
    console.error(`[operator-bot] ❌ Recovery failed for epoch ${currentEpoch}: ${err.message}`);
    recoveryFailures.set(currentEpoch, failures + 1);
    txPending = false;
  }
  return false;
}

// --- Main loop ---
async function checkAndExecute() {
  if (txPending) return;
  try {
    const contractBuffer = await prediction.bufferSeconds();
    if (Number(contractBuffer) !== Number(BUFFER_SECONDS)) {
      console.error(`[operator-bot] ⚠ Buffer mismatch: env=${BUFFER_SECONDS}, contract=${contractBuffer}`);
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

    await tryBet(currentEpoch);
  } catch (err) {
    console.error(`[operator-bot] ❌ Main error: ${err.message}`);
    txPending = false;
  }
}

// --- Monitoring ---
setInterval(async () => {
  try {
    const epoch = Number(await prediction.currentEpoch());
    const paused = await prediction.paused();
    const startOnce = await prediction.genesisStartOnce();
    const lockOnce = await prediction.genesisLockOnce();
    const round = await prediction.rounds(epoch);
    console.log(`[monitor] Epoch=${epoch}, paused=${paused}, GenesisStart=${startOnce}, GenesisLock=${lockOnce}, Round={lock=${ts(Number(round.lockTimestamp))}, close=${ts(Number(round.closeTimestamp))}, oracleCalled=${round.oracleCalled}}`);
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

    const tokenAddress = await prediction.token();
    const tokenAbi = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ];
    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);
    const allowance = await tokenContract.allowance(wallet.address, PREDICTION_ADDRESS);
    if (allowance < ethers.parseUnits('2.5', 18)) {
      console.log(`[operator-bot] Approving prediction contract for betting`);
      const tx = await tokenContract.approve(PREDICTION_ADDRESS, ethers.MaxUint256);
      await tx.wait();
      console.log(`[operator-bot] Approval done`);
    }
  } catch (err) {
    console.error(`[operator-bot] ❌ Operator check failed: ${err.message}`);
  }
})();

console.log(`[operator-bot] Starting with wallet ${wallet.address}...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
