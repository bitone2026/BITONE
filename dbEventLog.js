// db.js의 모든 변경사항을 백업 채널에 "일반 텍스트(JSON 한 줄)"로 실시간 기록하는 모듈.
// db.js가 이 모듈을 import하고, dbBackup.js(복구/재생)도 이 모듈을 import하므로
// db.js <-> dbBackup.js 사이의 순환 참조를 막기 위해 별도 파일로 분리함.

let _client = null;
let _replaying = false;

/**
 * index.js에서 client.once("ready") 진입 직후 한 번 호출해서 client 참조를 넘겨줌.
 * 이게 설정되기 전까지는 logDbEvent가 아무것도 하지 않음(조용히 무시).
 */
export function setClient(client) {
  _client = client;
}

/**
 * 복구(이벤트 재생) 중에는 true로 설정해서, 재생 중 호출되는 db.js 함수들이
 * 다시 로그를 남기지 않도록 막음 (안 막으면 재시작마다 로그가 중복으로 계속 쌓임).
 */
export function setReplaying(value) {
  _replaying = value;
}

export function isReplaying() {
  return _replaying;
}

/**
 * DB 변경 이벤트 1건을 백업 채널에 텍스트로 기록.
 * 실패해도 절대 예외를 던지지 않음(로그 실패가 실제 서비스 동작을 막으면 안 됨).
 */
export async function logDbEvent(type, data) {
  if (_replaying) return; // 복구 재생 중에는 다시 기록하지 않음 (무한 중복 방지)
  if (!_client) return;   // 아직 client 준비 전이면 조용히 무시

  const channelId = process.env.DB_BACKUP_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await _client.channels.fetch(channelId);
    const line = JSON.stringify({ t: type, d: data, ts: Date.now() });
    await channel.send(line);
  } catch (e) {
    console.error(`❌ DB 이벤트 로그 전송 실패 (${type}):`, e.message);
  }
}