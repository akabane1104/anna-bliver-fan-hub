const tencentcloud = require('tencentcloud-sdk-nodejs');
const {
  isEmailVerificationEnabled,
  isRedemptionEmailEnabled,
  isMarshmallowEmailEnabled
} = require('./optionalFeatures');

const SesClient = tencentcloud.ses.v20201002.Client;

function createClient() {
  return new SesClient({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
    },
    region: 'ap-guangzhou',
    profile: {
      httpProfile: {
        endpoint: 'ses.tencentcloudapi.com',
      },
    },
  });
}

/**
 * 发送验证码邮件
 * @param {string} toEmail - 收件人邮箱
 * @param {string} name - 收件人名称
 * @param {string} code - 验证码
 * @returns {Promise}
 */
async function sendVerificationEmail(toEmail, name, code) {
  if (!isEmailVerificationEnabled()) {
    console.warn('[Email] Verification email skipped: Tencent SES verification is not fully configured');
    return { success: false, skipped: true };
  }

  // 发件人格式: "显示名称" <邮箱地址>
  const fromName = process.env.SES_FROM_NAME || '橙吱_sweety的钢板批发小店';
  const fromEmail = process.env.SES_FROM_EMAIL;
  const fromAddress = `"${fromName}" <${fromEmail}>`;

  const params = {
    FromEmailAddress: fromAddress,
    Destination: [toEmail],
    Template: {
      TemplateID: parseInt(process.env.SES_TEMPLATE_ID, 10),
      TemplateData: JSON.stringify({ name, code }),
    },
    Subject: '邮箱验证码',
  };

  try {
    const result = await createClient().SendEmail(params);
    console.log('Email sent successfully:', result);
    return { success: true, result };
  } catch (error) {
    console.error('Failed to send email:', error);
    throw error;
  }
}

/**
 * 发送积分礼物兑换提醒邮件给主播
 * @param {string} userName - 兑换用户名称
 * @param {string} prizeName - 兑换礼物名称
 * @returns {Promise<{success: boolean, skipped?: boolean, result?: object}>}
 */
async function sendRedemptionNotificationEmail(userName, prizeName) {
  const toEmail = process.env.SES_REDEMPTION_TO_EMAIL;
  const templateId = process.env.SES_REDEMPTION_TEMPLATE_ID;

  if (!isRedemptionEmailEnabled()) {
    console.warn('[Email] Redemption notification skipped: Tencent SES redemption notification is not fully configured');
    return { success: false, skipped: true };
  }

  const fromName = process.env.SES_FROM_NAME || '橙吱_sweety的钢板批发小店';
  const fromEmail = process.env.SES_FROM_EMAIL;
  const fromAddress = `"${fromName}" <${fromEmail}>`;

  const params = {
    FromEmailAddress: fromAddress,
    Destination: [toEmail],
    Template: {
      TemplateID: parseInt(templateId, 10),
      TemplateData: JSON.stringify({
        name: userName,
        prize: prizeName
      }),
    },
    Subject: '积分礼物兑换提醒',
  };

  try {
    const result = await createClient().SendEmail(params);
    console.log('Redemption notification email sent successfully:', result);
    return { success: true, result };
  } catch (error) {
    console.error('Failed to send redemption notification email:', error);
    throw error;
  }
}

/**
 * 发送棉花糖投递提醒邮件给主播
 * @param {object} payload
 * @param {string} payload.sender - 投递人名称
 * @param {string} payload.title - 棉花糖标题
 * @param {string} payload.content - 棉花糖内容
 * @returns {Promise<{success: boolean, skipped?: boolean, result?: object}>}
 */
async function sendMarshmallowNotificationEmail({ sender, title, content }) {
  const toEmail = process.env.SES_MARSHMALLOW_TO_EMAIL;
  const templateId = process.env.SES_MARSHMALLOW_TEMPLATE_ID;

  if (!isMarshmallowEmailEnabled()) {
    console.warn('[Email] Marshmallow notification skipped: Tencent SES marshmallow notification is not fully configured');
    return { success: false, skipped: true };
  }

  const fromName = process.env.SES_FROM_NAME || '橙吱_sweety的钢板批发小店';
  const fromEmail = process.env.SES_FROM_EMAIL;
  const fromAddress = `"${fromName}" <${fromEmail}>`;

  const params = {
    FromEmailAddress: fromAddress,
    Destination: [toEmail],
    Template: {
      TemplateID: parseInt(templateId, 10),
      TemplateData: JSON.stringify({
        sender,
        title,
        content
      }),
    },
    Subject: '棉花糖投递提醒',
  };

  try {
    const result = await createClient().SendEmail(params);
    console.log('Marshmallow notification email sent successfully:', result);
    return { success: true, result };
  } catch (error) {
    console.error('Failed to send marshmallow notification email:', error);
    throw error;
  }
}

module.exports = {
  sendVerificationEmail,
  sendRedemptionNotificationEmail,
  sendMarshmallowNotificationEmail,
};
