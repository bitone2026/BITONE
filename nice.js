import axios from "axios";
import { URLSearchParams } from "url";
import fs from "fs";
import path from "path";
import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  MediaGalleryBuilder, AttachmentBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { addVerifiedNice, findByPhoneHash } from "./db.js";

/* ============================================================
   세션 저장소
============================================================ */

const verifySessions = {};

/* ============================================================
   NICE 세션 생성
============================================================ */

async function makeSession(mobileCo) {
  const res = await axios.get("https://bsb.scourt.go.kr/NiceCheck/checkplus_main.jsp");
  const enc = res.data.split('name="EncodeData" value="')[1].split('">')[0];

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const cookieJar = {};

  function extractCookies(r) {
    (r.headers["set-cookie"] || []).forEach(cookie => {
      const [pair] = cookie.split(";");
      const [key, value] = pair.split("=");
      cookieJar[key.trim()] = value ? value.trim() : "";
    });
  }
  function getCookieString() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const post = async (url, data) => {
    const r = await axios.post(url, new URLSearchParams(data).toString(), {
      headers: { ...baseHeaders, Cookie: getCookieString() },
    });
    extractCookies(r); return r;
  };
  const get = async (url) => {
    const r = await axios.get(url, {
      headers: { ...baseHeaders, Cookie: getCookieString() },
      responseType: "arraybuffer",
    });
    extractCookies(r); return r;
  };

  await post("https://nice.checkplus.co.kr/CheckPlusSafeModel/checkplus.cb", { m: "checkplusSerivce", EncodeData: enc });
  await post("https://nice.checkplus.co.kr/cert/main/tracer", {});
  await post("https://nice.checkplus.co.kr/cert/main/menu", {});

  const r2       = await post("https://nice.checkplus.co.kr/cert/mobileCert/method", { selectMobileCo: mobileCo, os: "Windows" });
  const certHash = r2.data.split('name="certInfoHash" value="')[1].split('">')[0];
  const r3       = await post("https://nice.checkplus.co.kr/cert/mobileCert/sms/certification", { certInfoHash: certHash, mobileCertAgree: "Y" });
  const svcInfo  = r3.data.split('const SERVICE_INFO = "')[1].split('";')[0];
  const capVer   = r3.data.split('const captchaVersion = "')[1].split('";')[0];
  const capImg   = await get(`https://nice.checkplus.co.kr/cert/captcha/image/${capVer}`);

  return { img: Buffer.from(capImg.data), svc: svcInfo, getCookieString, baseHeaders };
}

/* ============================================================
   SMS 발송 & 인증번호 확인
============================================================ */

async function sendSms(sessionData, name, co, b1, b2, phone, cap) {
  const { svc, getCookieString, baseHeaders } = sessionData;
  const h = { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "x-service-info": svc, "X-Requested-With": "XMLHttpRequest", Cookie: getCookieString() };
  const r = await axios.post(
    "https://nice.checkplus.co.kr/cert/mobileCert/sms/certification/proc",
    new URLSearchParams({ userNameEncoding: encodeURIComponent(name), mobileCertMethod: "SMS", mobileCo: co, userName: name, myNum1: b1, myNum2: b2, mobileNo: phone, captchaAnswer: cap }).toString(),
    { headers: h }
  );
  return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
}

async function verifyCode(sessionData, co, code) {
  const { svc, getCookieString, baseHeaders } = sessionData;
  const h = { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "x-service-info": svc, "X-Requested-With": "XMLHttpRequest", Cookie: getCookieString() };
  const r = await axios.post(
    "https://nice.checkplus.co.kr/cert/mobileCert/sms/confirm/proc",
    new URLSearchParams({ mobileCo: co, certCode: code }).toString(),
    { headers: h }
  );
  return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
}

/* ============================================================
   Discord 인터랙션 핸들러 (NICE 전용)
============================================================ */

// 통신사 선택 셀렉트 메뉴 처리
export async function handleTelecomSelect(interaction) {
  const selectedValue = interaction.values[0];
  const co = selectedValue.replace("telecom_", "");

  // 세션 생성 & 캡챠 전송
  await interaction.deferReply({ ephemeral: true });
  const sessionData = await makeSession(co);

  fs.mkdirSync("tmp", { recursive: true });
  const fileName = `cap_${interaction.user.id}.png`;
  const imgPath  = path.join("tmp", fileName);
  fs.writeFileSync(imgPath, sessionData.img);

  const serial = Math.floor(Math.random() * 900000) + 100000;
  verifySessions[serial] = { d: sessionData, co, uid: interaction.user.id };

  await interaction.followUp({
    components: [
      new ContainerBuilder()
        .setAccentColor(0xffffff)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 본인인증"))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("아래 캡챠 이미지를 확인하고 **입력** 버튼을 눌러주세요."))
        .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(item => item.setURL(`attachment://${fileName}`)))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(false))
        .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`start_input_${serial}`).setLabel("입력").setStyle(ButtonStyle.Success)
        )),
    ],
    files: [new AttachmentBuilder(imgPath, { name: fileName })],
    flags: MessageFlags.IsComponentsV2,
    ephemeral: true,
  });
  fs.unlinkSync(imgPath);
}

// 캡챠 입력 버튼 → 모달
export async function handleStartInputButton(interaction) {
  const serial = parseInt(interaction.customId.replace("start_input_", ""));
  if (!verifySessions[serial]) { await interaction.reply({ content: "세션이 만료되었습니다.", ephemeral: true }); return; }
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`info_modal_${serial}`)
      .setTitle("본인인증")
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("이름").setPlaceholder("홍길동").setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(20)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("br").setLabel("생년월일+성별").setPlaceholder("0101013").setStyle(TextInputStyle.Short).setMinLength(7).setMaxLength(7)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ph").setLabel("휴대폰번호").setPlaceholder("01012345678").setStyle(TextInputStyle.Short).setMinLength(11).setMaxLength(11)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cp").setLabel("캡챠 (이미지 숫자)").setPlaceholder("123456").setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(10)),
      )
  );
}

