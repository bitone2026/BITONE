Import Database from "better-sqlite3";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();
import { logDbEvent } from "./dbEventLog.js";

/* ============================================================
   AES-256-GCM 암복호화
   .env에 AES_KEY=32자리 문자열 설정 필수
============================================================ */

const AES_KEY = crypto.createHash("sha256")
  .update(process.env.AES_KEY ?? "bitknight_default_key")
  .digest();

export function encrypt(plaintext) {
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv("aes-256-gcm", AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  // iv(12바이트) + authTag(16바이트) + 암호문 → base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decrypt(ciphertext) {
  try {
    const buf     = Buffer.from(ciphertext, "base64");
    const iv      = buf.slice(0, 12);
    const authTag = buf.slice(12, 28);
    const data    = buf.slice(28);
    const dec     = crypto.createDecipheriv("aes-256-gcm", AES_KEY, iv);
    dec.setAuthTag(authTag);
    return dec.update(data) + dec.final("utf8");
  } catch {
    return "복호화 실패";
  }
}

/* ============================================================
   DB 초기화
============================================================ */

export const db = new Database("verified.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS verified_users (
    discord_id   TEXT PRIMARY KEY,
    real_name    TEXT NOT NULL,
    birthday_enc TEXT NOT NULL,
    phone_enc    TEXT NOT NULL,
    telecom      TEXT NOT NULL,
    verified_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS points (
    discord_id  TEXT PRIMARY KEY,
    balance     INTEGER NOT NULL DEFAULT 0,
    total_spent INTEGER NOT NULL DEFAULT 0,
    notified_grade INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS custom_limits (
    discord_id  TEXT PRIMARY KEY,
    daily_limit INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS send_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id  TEXT NOT NULL,
    coin        TEXT NOT NULL,
    amount      REAL NOT NULL,
    krw         INTEGER NOT NULL,
    fee_krw     INTEGER NOT NULL DEFAULT 0,
    actual_krw  INTEGER,
    address     TEXT NOT NULL,
    hash        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auto_charge_custom_limits (
    discord_id  TEXT PRIMARY KEY,
    max_limit   INTEGER NOT NULL
  );
`);

/* ============================================================
   마이그레이션
============================================================ */

// points 테이블 total_spent 컬럼
try { db.exec(`ALTER TABLE points ADD COLUMN total_spent INTEGER NOT NULL DEFAULT 0`); } catch { /* 이미 존재 */ }
// points 테이블 notified_grade 컬럼 (등급 달성 알림 중복 방지용)
try { db.exec(`ALTER TABLE points ADD COLUMN notified_grade INTEGER NOT NULL DEFAULT 0`); } catch { /* 이미 존재 */ }
// send_history 테이블 fee_krw / actual_krw 컬럼 (수익통계용)
try { db.exec(`ALTER TABLE send_history ADD COLUMN fee_krw INTEGER NOT NULL DEFAULT 0`); } catch { /* 이미 존재 */ }
try { db.exec(`ALTER TABLE send_history ADD COLUMN actual_krw INTEGER`); } catch { /* 이미 존재 */ }

// verified_users 구버전 → AES 신버전
try {
  const cols = db.prepare("PRAGMA table_info(verified_users)").all().map(c => c.name);
  if (!cols.includes("birthday_enc")) {
    db.exec(`
      ALTER TABLE verified_users RENAME TO verified_users_old;
      CREATE TABLE verified_users (
        discord_id   TEXT PRIMARY KEY,
        real_name    TEXT NOT NULL,
        birthday_enc TEXT NOT NULL,
        phone_enc    TEXT NOT NULL,
        telecom      TEXT NOT NULL,
        verified_at  TEXT NOT NULL
      );
    `);
    console.log("⚠️ verified_users AES 마이그레이션 완료 (기존 인증 데이터 초기화됨)");
  }
} catch (e) { console.error("마이그레이션 오류:", e.message); }

/* ============================================================
   설정 관련
============================================================ */

export function getConfig(key) {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, String(value));
  logDbEvent("CONFIG", { key, value: String(value) });
}

/* ============================================================
   인증 관련
============================================================ */

export function isVerified(discordId) {
  return !!db.prepare("SELECT 1 FROM verified_users WHERE discord_id = ?").get(discordId);
}

// NICE 인증 완료 시 저장 - 생년월일/전화번호 AES-256-GCM 암호화
export function addVerifiedNice({ discordId, realName, birthday, phone, telecom }) {
  const birthdayEnc = encrypt(birthday);
  const phoneEnc = encrypt(phone);
  const verifiedAt = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO verified_users
      (discord_id, real_name, birthday_enc, phone_enc, telecom, verified_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(discordId, realName, birthdayEnc, phoneEnc, telecom, verifiedAt);
  // 🔒 평문이 아니라 이미 암호화된 값을 그대로 로그에 남김 (백업 채널에 개인정보 평문 노출 방지)
  logDbEvent("VERIFY", { discordId, realName, birthdayEnc, phoneEnc, telecom, verifiedAt });
}

/**
 * 복구(이벤트 재생) 전용. 로그에 남아있는 "이미 암호화된" birthdayEnc/phoneEnc를
 * 그대로 삽입함 (다시 encrypt()하면 안 됨 - 매번 랜덤 IV라 값이 바뀌어버림).
 */
export function restoreVerifiedNiceRaw({ discordId, realName, birthdayEnc, phoneEnc, telecom, verifiedAt }) {
  db.prepare(`
    INSERT OR REPLACE INTO verified_users
      (discord_id, real_name, birthday_enc, phone_enc, telecom, verified_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(discordId, realName, birthdayEnc, phoneEnc, telecom, verifiedAt);
}

// 동일 전화번호로 다른 계정이 이미 인증됐는지 확인 (전체 복호화 비교)
export function findByPhone(phone) {
  const all = db.prepare("SELECT * FROM verified_users").all();
  return all.find(row => {
    try { return decrypt(row.phone_enc) === phone; } catch { return false; }
  }) ?? null;
}

export const findByPhoneHash = findByPhone;

// 조회 시 생년월일·전화번호 복호화해서 반환
export function getVerifiedInfo(discordId) {
  const row = db.prepare(`
    SELECT
      discord_id,
      real_name AS realName,
      birthday_enc,
      phone_enc,
      telecom,
      verified_at
    FROM verified_users
    WHERE discord_id = ?
  `).get(discordId);
  if (!row) return null;
  return {
    ...row,
    birthday: row.birthday_enc ? decrypt(row.birthday_enc) : "정보 없음",
    phone:    row.phone_enc    ? decrypt(row.phone_enc)    : "정보 없음",
  };
}

/* ============================================================
   일일 한도 관련
============================================================ */

const DAILY_LIMIT = 300_000; // 원

// 오늘(KST) 00:00 ~ 지금까지 송금한 원화 합계
export function getDailySpent(discordId) {
  const todayKST = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString().slice(0, 10); // YYYY-MM-DD (KST)

  // KST 기준 보정: UTC로 저장되므로 KST 00:00 = UTC 전날 15:00
  const startUTC = new Date(`${todayKST}T00:00:00+09:00`).toISOString();
  const row2 = db.prepare(`
    SELECT COALESCE(SUM(krw), 0) as total
    FROM send_history
    WHERE discord_id = ? AND created_at >= ?
  `).get(discordId, startUTC);
  return row2 ? row2.total : 0;
}

// 일일 한도 체크 - 초과 시 false 반환 (유저별 커스텀 한도가 있으면 그것을 우선 사용)
export function checkDailyLimit(discordId, krw) {
  const spent = getDailySpent(discordId);
  const limit = getDailyLimitFor(discordId);
  return (spent + krw) <= limit;
}

/**
 * 유저별 커스텀 일일 한도 (관리자가 /한도조정으로 설정)
 * 설정된 값이 없으면 기본 DAILY_LIMIT을 사용함.
 */
export function getDailyLimitFor(discordId) {
  const row = db.prepare("SELECT daily_limit FROM custom_limits WHERE discord_id = ?").get(discordId);
  return row ? row.daily_limit : DAILY_LIMIT;
}

export function setDailyLimitFor(discordId, limit) {
  db.prepare("INSERT OR REPLACE INTO custom_limits (discord_id, daily_limit) VALUES (?, ?)").run(discordId, limit);
  logDbEvent("LIMIT_SET", { discordId, limit });
}

export function resetDailyLimitFor(discordId) {
  const info = db.prepare("DELETE FROM custom_limits WHERE discord_id = ?").run(discordId);
  if (info.changes > 0) logDbEvent("LIMIT_RESET", { discordId });
  return info.changes > 0;
}

export { DAILY_LIMIT };

/**
 * 자동 충전 1회 한도 설정 (기본값 200,000원)
 */
export function getAutoChargeLimit() {
  const limit = getConfig("auto_charge_limit");
  return limit ? parseInt(limit, 10) : 200000;
}

export function setAutoChargeLimit(limit) {
  setConfig("auto_charge_limit", limit);
}

/**
 * 특정 유저의 자동 충전 1회 한도 설정
 */
export function getAutoChargeLimitFor(discordId) {
  const row = db.prepare("SELECT max_limit FROM auto_charge_custom_limits WHERE discord_id = ?").get(discordId);
  if (row) return row.max_limit;
  return getAutoChargeLimit(); // 개별 설정 없으면 전체 기본값 반환
}

export function setAutoChargeLimitFor(discordId, limit) {
  db.prepare("INSERT OR REPLACE INTO auto_charge_custom_limits (discord_id, max_limit) VALUES (?, ?)").run(discordId, limit);
}

export function resetAutoChargeLimitFor(discordId) {
  db.prepare("DELETE FROM auto_charge_custom_limits WHERE discord_id = ?").run(discordId);
}

/* ============================================================
   포인트 관련
============================================================ */

export function getPoints(discordId) {
  const row = db.prepare("SELECT balance FROM points WHERE discord_id = ?").get(discordId);
  return row ? row.balance : 0;
}

export function getTotalSpent(discordId) {
  const row = db.prepare("SELECT total_spent FROM points WHERE discord_id = ?").get(discordId);
  return row ? row.total_spent : 0;
}

/**
 * 누적 송금액(total_spent) 직접 조정 (양수/음수 모두 가능, 관리자 보정용)
 * 실제 송금 없이 등급/누적통계만 보정할 때 사용.
 */
export function adjustTotalSpent(discordId, amount) {
  db.prepare(`
    INSERT INTO points (discord_id, balance, total_spent) VALUES (?, 0, ?)
    ON CONFLICT(discord_id) DO UPDATE SET total_spent = MAX(0, total_spent + ?)
  `).run(discordId, Math.max(0, amount), amount);
  logDbEvent("TOTAL_SPENT_ADJUST", { discordId, amount });
}

/**
 * 등급 달성 알림 중복 방지용 기록
 */
export function getNotifiedGrade(discordId) {
  const row = db.prepare("SELECT notified_grade FROM points WHERE discord_id = ?").get(discordId);
  return row ? row.notified_grade : 0;
}

export function setNotifiedGrade(discordId, threshold) {
  db.prepare(`
    INSERT INTO points (discord_id, balance, total_spent, notified_grade) VALUES (?, 0, 0, ?)
    ON CONFLICT(discord_id) DO UPDATE SET notified_grade = ?
  `).run(discordId, threshold, threshold);
  logDbEvent("NOTIFIED_GRADE", { discordId, threshold });
}

export function addPoints(discordId, amount) {
  db.prepare(`
    INSERT INTO points (discord_id, balance, total_spent) VALUES (?, ?, 0)
    ON CONFLICT(discord_id) DO UPDATE SET balance = balance + ?
  `).run(discordId, amount, amount);
  logDbEvent("POINTS_ADD", { discordId, amount });
}

export function deductPoints(discordId, amount) {
  const current = getPoints(discordId);
  if (current < amount) return false;
  db.prepare("UPDATE points SET balance = balance - ? WHERE discord_id = ?").run(amount, discordId);
  logDbEvent("POINTS_DEDUCT", { discordId, amount });
  return true;
}

/* ============================================================
   송금 내역 관련
============================================================ */

/**
 * 🔧 [수정] feeKrw / actualKrw도 같이 저장하도록 확장 (수익통계 계산용).
 * hash는 처음엔 MEXC 출금ID가 들어가고, 실제 완료 확인 후 진짜 TXID로 갱신됨(wallet.js에서 처리).
 */
export function recordSend(discordId, { coin, amount, krw, feeKrw, actualKrw, address, hash, createdAt }) {
  // 🔧 [수정] 복구(이벤트 재생) 중에는 "재생하는 지금 시각"이 아니라
  // 원래 송금했던 시각(createdAt)을 그대로 보존해야 함. 안 그러면 복구가
  // 일어날 때마다 예전 송금 기록들이 전부 "복구된 순간"의 동일한 시/분/초로
  // 다시 찍혀버리는 문제가 생김.
  const ts = createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO send_history (discord_id, coin, amount, krw, fee_krw, actual_krw, address, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(discordId, coin, amount, krw, feeKrw ?? 0, actualKrw ?? null, address, hash, ts);
  db.prepare(`
    INSERT INTO points (discord_id, balance, total_spent) VALUES (?, 0, ?)
    ON CONFLICT(discord_id) DO UPDATE SET total_spent = total_spent + ?
  `).run(discordId, krw, krw);
  logDbEvent("SEND_RECORD", { discordId, coin, amount, krw, feeKrw, actualKrw, address, hash, createdAt: ts });
}

export function getSendHistory(discordId, limit = 10) {
  return db.prepare(
    "SELECT * FROM send_history WHERE discord_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(discordId, limit);
}

/**
 * 실제 온체인 트랜잭션이 완료된 뒤, MEXC 출금ID였던 hash를 진짜 TXID로 갱신함.
 * (wallet.js의 출금완료 폴링 로직에서 사용 예정)
 */
export function updateSendTxHash(sendHistoryId, realTxHash) {
  db.prepare("UPDATE send_history SET hash = ? WHERE id = ?").run(realTxHash, sendHistoryId);
  logDbEvent("SEND_TX_CONFIRMED", { id: sendHistoryId, hash: realTxHash });
}

/**
 * 수익통계: 지정한 기간(since ~ now) 동안의 수수료 수익 합계.
 * 수익 = 송금 시 뗀 수수료(fee_krw) 합계.
 */
export function getProfitStats(sinceISO, untilISO) {
  const row = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(krw), 0) as totalKrw,
      COALESCE(SUM(fee_krw), 0) as totalFeeKrw
    FROM send_history
    WHERE created_at >= ? AND created_at < ?
  `).get(sinceISO, untilISO);
  return {
    count: row?.count ?? 0,
    totalKrw: row?.totalKrw ?? 0,
    totalFeeKrw: row?.totalFeeKrw ?? 0,
  };
}

/* ============================================================
   등급 관련
   누적 송금액 기준 12단계 역할 자동 부여 시스템.
   현재는 모든 등급의 수수료율이 동일함 (매입 -5% / 대행 5.5%, 실제 계산은
   handlers.js에서 처리). 이 등급은 배지/역할 및 8,000,000원 이상부터
   제공되는 "전용라운지" 접근 권한용으로 사용됨.
============================================================ */

export const GRADE_TIERS = [
  { threshold: 20_000_000, roleId: "1523182081906315414", name: "AURORA", lounge: true },
  { threshold: 15_000_000, roleId: "1523181735486165022", name: "CRYSTAL", lounge: true },
  { threshold: 10_000_000, roleId: "1523181324184322132", name: "EMERALD", lounge: true },
  { threshold:  8_000_000, roleId: "1523180335322632202", name: "DIAMOND",  lounge: true },
  { threshold:  5_000_000, roleId: "1523180037791289374", name: "RUBY",  lounge: false },
  { threshold:  4_000_000, roleId: "1523179745385119784", name: "SSPPHIRE",  lounge: false },
  { threshold:  3_000_000, roleId: "1523179433958051961", name: "JADE",  lounge: false },
  { threshold:  2_000_000, roleId: "1523179067690455141", name: "PLATINUM",  lounge: false },
  { threshold:  1_000_000, roleId: "1523178341492854914", name: "GOLD",  lounge: false },
  { threshold:    500_000, roleId: "1523177478577848350", name: "SILVER",  lounge: false },
  { threshold:    100_000, roleId: "1523176786681139230", name: "BONZE",  lounge: false },
  { threshold:     10_000, roleId: "1523174407835484311", name: "WOOD",  lounge: false },
];

export function getGrade(totalSpent) {
  for (const tier of GRADE_TIERS) {
    if (totalSpent >= tier.threshold) {
      return { ...tier, emoji: "🏅", color: 0xFFD700 };
    }
  }
  return { name: "일반", roleId: null, threshold: 0, lounge: false, emoji: "👤", color: 0x5865F2 };
}