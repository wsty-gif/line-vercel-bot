import { google } from "googleapis";

const userState = new Map();

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LEAD_TIME_MS = 60 * 60 * 1000; // 現在時刻から1時間後以降

function getPrivateKey() {
  const key = process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: getPrivateKey(),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const authClient = await auth.getClient();
  return google.calendar({ version: "v3", auth: authClient });
}

function toJst(date) {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function getJstParts(date) {
  const j = toJst(date);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    weekday: j.getUTCDay(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

function makeUtcDateFromJst(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0));
}

function toGoogleJstDateTime(date) {
  const j = toJst(date);

  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, "0");
  const d = String(j.getUTCDate()).padStart(2, "0");
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  const ss = String(j.getUTCSeconds()).padStart(2, "0");

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+09:00`;
}

function isWeekdayJst(year, month, day) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function overlaps(slotStart, slotEnd, busyStart, busyEnd) {
  return slotStart < busyEnd && slotEnd > busyStart;
}

function formatSlotLabel(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const j = toJst(date);

  const m = j.getUTCMonth() + 1;
  const d = j.getUTCDate();
  const w = weekdays[j.getUTCDay()];
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");

  return `${m}/${d}(${w}) ${hh}:${mm}`;
}

function createFirstQuestionMessage() {
  return {
    type: "text",
    text:
      "ご登録ありがとうございます😊\n\n" +
      "株式会社TETOTEの転職サポート窓口です😊\n" +
      "正社員転職のご相談を無料で行っています！\n\n" +
      "まずはプロフィールとご希望条件を教えてください。\n\n" +
      "最初に、お名前を入力してください。\n" +
      "※やり直したい場合は「やり直し」と送ってください。",
  };
}

function quickReply(text, options) {
  return {
    type: "text",
    text,
    quickReply: {
      items: options.map((o) => ({
        type: "action",
        action: {
          type: "message",
          label: o,
          text: o,
        },
      })),
    },
  };
}

function createSlotQuickReply(slots, offset = 0) {
  const slotItems = slots.map((slot) => ({
    type: "action",
    action: {
      type: "postback",
      label: slot.label,
      data: JSON.stringify({
        type: "booking_select",
        start: slot.start,
        end: slot.end,
        label: slot.label,
      }),
      displayText: slot.label,
    },
  }));

  const extraItems = [
    {
      type: "action",
      action: {
        type: "postback",
        label: "別の候補を見る",
        data: JSON.stringify({
          type: "booking_more",
          offset: offset + slots.length,
        }),
        displayText: "別の候補を見る",
      },
    },
    {
      type: "action",
      action: {
        type: "postback",
        label: "その他の日程を希望",
        data: JSON.stringify({
          type: "booking_other_request",
        }),
        displayText: "その他の日程を希望",
      },
    },
  ];

  return {
    type: "text",
    text: "面談候補日をお送りします😊\nご都合の良い日時を1つ選んでください。",
    quickReply: {
      items: [...slotItems, ...extraItems],
    },
  };
}

async function reply(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  const text = await res.text();
  console.log("LINE reply status:", res.status);
  console.log("LINE reply body:", text);

  if (!res.ok) {
    throw new Error(`LINE reply failed: ${res.status} ${text}`);
  }
}

async function pushMessage(userId, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      to: userId,
      messages,
    }),
  });

  const text = await res.text();
  console.log("LINE push status:", res.status);
  console.log("LINE push body:", text);

  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${text}`);
  }
}