// 인증번호 입력 버튼 → 모달
export async function handleCodeInputButton(interaction) {
  const serial = parseInt(interaction.customId.replace("code_input_", ""));
  if (!verifySessions[serial]) { await interaction.reply({ content: "세션이 만료되었습니다.", ephemeral: true }); return; }
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`code_modal_${serial}`)
      .setTitle("인증번호 입력")
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cd").setLabel("인증번호").setPlaceholder("123456").setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6))
      )
  );
}

// 개인정보 모달 제출
export async function handleInfoModal(interaction) {
  const serial = parseInt(interaction.customId.replace("info_modal_", ""));
  const sd = verifySessions[serial];
  if (!sd) { await interaction.reply({ content: "세션이 만료되었습니다.", ephemeral: true }); return; }

  await interaction.deferReply({ ephemeral: true });
  const nm = interaction.fields.getTextInputValue("nm");
  const br = interaction.fields.getTextInputValue("br");
  const ph = interaction.fields.getTextInputValue("ph");
  const cp = interaction.fields.getTextInputValue("cp");

  const result = await sendSms(sd.d, nm, sd.co, br.slice(0, -1), br.slice(-1), ph, cp);
  if (result.code === "RETRY") {
    await interaction.followUp({
      components: [new ContainerBuilder().setAccentColor(0xff0000).addTextDisplayComponents(new TextDisplayBuilder().setContent("## ❌ 실패")).addSeparatorComponents(new SeparatorBuilder().setDivider(true)).addTextDisplayComponents(new TextDisplayBuilder().setContent(result.message))],
      flags: MessageFlags.IsComponentsV2, ephemeral: true,
    });
    return;
  }

  verifySessions[serial] = { ...sd, nm, br, ph };
  await interaction.followUp({
    components: [
      new ContainerBuilder()
        .setAccentColor(0xffffcf)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📨 인증번호 발송 완료"))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("문자로 받은 인증번호를 입력하세요. **(3분 유효)**"))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(false))
        .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`code_input_${serial}`).setLabel("인증하기").setStyle(ButtonStyle.Success)
        )),
    ],
    flags: MessageFlags.IsComponentsV2, ephemeral: true,
  });
}

// 인증번호 모달 제출
export async function handleCodeModal(interaction) {
  try {
  const serial = parseInt(interaction.customId.replace("code_modal_", ""));
  const sd = verifySessions[serial];
  if (!sd) { await interaction.reply({ content: "세션이 만료되었습니다.", ephemeral: true }); return; }

  await interaction.deferReply({ ephemeral: true });
  const result = await verifyCode(sd.d, sd.co, interaction.fields.getTextInputValue("cd"));

  if (result.code === "SUCCESS") {
    // 동일 전화번호로 다른 계정이 이미 인증됐는지 확인
    const existing = findByPhoneHash(sd.ph);
    if (existing && existing.discord_id !== sd.uid) {
      await interaction.followUp({
        components: [
          new ContainerBuilder()
            .setAccentColor(0xff0000)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ❌ 인증 불가"))
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
              "이미 다른 계정으로 인증된 전화번호입니다.\n동일 번호로 중복 인증은 허용되지 않습니다."
            )),
        ],
        flags: MessageFlags.IsComponentsV2, ephemeral: true,
      });
      return;
    }

    addVerifiedNice({ discordId: sd.uid, realName: sd.nm, birthday: sd.br, phone: sd.ph, telecom: sd.co });
    delete verifySessions[serial];

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

    // 사용자에게 완료 메시지
    await interaction.followUp({
      components: [
        new ContainerBuilder()
          .setAccentColor(0x00ff00)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ✅ 인증 완료"))
          .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**이제 코인대행을 이용하실수 있습니다.**`
          )),
      ],
      flags: MessageFlags.IsComponentsV2, ephemeral: true,
    });

    // 로그 채널에 인증 정보 전송
    try {
      const logChannelId = process.env.Vfchh;
      if (logChannelId) {
        const logChannel = await interaction.client.channels.fetch(logChannelId);
        if (logChannel) {
          await logChannel.send({
            components: [
              new ContainerBuilder()
                .setAccentColor(0xffffff)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 본인인증 완료 로그"))
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                  `**디스코드:** <@${sd.uid}> \`(${sd.uid})\`\n` +
                  `**이름:** ${sd.nm}\n` +
                  `**생년월일:** ${sd.br}\n` +
                  `**전화번호:** ${sd.ph}\n` +
                  `**통신사:** ${sd.co}\n` +
                  `**인증일시:** ${now}`
                )),
            ],
            flags: MessageFlags.IsComponentsV2,
          });
        }
      }
    } catch (e) { console.error("인증 로그 전송 실패:", e.message); }

  } else {
    await interaction.followUp({
      components: [new ContainerBuilder().setAccentColor(0xff0000).addTextDisplayComponents(new TextDisplayBuilder().setContent("## ❌ 실패")).addSeparatorComponents(new SeparatorBuilder().setDivider(true)).addTextDisplayComponents(new TextDisplayBuilder().setContent(result.message || "오류가 발생했습니다."))],
      flags: MessageFlags.IsComponentsV2, ephemeral: true,
    });
  }
  } catch (e) {
    console.error("handleCodeModal 오류:", e);
    try { await interaction.followUp({ content: `❌ 오류가 발생했습니다: ${e.message}`, ephemeral: true }); } catch {}
  }
}
