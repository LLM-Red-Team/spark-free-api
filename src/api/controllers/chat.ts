import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import FormData from "form-data";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "spark";
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cache-Control": "no-cache",
  Origin: "https://xinghuo.xfyun.cn",
  Pragma: "no-cache",
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  Referer: "https://xinghuo.xfyun.cn/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 生成Cookie
 *
 * @param ssoSessionId 登录态ID
 */
function generateCookie(ssoSessionId: string) {
  return [
    `JSESSIONID=A66730ECFCD6E33D0FD7E3F0D190437A`,
    `di_c_mti=${util.uuid()}`,
    `d_d_app_ver=1.4.0`,
    `daas_st=${encodeURIComponent(
      JSON.stringify({
        sdk_ver: "1.3.9",
        status: "0",
      })
    )}`,
    `appid=150b4dfebe`,
    `d_d_ci=${util.uuid()}`,
    `ssoSessionId=${ssoSessionId}`,
    `account_id=18${util.generateRandomString({
      length: 9,
      charset: "numeric",
    })}`,
  ].join("; ");
}

/**
 * 创建会话
 *
 * 创建临时的会话用于对话补全
 *
 * @param ssoSessionId 登录态ID
 */
async function createConversation(ssoSessionId: string, assistantId?: string) {
  const result = await axios.post(
    "https://xinghuo.xfyun.cn/iflygpt/u/chat-list/v1/create-chat-list",
    assistantId ? {
      botId: assistantId
    } : {},
    {
      headers: {
        Clienttype: "1",
        "Lang-Code": "zh",
        ...FAKE_HEADERS,
        Cookie: generateCookie(ssoSessionId),
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const { id: convId } = checkResult(result);
  return `${convId}`;
}

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param ssoSessionId 登录态ID
 */
async function removeConversation(convId: string, ssoSessionId: string) {
  const result = await axios.post(
    "https://xinghuo.xfyun.cn/iflygpt/u/chat-list/v1/del-chat-list",
    {
      chatListId: convId,
    },
    {
      headers: {
        Clienttype: "1",
        "Lang-Code": "zh",
        ...FAKE_HEADERS,
        Cookie: generateCookie(ssoSessionId),
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  checkResult(result);
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ssoSessionId 登录态ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  ssoSessionId: string,
  refConvId: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 智能体ID解析
    const assistantId = /^\d{3,}$/.test(model) ? model : null;
    assistantId && logger.info(`选用智能体ID: ${assistantId}`);

    let convId;

    // 引用对话ID处理
    let sid;
    if (/[0-9]{9,}\:cht/.test(refConvId))
      ([convId, sid] = refConvId.split(':'))

    // 创建会话
    convId = convId || await createConversation(ssoSessionId, assistantId);

    // 提取引用文件URL并上传spark获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
        refFileUrls.map((fileUrl) =>
          uploadFile(convId, fileUrl, ssoSessionId)
        )
      )
      : [];

    // 请求流
    const formData = new FormData();
    formData.append(
      "fd",
      util.generateRandomString({ length: 6, charset: "numeric" })
    );
    formData.append("isBot", assistantId ? "1" : "0");
    assistantId && formData.append("botId", assistantId);
    formData.append("clientType", "1");
    formData.append("text", messagesPrepare(messages, !!refConvId));
    sid && formData.append("sid", sid);
    formData.append("chatId", convId);
    formData.append(
      "GtToken",
      "RzAwAGPhPKm+/9ZXJiBczVs0AJi32oPNZVXQxtWEjWBIP9R/jABbXLN0ESmMLCIj91w3ZeXT4J1ZA4CGcf14DgMDKWSDHLHnQIkotlkRhVEYSb/o58dKgu3LjYLC3Dy+76/agYQkhpiOdVc7s68bfGYLvibLdyrIJyX42a0GErTall8JYmiq6IO5K1w4je2QeYheEpKKqyttEjWnOBUAKrXx2kLYetnIebNyFOKr8o1A7jvKdNA6YfdpoJg0tHA3SQc72eiL0lO4/3kP1FWhonscdvH/88j5KRX76bO0u3+Fqt7FyFkHfLIcrZGN5HAc5GUuZrCUkf/OpePeNtPQ9gOC5pI8BlFnZQX9s2xFUv+R8Ijj6N5FNHBBhSJL/B5MYtMxMAmxOvs1rv/EACslRc2NJQb1Vu1BSFye//ATQZYTA6+Ox+BqTFcAy/yDEYRZE53ML1DZ4gG9QwmejVWLbW5N+dWPnbscua2/ZM20oIABd5NK6tp+6aQ71oen2mq/ADf17ekoH7zn/fe0U6pBGOVnl/+hDotMPbXbhzd6QBj3RIIaDBRFJdBI7AWkfe6DZvss+bURUcxy+B4wbkBc9E7791LYFKAHjh0poIT9L+Yz+rDihSIJLTBe0zcjOLRefFXyxB4zwfmIJhCNcrHWzL3+BhsZuGrd3LovOOGMObOOloAD2FYeizATyourGcz8U10POOF/ZnaAJOH7vMijGD9UhcPtPUgDzSWX6TZc+QUCM4XcGfbPcNIx9Y47OLEtsgsrrBNPPUXZLVV4ywR5mM0YU5i8Xzcba8QPuEnwI8GY09MIKCqwS+SYphKHdWn06Xm4mAT5wQtUXB1FVB6vmdnimhSdp8YF3y85xu1I7pTbAHU6y8MvX5WUS9KBMu5YSu02S4RGaXZgbsGSVMqtMyVunpNZ/uozjFbQZLF09R2hX94iFCiEfJ9F4EuEZWXFpiRrlNPjkVNWk7fyy4b8cTIN1myIeKbCRVGBj8pgoUbxkOjxZuVVpAXvKHyo0UuuXIpggLKx+rUZTg9GcJO7bowuRHvxF6wqayZsrT4NkLHiKgH9PP8wWCG/IBjCksmpB8AXmMMq6c5yyrXrXSg865OgLjM40+GyjzLsyLtOSLagbmCv9PsWEm5nlrUq+5J+kFEHRvvhybuuJ9cdsz9c/J2A+9i6xOePi2cEGKCmQrnbuGuS2UINZvc0L2F2RiPN3quzJ0yvUpSEt+Do37lj+sKY5vowdtP0BWka0NtHEYF8fpwNBj4DzELhZFZg/cnFgaf1EySk4/bCQtaZumrra3skfYrlWPP9IPRbDUNS5piqEg0IbKSGVIVMuShJzsiWvgEuWHIVzZEurIXR8UJ3h/XB4ciaFdDCjdo///Y7yRH00luqDLF9rnB9BRFfSOCxnH6fC0ZpW5qLpq3fFA3OuFgsGUENUaOBSYc1V5sZmGrpqHv+cSNvfyPXRuR3gHHbY4k0wFWWWXsCKdT+GQM9lD2eXzRrw5mRckGr+578Xa3Evf8tHAVSRo1HJTI2BmZQYhHxRia+LO/xCFdnLr7nwFqJ5cUWbqlCGmKNykPVZcuCJMr3qaVK2ED/GLB/6JB+0xXmtLJjm3qltNuu0Hv7cIdctXBQMcUP/NgxL2e1FPO6TbJjlwFBMcTjWmS9IjAb/irqZd/xEO/0Ak6rZo8twB6vIIhh8IVnPkOH037nbb27yc8XfT0CwZKX20nkKNtCpngghbAic7a8i9t3EulTvoJ1F37LnQ2F7OZ4JjSOKMgh6pw8GPp+mN0RZ/pfQIYc/HDhhLKN5cSdUaRjFdtxHuTd7B9nx/DA/fScgTOo7BA8lkxYp66bnvdoEfEzt8SM6Wm92JRYnARSVJpndJJCdFoRHVWFqHYzqlQaHYysiMo/vz6/fg=="
    );
    if (refs.filter((v) => v).length > 0)
      formData.append("fileUrl", refs.join(","));
    const result = await axios.request({
      method: "POST",
      url:
        refs.indexOf(null) == -1
          ? "https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat"
          : "https://xinghuo.xfyun.cn/iflygpt-longcontext/u/chat_message/web/chat",
      data: formData,
      headers: {
        ...FAKE_HEADERS,
        Botweb: "0",
        Challenge: "undefined",
        Cookie: generateCookie(ssoSessionId),
        Seccode: "",
        Validate: "undefined",
      },
      // 120秒超时
      timeout: 120000,
      validateStatus: () => true,
      responseType: "stream",
    });

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    !refConvId && removeConversation(convId, ssoSessionId).catch((err) => logger.error(err));

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`, err);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(model, messages, ssoSessionId, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ssoSessionId 登录态ID
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  ssoSessionId: string,
  refConvId?: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 智能体ID解析
    const assistantId = /^\d{3,}$/.test(model) ? model : null;
    assistantId && logger.info(`选用智能体ID: ${assistantId}`);

    let convId;

    // 引用对话ID处理
    let sid;
    if (/[0-9]{9,}\:cht/.test(refConvId))
      ([convId, sid] = refConvId.split(':'))

    // 创建会话
    convId = convId || await createConversation(ssoSessionId, assistantId);

    // 提取引用文件URL并上传spark获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
        refFileUrls.map((fileUrl) =>
          uploadFile(convId, fileUrl, ssoSessionId)
        )
      )
      : [];

    // 请求流
    const formData = new FormData();
    formData.append(
      "fd",
      util.generateRandomString({ length: 6, charset: "numeric" })
    );
    formData.append("isBot", assistantId ? "1" : "0");
    assistantId && formData.append("botId", assistantId);
    formData.append("clientType", "1");
    formData.append("text", messagesPrepare(messages, !!refConvId));
    sid && formData.append("sid", sid);
    formData.append("chatId", convId);
    formData.append(
      "GtToken",
      "RzAwAGPhPKm+/9ZXJiBczVs0AJi32oPNZVXQxtWEjWBIP9R/jABbXLN0ESmMLCIj91w3ZeXT4J1ZA4CGcf14DgMDKWSDHLHnQIkotlkRhVEYSb/o58dKgu3LjYLC3Dy+76/agYQkhpiOdVc7s68bfGYLvibLdyrIJyX42a0GErTall8JYmiq6IO5K1w4je2QeYheEpKKqyttEjWnOBUAKrXx2kLYetnIebNyFOKr8o1A7jvKdNA6YfdpoJg0tHA3SQc72eiL0lO4/3kP1FWhonscdvH/88j5KRX76bO0u3+Fqt7FyFkHfLIcrZGN5HAc5GUuZrCUkf/OpePeNtPQ9gOC5pI8BlFnZQX9s2xFUv+R8Ijj6N5FNHBBhSJL/B5MYtMxMAmxOvs1rv/EACslRc2NJQb1Vu1BSFye//ATQZYTA6+Ox+BqTFcAy/yDEYRZE53ML1DZ4gG9QwmejVWLbW5N+dWPnbscua2/ZM20oIABd5NK6tp+6aQ71oen2mq/ADf17ekoH7zn/fe0U6pBGOVnl/+hDotMPbXbhzd6QBj3RIIaDBRFJdBI7AWkfe6DZvss+bURUcxy+B4wbkBc9E7791LYFKAHjh0poIT9L+Yz+rDihSIJLTBe0zcjOLRefFXyxB4zwfmIJhCNcrHWzL3+BhsZuGrd3LovOOGMObOOloAD2FYeizATyourGcz8U10POOF/ZnaAJOH7vMijGD9UhcPtPUgDzSWX6TZc+QUCM4XcGfbPcNIx9Y47OLEtsgsrrBNPPUXZLVV4ywR5mM0YU5i8Xzcba8QPuEnwI8GY09MIKCqwS+SYphKHdWn06Xm4mAT5wQtUXB1FVB6vmdnimhSdp8YF3y85xu1I7pTbAHU6y8MvX5WUS9KBMu5YSu02S4RGaXZgbsGSVMqtMyVunpNZ/uozjFbQZLF09R2hX94iFCiEfJ9F4EuEZWXFpiRrlNPjkVNWk7fyy4b8cTIN1myIeKbCRVGBj8pgoUbxkOjxZuVVpAXvKHyo0UuuXIpggLKx+rUZTg9GcJO7bowuRHvxF6wqayZsrT4NkLHiKgH9PP8wWCG/IBjCksmpB8AXmMMq6c5yyrXrXSg865OgLjM40+GyjzLsyLtOSLagbmCv9PsWEm5nlrUq+5J+kFEHRvvhybuuJ9cdsz9c/J2A+9i6xOePi2cEGKCmQrnbuGuS2UINZvc0L2F2RiPN3quzJ0yvUpSEt+Do37lj+sKY5vowdtP0BWka0NtHEYF8fpwNBj4DzELhZFZg/cnFgaf1EySk4/bCQtaZumrra3skfYrlWPP9IPRbDUNS5piqEg0IbKSGVIVMuShJzsiWvgEuWHIVzZEurIXR8UJ3h/XB4ciaFdDCjdo///Y7yRH00luqDLF9rnB9BRFfSOCxnH6fC0ZpW5qLpq3fFA3OuFgsGUENUaOBSYc1V5sZmGrpqHv+cSNvfyPXRuR3gHHbY4k0wFWWWXsCKdT+GQM9lD2eXzRrw5mRckGr+578Xa3Evf8tHAVSRo1HJTI2BmZQYhHxRia+LO/xCFdnLr7nwFqJ5cUWbqlCGmKNykPVZcuCJMr3qaVK2ED/GLB/6JB+0xXmtLJjm3qltNuu0Hv7cIdctXBQMcUP/NgxL2e1FPO6TbJjlwFBMcTjWmS9IjAb/irqZd/xEO/0Ak6rZo8twB6vIIhh8IVnPkOH037nbb27yc8XfT0CwZKX20nkKNtCpngghbAic7a8i9t3EulTvoJ1F37LnQ2F7OZ4JjSOKMgh6pw8GPp+mN0RZ/pfQIYc/HDhhLKN5cSdUaRjFdtxHuTd7B9nx/DA/fScgTOo7BA8lkxYp66bnvdoEfEzt8SM6Wm92JRYnARSVJpndJJCdFoRHVWFqHYzqlQaHYysiMo/vz6/fg=="
    );
    if (refs.filter((v) => v).length > 0)
      formData.append("fileUrl", refs.join(","));
    const result = await axios.request({
      method: "POST",
      url:
        refs.indexOf(null) == -1
          ? "https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat"
          : "https://xinghuo.xfyun.cn/iflygpt-longcontext/u/chat_message/web/chat",
      data: formData,
      headers: {
        ...FAKE_HEADERS,
        Botweb: "0",
        Challenge: "undefined",
        Cookie: generateCookie(ssoSessionId),
        Seccode: "",
        Validate: "undefined",
      },
      // 120秒超时
      timeout: 120000,
      validateStatus: () => true,
      responseType: "stream",
    });
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, result.data, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      !refConvId && removeConversation(convId, ssoSessionId).catch((err) =>
        logger.error(err)
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          ssoSessionId,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

async function generateImages(
  model = MODEL_NAME,
  prompt: string,
  ssoSessionId: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(prompt);
    const messages = [
      { role: "user", content: prompt.indexOf('画') == -1 ? `请画：${prompt}` : prompt },
    ];

    // 智能体ID解析
    const assistantId = /^\d{3,}$/.test(model) ? model : null;
    assistantId && logger.info(`选用智能体ID: ${assistantId}`);

    // 创建会话
    const convId = await createConversation(ssoSessionId, assistantId);

    // 请求流
    const formData = new FormData();
    formData.append(
      "fd",
      util.generateRandomString({ length: 6, charset: "numeric" })
    );
    formData.append("isBot", assistantId ? "1" : "0");
    assistantId && formData.append("botId", assistantId);
    formData.append("clientType", "1");
    formData.append("text", messagesPrepare(messages));
    formData.append("chatId", convId);
    formData.append(
      "GtToken",
      "RzAwAGPhPKm+/9ZXJiBczVs0AJi32oPNZVXQxtWEjWBIP9R/jABbXLN0ESmMLCIj91w3ZeXT4J1ZA4CGcf14DgMDKWSDHLHnQIkotlkRhVEYSb/o58dKgu3LjYLC3Dy+76/agYQkhpiOdVc7s68bfGYLvibLdyrIJyX42a0GErTall8JYmiq6IO5K1w4je2QeYheEpKKqyttEjWnOBUAKrXx2kLYetnIebNyFOKr8o1A7jvKdNA6YfdpoJg0tHA3SQc72eiL0lO4/3kP1FWhonscdvH/88j5KRX76bO0u3+Fqt7FyFkHfLIcrZGN5HAc5GUuZrCUkf/OpePeNtPQ9gOC5pI8BlFnZQX9s2xFUv+R8Ijj6N5FNHBBhSJL/B5MYtMxMAmxOvs1rv/EACslRc2NJQb1Vu1BSFye//ATQZYTA6+Ox+BqTFcAy/yDEYRZE53ML1DZ4gG9QwmejVWLbW5N+dWPnbscua2/ZM20oIABd5NK6tp+6aQ71oen2mq/ADf17ekoH7zn/fe0U6pBGOVnl/+hDotMPbXbhzd6QBj3RIIaDBRFJdBI7AWkfe6DZvss+bURUcxy+B4wbkBc9E7791LYFKAHjh0poIT9L+Yz+rDihSIJLTBe0zcjOLRefFXyxB4zwfmIJhCNcrHWzL3+BhsZuGrd3LovOOGMObOOloAD2FYeizATyourGcz8U10POOF/ZnaAJOH7vMijGD9UhcPtPUgDzSWX6TZc+QUCM4XcGfbPcNIx9Y47OLEtsgsrrBNPPUXZLVV4ywR5mM0YU5i8Xzcba8QPuEnwI8GY09MIKCqwS+SYphKHdWn06Xm4mAT5wQtUXB1FVB6vmdnimhSdp8YF3y85xu1I7pTbAHU6y8MvX5WUS9KBMu5YSu02S4RGaXZgbsGSVMqtMyVunpNZ/uozjFbQZLF09R2hX94iFCiEfJ9F4EuEZWXFpiRrlNPjkVNWk7fyy4b8cTIN1myIeKbCRVGBj8pgoUbxkOjxZuVVpAXvKHyo0UuuXIpggLKx+rUZTg9GcJO7bowuRHvxF6wqayZsrT4NkLHiKgH9PP8wWCG/IBjCksmpB8AXmMMq6c5yyrXrXSg865OgLjM40+GyjzLsyLtOSLagbmCv9PsWEm5nlrUq+5J+kFEHRvvhybuuJ9cdsz9c/J2A+9i6xOePi2cEGKCmQrnbuGuS2UINZvc0L2F2RiPN3quzJ0yvUpSEt+Do37lj+sKY5vowdtP0BWka0NtHEYF8fpwNBj4DzELhZFZg/cnFgaf1EySk4/bCQtaZumrra3skfYrlWPP9IPRbDUNS5piqEg0IbKSGVIVMuShJzsiWvgEuWHIVzZEurIXR8UJ3h/XB4ciaFdDCjdo///Y7yRH00luqDLF9rnB9BRFfSOCxnH6fC0ZpW5qLpq3fFA3OuFgsGUENUaOBSYc1V5sZmGrpqHv+cSNvfyPXRuR3gHHbY4k0wFWWWXsCKdT+GQM9lD2eXzRrw5mRckGr+578Xa3Evf8tHAVSRo1HJTI2BmZQYhHxRia+LO/xCFdnLr7nwFqJ5cUWbqlCGmKNykPVZcuCJMr3qaVK2ED/GLB/6JB+0xXmtLJjm3qltNuu0Hv7cIdctXBQMcUP/NgxL2e1FPO6TbJjlwFBMcTjWmS9IjAb/irqZd/xEO/0Ak6rZo8twB6vIIhh8IVnPkOH037nbb27yc8XfT0CwZKX20nkKNtCpngghbAic7a8i9t3EulTvoJ1F37LnQ2F7OZ4JjSOKMgh6pw8GPp+mN0RZ/pfQIYc/HDhhLKN5cSdUaRjFdtxHuTd7B9nx/DA/fScgTOo7BA8lkxYp66bnvdoEfEzt8SM6Wm92JRYnARSVJpndJJCdFoRHVWFqHYzqlQaHYysiMo/vz6/fg=="
    );
    const result = await axios.request({
      method: "POST",
      url: "https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat",
      data: formData,
      headers: {
        ...FAKE_HEADERS,
        Botweb: "0",
        Challenge: "undefined",
        Cookie: generateCookie(ssoSessionId),
        Seccode: "",
        Validate: "undefined",
      },
      // 120秒超时
      timeout: 120000,
      validateStatus: () => true,
      responseType: "stream",
    });

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const imageUrls = await receiveImages(result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(convId, ssoSessionId).catch((err) =>
      console.error(err)
    );

    if (imageUrls.length == 0)
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED);

    return imageUrls;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return generateImages(model, prompt, ssoSessionId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach((v) => {
      if (!_.isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      // spark-free-api支持格式
      if (
        v["type"] == "file" &&
        _.isObject(v["file_url"]) &&
        _.isString(v["file_url"]["url"])
      )
        urls.push(v["file_url"]["url"]);
      // 兼容gpt-4-vision-preview API格式
      else if (
        v["type"] == "image_url" &&
        _.isObject(v["image_url"]) &&
        _.isString(v["image_url"]["url"])
      )
        urls.push(v["image_url"]["url"]);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param isRefConv 是否为引用会话
 */
function messagesPrepare(messages: any[], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n透传内容：\n" + content);
  }
  else {
    // 检查最新消息是否含有"type": "image_url"或"type": "file",如果有则注入消息
    let latestMessage = messages[messages.length - 1];
    let hasFileOrImage =
      Array.isArray(latestMessage.content) &&
      latestMessage.content.some(
        (v) => typeof v === "object" && ["file", "image_url"].includes(v["type"])
      );
    if (hasFileOrImage) {
      let newFileMessage = {
        content: "关注用户最新发送文件和消息",
        role: "system",
      };
      messages.splice(messages.length - 1, 0, newFileMessage);
      logger.info("注入提升尾部文件注意力system prompt");
    }
    content = (
      messages.reduce((content, message) => {
        if (Array.isArray(message.content)) {
          return message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + `${message.role || "user"}:${v["text"] || ""}\n`;
          }, content);
        }
        return (content += `${message.role || "user"}:${message.content}\n`);
      }, "") + "assistant:"
    )
      // 移除MD图像URL避免幻觉
      .replace(/\!\[.+\]\(.+\)/g, "")
    logger.info("\n对话合并：\n" + content);
  }
  return content;
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param ssoSessionId 登录态ID
 */
async function uploadFile(
  convId: string,
  fileUrl: string,
  ssoSessionId: string
) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    mimeType = mime.getType(filename);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      // 60秒超时
      timeout: 60000,
    }));
  }

  const formData = new FormData();
  formData.append("file", Buffer.from([]), {
    filename,
    contentType: mimeType,
  });
  // 上传文件到OSS
  let result = await axios.request({
    method: "POST",
    url: "https://xinghuo.xfyun.cn/iflygpt/oss/sign",
    data: formData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 120秒超时
    timeout: 120000,
    headers: {
      ...FAKE_HEADERS,
      Cookie: generateCookie(ssoSessionId),
      "Content-Length": formData.getLengthSync(),
    },
  });
  const { authorization, date, host, url } = checkResult(result);

  // 生成链接
  result = await axios.request({
    method: "POST",
    url: `${url}&authorization=${Buffer.from(authorization).toString(
      "base64"
    )}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`,
    data: fileData,
    // 60秒超时
    timeout: 60000,
    headers: {
      ...FAKE_HEADERS,
      Authorization: authorization,
    },
  });
  const { link } = checkResult(result);

  const isImage = [
    "image/jpeg",
    "image/jpg",
    "image/tiff",
    "image/png",
    "image/bmp",
    "image/heic",
    "image/heif",
  ].includes(mimeType);
  if (isImage) return link;

  // 存储文件
  result = await axios.post(
    "https://xinghuo.xfyun.cn/iflygpt-longcontext/chat/enhance/saveFile",
    {
      businessType: 0,
      chatId: convId,
      fileBusinessKey: util.uuid(),
      fileName: filename,
      fileSize: fileData.byteLength,
      fileUrl: link,
    },
    {
      // 60秒超时
      timeout: 60000,
      headers: {
        Clienttype: "1",
        "Lang-Code": "zh",
        ...FAKE_HEADERS,
        Cookie: generateCookie(ssoSessionId),
        "X-Requested-With": "XMLHttpRequest",
      },
    }
  );

  return null;
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { code, desc, message } = result.data;
  if (!_.isFinite(code)) return result.data;
  if (code == 0) return result.data.data;
  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[请求spark失败]: [${code}]${desc || message}`
  );
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (/<sid>$/.test(event.data)) {
          data.id = `${convId}:${event.data.replace(/<sid>$/, "").trim()}`;
          resolve(data);
        }
        else if (/^\[.+\]$/.test(event.data))
          data.choices[0].message.content += event.data;
        else if (!/^<.+>$/.test(event.data)) {
          // 解析文本
          const text = Buffer.from(event.data, "base64").toString();
          if (text.indexOf("allTool") != -1)
            return;
          if (text.indexOf("multi_image_url") != -1) {
            const urlPattern = /"(https?:\/\/\S+)"/g;
            let match;
            while ((match = urlPattern.exec(text)) !== null) {
              const url = match[1];
              data.choices[0].message.content += `![图像](${url})`;
            }
          }
          else
            data.choices[0].message.content += text;
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(
  model: string,
  convId: string,
  stream: any,
  endCallback?: Function
) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      const isErrorText = /^\[.+\]$/.test(event.data);
      if (/<sid>$/.test(event.data) || isErrorText) {
        const data = `data: ${JSON.stringify({
          id: `${convId}:${event.data.replace(/<sid>$/, "").trim()}`,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: isErrorText ? {
                content: event.data
              } : {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
      }
      else if (!/^<.+>$/.test(event.data)) {
        // 解析文本
        let text = Buffer.from(event.data, "base64").toString();
        if (text.indexOf("allTool") != -1)
          return;
        if (text.indexOf("multi_image_url") != -1) {
          let temp = '';
          const urlPattern = /"(https?:\/\/\S+)"/g;
          let match;
          while ((match = urlPattern.exec(text)) !== null) {
            const url = match[1];
            temp += `![图像](${url})`;
          }
          text = temp;
        }
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * 从流接收图像
 *
 * @param stream 消息流
 */
async function receiveImages(stream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const imageUrls = [];
    const parser = createParser((event) => {
      try {
        if (event.type !== "event" || /^<.+>$/.test(event.data)) return;
        // 解析文本
        const text = Buffer.from(event.data, "base64").toString();
        if (text.indexOf("multi_image_url") != -1) {
          const urlPattern = /"(https?:\/\/\S+)"/g;
          let match;
          while ((match = urlPattern.exec(text)) !== null) {
            const url = match[1];
            if (imageUrls.indexOf(url) == -1)
              imageUrls.push(url);
          }
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(imageUrls));
  });
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(ssoSessionId: string) {
  const result = await axios.get("https://xinghuo.xfyun.cn/iflygpt/userInfo", {
    headers: {
      Clienttype: "1",
      "Lang-Code": "zh",
      ...FAKE_HEADERS,
      Cookie: generateCookie(ssoSessionId),
      "X-Requested-With": "XMLHttpRequest",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  try {
    const { userInfo } = checkResult(result);
    return !!userInfo;
  } catch (err) {
    return false;
  }
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  generateImages,
  getTokenLiveStatus,
  tokenSplit,
};