async function saveToGas(data) {
  const gasUrl = process.env.GAS_SAVE_URL;
  if (!gasUrl) {
    console.log("GAS_SAVE_URL not set");
    return;
  }

  const res = await fetch(gasUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const text = await res.text();
  console.log("saveToGas status:", res.status);
  console.log("saveToGas body:", text);

  if (!res.ok) {
    throw new Error(`saveToGas failed: ${res.status} ${text}`);
  }
}

async function getBusyList() {
  const calendar = await getCalendarClient();

  const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const now = new Date();
  const after7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: after7days.toISOString(),
      timeZone: "Asia/Tokyo",
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const busyList = [];
  for (const id of calendarIds) {
    const arr = fb.data.calendars?.[id]?.busy || [];
    for (const b of arr) {
      busyList.push({
        start: new Date(b.start),
        end: new Date(b.end),
      });
    }
  }

  return busyList;
}

async function getAvailableSlots(offset = 0, limit = 5) {
  const busyList = await getBusyList();

  const now = new Date();
  const minSelectableTime = new Date(now.getTime() + LEAD_TIME_MS);
  const baseJst = getJstParts(now);

  const allSlots = [];

  for (let i = 0; i < 7; i++) {
    const jstDayBase = new Date(
      Date.UTC(baseJst.year, baseJst.month - 1, baseJst.day + i)
    );

    const year = jstDayBase.getUTCFullYear();
    const month = jstDayBase.getUTCMonth() + 1;
    const day = jstDayBase.getUTCDate();

    if (!isWeekdayJst(year, month, day)) continue;

    for (let hour = 10; hour < 18; hour++) {
      for (const minute of [0, 30]) {
        const slotStart = makeUtcDateFromJst(year, month, day, hour, minute);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

        const endJst = getJstParts(slotEnd);
        if (endJst.hour > 18 || (endJst.hour === 18 && endJst.minute > 0)) {
          continue;
        }

        if (slotStart < minSelectableTime) {
          continue;
        }

        const isBusy = busyList.some((b) =>
          overlaps(slotStart, slotEnd, b.start, b.end)
        );

        if (!isBusy) {
          allSlots.push({
            label: formatSlotLabel(slotStart),
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
          });
        }
      }
    }
  }

  return allSlots.slice(offset, offset + limit);
}

async function isStillAvailable(start, end) {
  const calendar = await getCalendarClient();

  const calendarIds = (process.env.SOURCE_CALENDAR_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: start,
      timeMax: end,
      timeZone: "Asia/Tokyo",
      items: calendarIds.map((id) => ({ id })),
    },
  });

  for (const id of calendarIds) {
    const busy = fb.data.calendars?.[id]?.busy || [];
    if (busy.length > 0) {
      return false;
    }
  }

  return true;
}

async function createBookingEvent(state, slot) {
  const calendar = await getCalendarClient();

  const startDate = new Date(slot.start);
  const endDate = new Date(slot.end);

  const result = await calendar.events.insert({
    calendarId: process.env.BOOKING_CALENDAR_ID,
    requestBody: {
      summary: `LINE面談予約｜${state.name}｜${state.job}`,
      description:
        `名前: ${state.name}\n` +
        `年齢: ${state.age}\n` +
        `電話番号: ${state.phone}\n\n` +
        `希望職種: ${state.job}\n` +
        `希望勤務地: ${state.area}\n` +
        `転職時期: ${state.timing}\n` +
        `予約枠: ${slot.label}\n` +
        `LINE userId: ${state.userId || ""}`,
      start: {
        dateTime: toGoogleJstDateTime(startDate),
        timeZone: "Asia/Tokyo",
      },
      end: {
        dateTime: toGoogleJstDateTime(endDate),
        timeZone: "Asia/Tokyo",
      },
    },
  });

  console.log("booking event id:", result.data.id);
  console.log("booking event htmlLink:", result.data.htmlLink);
  console.log("booking event start:", result.data.start);
  console.log("booking event end:", result.data.end);

  return result.data;
}

async function createManualAdjustmentEvent(state, manualRequest) {
  const calendar = await getCalendarClient();

  const startDate = new Date(Date.now() + 5 * 60 * 1000);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  const result = await calendar.events.insert({
    calendarId: process.env.BOOKING_CALENDAR_ID,
    requestBody: {
      summary: `【要調整】LINE面談｜${state.name}｜${state.job}`,
      description:
        `名前: ${state.name}\n` +
        `年齢: ${state.age}\n` +
        `電話番号: ${state.phone}\n\n` +
        `希望職種: ${state.job}\n` +
        `希望勤務地: ${state.area}\n` +
        `転職時期: ${state.timing}\n\n` +
        `希望日時メモ: ${manualRequest}\n` +
        `LINE userId: ${state.userId || ""}\n` +
        `※この予定は手動調整用の仮登録です。`,
      start: {
        dateTime: toGoogleJstDateTime(startDate),
        timeZone: "Asia/Tokyo",
      },
      end: {
        dateTime: toGoogleJstDateTime(endDate),
        timeZone: "Asia/Tokyo",
      },
    },
  });

  console.log("manual booking event id:", result.data.id);
  console.log("manual booking event htmlLink:", result.data.htmlLink);
  console.log("manual booking event start:", result.data.start);
  console.log("manual booking event end:", result.data.end);

  return result.data;
}

