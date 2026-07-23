// 백업 채널에 쌓인 "이벤트 로그(일반 텍스트 JSON)"를 시간순으로 재생해서
// db.js가 방금 새로 만든 빈 DB를 재구성하는 모듈.

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

  // 🔧 [핵심 버그 수정] DB에 이미 데이터가 있으면(=Railway가 파일을 실제로는
  // 안 지웠거나, 직전에 이미 복구된 상태) 재생을 절대 하지 않음.
  // 이 체크가 없으면 재시작될 때마다 과거 이벤트가 기존 잔액/누적 위에
  // 계속 더해져서 "가만히 둬도 포인트가 계속 올라가는" 심각한 버그가 생김.
  const pointsCount   = db.prepare("SELECT COUNT(*) as c FROM points").get().c;
  const verifiedCount = db.prepare("SELECT COUNT(*) as c FROM verified_users").get().c;
  const sendCount     = db.prepare("SELECT COUNT(*) as c FROM send_history").get().c;
  if (pointsCount > 0 || verifiedCount > 0 || sendCount > 0) {
    console.log(`ℹ️ DB에 이미 데이터가 있어(points:${pointsCount}, verified:${verifiedCount}, send:${sendCount}) 이벤트 로그 재생을 건너뜁니다.`);
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);

    // 채널의 전체 메시지를 100개씩 페이지네이션으로 수집 (최신 → 과거 순으로 옴)
    const allMessages = [];
    let before;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      allMessages.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }

    // 오래된 것부터 순서대로 재생해야 하므로 뒤집음
    allMessages.reverse();

    const events = [];
    for (const msg of allMessages) {
      if (msg.author.id !== client.user.id) continue; // 봇이 남긴 로그만 이벤트로 취급
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed && parsed.t) events.push(parsed);
      } catch {
        // JSON이 아닌 메시지(사람이 남긴 잡담 등)는 이벤트 로그가 아니므로 무시
      }
    }

    if (events.length === 0) {
      console.log("ℹ️ 백업 채널에 복구할 이벤트 로그가 없습니다. 새 DB로 시작합니다.");
      return;
    }

    setReplaying(true);
    let applied = 0;
    for (const ev of events) {
      try {
        applyEvent(ev, { addBlacklist, removeBlacklist });
        applied++;
      } catch (e) {
        console.error(`이벤트 재생 실패 (${ev.t}):`, e.message);
      }
    }
    setReplaying(false);

    console.log(`✅ DB 복구 완료: 이벤트 ${applied}/${events.length}건 재생됨`);
  } catch (e) {
    console.error("❌ DB 복구(이벤트 로그 재생) 실패:", e.message);
  }
}

function applyEvent(ev, { addBlacklist, removeBlacklist }) {
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
      recordSend(d.discordId, {
        coin: d.coin, amount: d.amount, krw: d.krw,
        feeKrw: d.feeKrw, actualKrw: d.actualKrw,
        address: d.address, hash: d.hash, createdAt: d.createdAt,
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
    case "SEND_TX_CONFIRMED":
      // 실제 TXID 갱신 이벤트는 참고용 로그로만 남고, 상세 재생은 생략해도
      // send_history 자체는 SEND_RECORD로 이미 복구되므로 큰 문제 없음.
      break;
    default:
      console.warn("알 수 없는 이벤트 타입, 건너뜀:", ev.t);
  }
}