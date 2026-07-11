import {
  db, setConfig, addPoints, deductPoints, recordSend, adjustTotalSpent,
  setNotifiedGrade, setDailyLimitFor, resetDailyLimitFor, restoreVerifiedNiceRaw,
} from "./db.js";
import { setReplaying } from "./dbEventLog.js";

export async function restoreFromEventLog(client, { addBlacklist, removeBlacklist } = {}) {
  const channelId = process.env.DB_BACKUP_CHANNEL_ID;
  if (!channelId) {
    console.warn("⚠️ DB_BACKUP_CHANNEL_ID가 설정되지 않아 DB 복구를 건너뜁니다.");
    return;
  }

  const pointsCount   = db.prepare("SELECT COUNT(*) as c FROM points").get().c;
  const verifiedCount = db.prepare("SELECT COUNT(*) as c FROM verified_users").get().c;
  const sendCount     = db.prepare("SELECT COUNT(*) as c FROM send_history").get().c;
  if (pointsCount > 0 || verifiedCount > 0 || sendCount > 0) {
    console.log(`ℹ️ DB에 이미 데이터가 있어(points:${pointsCount}, verified:${verifiedCount}, send:${sendCount}) 이벤트 로그 재생을 건너뜁니다.`);
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);

    const allMessages = [];
    let before;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      allMessages.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }

    allMessages.reverse();

    const events = [];
    for (const msg of allMessages) {
      if (msg.author.id !== client.user.id) continue;
      try {
        const parsed = JSON.parse(msg.content);
        // 🔧 [수정됨] JSON 데이터와 함께 디스코드 메시지가 작성된 시간(msg.createdAt)을 같이 저장합니다.
        if (parsed && parsed.t) {
          events.push({ payload: parsed, fallbackTime: msg.createdAt });
        }
      } catch {
        // JSON이 아닌 메시지는 무시
      }
    }

    if (events.length === 0) {
      console.log("ℹ️ 백업 채널에 복구할 이벤트 로그가 없습니다. 새 DB로 시작합니다.");
      return;
    }

    setReplaying(true);
    let applied = 0;
    for (const evObj of events) {
      try {
        // 🔧 [수정됨] applyEvent에 fallbackTime도 같이 넘겨줍니다.
        applyEvent(evObj.payload, { addBlacklist, removeBlacklist }, evObj.fallbackTime);
        applied++;
      } catch (e) {
        console.error(`이벤트 재생 실패 (${evObj.payload.t}):`, e.message);
      }
    }
    setReplaying(false);

    console.log(`✅ DB 복구 완료: 이벤트 ${applied}/${events.length}건 재생됨`);
  } catch (e) {
    console.error("❌ DB 복구(이벤트 로그 재생) 실패:", e.message);
  }
}

// 🔧 [수정됨] 세 번째 인자로 fallbackTime(디스코드 메시지 시간)을 받습니다.
function applyEvent(ev, { addBlacklist, removeBlacklist }, fallbackTime) {
  const d = ev.d || {};
  switch (ev.t) {
    case "CONFIG":
      setConfig(d.key, d.value);
      break;
    case "VERIFY":
      restoreVerifiedNiceRaw(d);
      break;
    case "POINTS_ADD":
      addPoints(d.discordId, d.amount);
      break;
    case "POINTS_DEDUCT":
      deductPoints(d.discordId, d.amount);
      break;
    case "SEND_RECORD":
      // 🔧 [핵심 수정] JSON 안에 시간이 없다면, 봇이 백업 채널에 메시지를 남겼던 시간을 씁니다.
      const actualTime = d.createdAt || fallbackTime.toISOString();
      
      recordSend(d.discordId, { 
        coin: d.coin, 
        amount: d.amount, 
        krw: d.krw, 
        address: d.address, 
        hash: d.hash, 
        createdAt: actualTime 
      });
      break;
    case "TOTAL_SPENT_ADJUST":
      adjustTotalSpent(d.discordId, d.amount);
      break;
    case "NOTIFIED_GRADE":
      setNotifiedGrade(d.discordId, d.threshold);
      break;
    case "LIMIT_SET":
      setDailyLimitFor(d.discordId, d.limit);
      break;
    case "LIMIT_RESET":
      resetDailyLimitFor(d.discordId);
      break;
    case "BLACKLIST_ADD":
      if (addBlacklist) addBlacklist(d.discordId, d.reason, d.adminTag);
      break;
    case "BLACKLIST_REMOVE":
      if (removeBlacklist) removeBlacklist(d.discordId);
      break;
    default:
      console.warn("알 수 없는 이벤트 타입, 건너뜀:", ev.t);
  }
}
