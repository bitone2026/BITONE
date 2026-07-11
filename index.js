import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";
dotenv.config();
import { handleInteraction, updateStockMessage, restoreStockMessage, notifyPublicRestock, addBlacklist, removeBlacklist } from "./handlers.js";
import { checkAndNotifyRestock } from "./wallet.js";
import { restoreFromEventLog } from "./dbBackup.js";
import { setClient } from "./dbEventLog.js";

/* ============================================================
   봇 초기화
============================================================ */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
/* ============================================================
   슬래시 커맨드
============================================================ */
const COMMANDS = [
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("BITKNIGHT 송금 패널 (관리자 전용)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("정보조회")
    .setDescription("인증된 유저 정보 조회 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("점검")
    .setDescription("긴급 점검 모드 ON/OFF (관리자 전용)")
    .addStringOption(o =>
      o.setName("상태").setDescription("on 또는 off").setRequired(true)
        .addChoices({ name: "ON", value: "on" }, { name: "OFF", value: "off" })
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("재고현황")
    .setDescription("현재 지갑 재고 현황 조회 (관리자 전용)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("수동인증")
    .setDescription("유저를 수동으로 인증 처리합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addStringOption(o => o.setName("이름").setDescription("실명").setRequired(true))
    .addStringOption(o => o.setName("생년월일").setDescription("생년월일 (예: 990101)").setRequired(true))
    .addStringOption(o => o.setName("전화번호").setDescription("전화번호 (예: 01012345678)").setRequired(true))
    .addStringOption(o =>
      o.setName("통신사").setDescription("통신사").setRequired(true)
        .addChoices(
          { name: "SKT", value: "SKT" },
          { name: "KT", value: "KT" },
          { name: "LG U+", value: "LG" },
          { name: "알뜰폰", value: "MVNO" },
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("블랙리스트")
    .setDescription("블랙리스트를 관리합니다 (관리자 전용)")
    .addStringOption(o =>
      o.setName("동작").setDescription("추가/삭제/조회").setRequired(true)
        .addChoices(
          { name: "추가", value: "추가" },
          { name: "삭제", value: "삭제" },
          { name: "조회", value: "조회" },
        )
    )
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addStringOption(o => o.setName("사유").setDescription("사유 (추가 시)").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("잔액조정")
    .setDescription("특정 유저의 잔액을 수동으로 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("조정할 금액(원, 음수 가능)").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("누적송금조정")
    .setDescription("유저의 누적 송금액을 수동으로 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("금액").setDescription("조정할 금액(원, 음수 가능)").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("한도조정")
    .setDescription("유저의 일일 송금 한도를 조정합니다 (관리자 전용)")
    .addStringOption(o => o.setName("유저").setDescription("디스코드 유저 ID").setRequired(true))
    .addIntegerOption(o => o.setName("한도").setDescription("새 일일한도(원). 생략하면 기본값으로 초기화").setRequired(false))
    .toJSON(),
];
/* ============================================================
   이벤트
============================================================ */
client.once("ready", async () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}`);

  // 이 시점부터 db.js의 모든 변경사항이 백업채널에 실시간으로(일반 텍스트 JSON) 기록됨
  setClient(client);

  // 🔧 Railway 등 재배포/재시작마다 파일시스템이 초기화되는 환경 대응:
  // db.js가 이미 새로 만든 "빈" DB에, 백업채널에 쌓인 이벤트 로그를 오래된 순서대로
  // 재생해서 원래 상태로 재구성함. (반드시 처음 1번, 데이터가 비어있을 때만 실행)
  await restoreFromEventLog(client, { addBlacklist, removeBlacklist });

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
  console.log("✅ 슬래시 커맨드 등록 완료");

  // DB에서 이전 송금 패널 메시지 복구
  await restoreStockMessage(client);
  setInterval(updateStockMessage, 60_000);
  // 즉시 1회 체크 + 이후 60초마다 입고 여부 체크 (관리자 로그 + 공개 입고알림)
  const runRestockCheck = () => checkAndNotifyRestock(client, (diffKrw) => notifyPublicRestock(client, diffKrw));
  await runRestockCheck();
  setInterval(runRestockCheck, 60_000);

  client.on("interactionCreate", (interaction) => handleInteraction(interaction));
});
client.login(process.env.DISCORD_TOKEN);