async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === "follow") {
    userState.set(userId, {
      step: "name",
      userId,
      name: "",
      age: "",
      phone: "",
      job: "",
      area: "",
      timing: "",
    });

    await reply(event.replyToken, [createFirstQuestionMessage()]);
    return;
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = event.message.text.trim();

    if (["最初から", "やり直し", "リセット"].includes(text)) {
      userState.set(userId, {
        step: "name",
        userId,
        name: "",
        age: "",
        phone: "",
        job: "",
        area: "",
        timing: "",
      });

      await reply(event.replyToken, [
        {
          type: "text",
          text: "入力を最初からやり直します😊",
        },
        createFirstQuestionMessage(),
      ]);
      return;
    }

    const state = userState.get(userId);

    if (!state) {
      userState.set(userId, {
        step: "name",
        userId,
        name: "",
        age: "",
        phone: "",
        job: "",
        area: "",
        timing: "",
      });

      await reply(event.replyToken, [
        {
          type: "text",
          text: "最初からご案内します😊",
        },
        createFirstQuestionMessage(),
      ]);
      return;
    }

    if (state.step === "booking_manual_request") {
      try {
        const manualBooking = await createManualAdjustmentEvent(state, text);

        await saveToGas({
          userId,
          name: state.name,
          age: state.age,
          phone: state.phone,
          job: state.job,
          area: state.area,
          timing: state.timing,
          bookingLabel: "手動調整希望",
          bookingStart: manualBooking.start?.dateTime || "",
          bookingEnd: manualBooking.end?.dateTime || "",
          bookingEventId: manualBooking.id || "",
          bookingHtmlLink: manualBooking.htmlLink || "",
          manualRequest: text,
        });

        await reply(event.replyToken, [
          {
            type: "text",
            text:
              "ありがとうございます😊\n" +
              "ご希望日時を受け付けました。\n" +
              "手動調整用としてカレンダーにも登録しましたので、担当者より調整のうえ改めてご連絡いたします。",
          },
        ]);

        userState.delete(userId);
        return;
      } catch (error) {
        console.error("manual booking error:", error);

        await reply(event.replyToken, [
          {
            type: "text",
            text:
              "ご希望日時は受け付けましたが、手動調整用の登録でエラーが発生しました。\n" +
              "担当者より改めてご連絡いたします。",
          },
        ]);
        return;
      }
    }

    if (state.step === "name") {
      state.name = text;
      state.step = "age";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply("年齢を選択してください", [
          "18～19",
          "20～24",
          "25～29",
          "30～34",
          "35～39",
          "40～44",
          "45～49",
          "50歳以上",
        ]),
      ]);
      return;
    }

    if (state.step === "age") {
      state.age = text;
      state.step = "phone";
      userState.set(userId, state);

      await reply(event.replyToken, [
        {
          type: "text",
          text: "ありがとうございます😊\n\n電話番号を入力してください。",
        },
      ]);
      return;
    }

    if (state.step === "phone") {
      state.phone = text;
      state.step = "job";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n\n希望職種を選んでください。",
          ["営業", "事務", "販売", "施工管理", "コールセンター", "IT", "その他"]
        ),
      ]);
      return;
    }

    if (state.step === "job") {
      state.job = text;
      state.step = "area";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n\n次に、ご希望の勤務地を1つ選んでください。",
          ["関東", "関西", "東海", "九州", "全国", "こだわりなし"]
        ),
      ]);
      return;
    }

    if (state.step === "area") {
      state.area = text;
      state.step = "timing";
      userState.set(userId, state);

      await reply(event.replyToken, [
        quickReply(
          "ありがとうございます😊\n\n最後に、転職したい時期を1つ選んでください。",
          ["すぐに", "1か月以内", "3か月以内", "半年以内", "良い求人があれば"]
        ),
      ]);
      return;
    }

    if (state.step === "timing") {
      state.timing = text;
      state.step = "booking_select";
      userState.set(userId, state);

      const slots = await getAvailableSlots(0, 5);

      if (slots.length === 0) {
        await reply(event.replyToken, [
          {
            type: "text",
            text: "現在ご案内できる面談候補が見つかりませんでした。担当より別途ご連絡いたします。",
          },
        ]);
        return;
      }

      await reply(event.replyToken, [createSlotQuickReply(slots, 0)]);
      return;
    }

    await reply(event.replyToken, [
      {
        type: "text",
        text: "ご希望条件は確認済みです。候補日時の選択をお願いします😊",
      },
    ]);
    return;
  }

  if (event.type === "postback") {
    const state = userState.get(userId);

    if (!state) {
      await reply(event.replyToken, [
        {
          type: "text",
          text: "予約情報の保持に失敗しました。恐れ入りますが、最初からもう一度お試しください。",
        },
      ]);
      return;
    }

    try {
      const rawData = event.postback?.data || "{}";
      console.log("postback rawData:", rawData);

      const data = JSON.parse(rawData);
      console.log("postback parsed:", data);

      if (data.type === "booking_more") {
        await reply(event.replyToken, [
          {
            type: "text",
            text: "別の候補日をお送りします😊",
          },
        ]);

        const slots = await getAvailableSlots(data.offset || 0, 5);

        if (slots.length === 0) {
          await pushMessage(userId, [
            {
              type: "text",
              text: "他にご案内できる候補が見つかりませんでした。ご希望日時があれば、そのままメッセージでお送りください。",
            },
          ]);
          return;
        }

        await pushMessage(userId, [createSlotQuickReply(slots, data.offset || 0)]);
        return;
      }

      if (data.type === "booking_other_request") {
        state.step = "booking_manual_request";
        userState.set(userId, state);

        await reply(event.replyToken, [
          {
            type: "text",
            text:
              "承知しました😊\n" +
              "ご希望の日時があれば、第1希望〜第3希望までメッセージでお送りください。\n\n" +
              "例）\n" +
              "・3/15 18:00以降\n" +
              "・3/16 10:00〜12:00\n" +
              "・3/17 終日可能",
          },
        ]);
        return;
      }

      if (data.type === "booking_select") {
        await reply(event.replyToken, [
          {
            type: "text",
            text: `ご希望日時「${data.label}」で予約処理を進めています。少々お待ちください😊`,
          },
        ]);

        try {
          const available = await isStillAvailable(data.start, data.end);
          console.log("still available:", available);

          if (!available) {
            const slots = await getAvailableSlots(0, 5);

            if (slots.length === 0) {
              await pushMessage(userId, [
                {
                  type: "text",
                  text: "申し訳ありません。選択された時間は埋まってしまいました。担当より別途ご連絡いたします。",
                },
              ]);
              userState.delete(userId);
              return;
            }

            await pushMessage(userId, [
              {
                type: "text",
                text: "申し訳ありません。選択された時間は埋まってしまいました。別の候補をお送りします。",
              },
              createSlotQuickReply(slots, 0),
            ]);
            return;
          }

          const booking = await createBookingEvent(state, {
            label: data.label,
            start: data.start,
            end: data.end,
          });

          await saveToGas({
            userId,
            name: state.name,
            age: state.age,
            phone: state.phone,
            job: state.job,
            area: state.area,
            timing: state.timing,
            bookingLabel: data.label,
            bookingStart: data.start,
            bookingEnd: data.end,
            bookingEventId: booking.id,
            bookingHtmlLink: booking.htmlLink || "",
            manualRequest: "",
          });

          await pushMessage(userId, [
            {
              type: "text",
              text:
                `面談予約を受け付けました😊\n\n` +
                `お名前：${state.name}\n` +
                `予約日時：${data.label}\n` +
                `希望職種：${state.job}\n` +
                `希望勤務地：${state.area}\n` +
                `転職時期：${state.timing}\n\n` +
                `担当者より改めてご連絡いたします。`,
            },
          ]);

          userState.delete(userId);
          return;
        } catch (error) {
          console.error("postback booking error:", error);

          await pushMessage(userId, [
            {
              type: "text",
              text: "申し訳ありません。予約処理中にエラーが発生しました。担当より別途ご連絡いたします。",
            },
          ]);
          return;
        }
      }

      await reply(event.replyToken, [
        {
          type: "text",
          text: "予約内容の判定に失敗しました。恐れ入りますが、もう一度お試しください。",
        },
      ]);
      return;
    } catch (error) {
      console.error("postback parse error:", error);

      await reply(event.replyToken, [
        {
          type: "text",
          text: "申し訳ありません。予約処理中にエラーが発生しました。担当より別途ご連絡いたします。",
        },
      ]);
      return;
    }
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return new Response("OK", { status: 200 });
    }

    if (request.method === "POST") {
      try {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const events = body.events || [];

        for (const event of events) {
          await handleEvent(event);
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("webhook error:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};